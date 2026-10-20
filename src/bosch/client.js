// -----------------------------------------------------------------------------
// One TLS connection with a Bosch panel over the "Mode 2" automation
// protocol, ported from bosch-alarm-mode2 0.4.11 (`panel.py`,
// `connection.py`, MIT, see THIRD_PARTY_NOTICES.md): "what are you", the
// login by family (automation code, user or installer code), the serial and
// firmware, the configured areas, points and outputs with their names, their
// status, the alarm memory, the faults, the subscription (or the polling of
// the panels without one), the arming, disarming and output commands.
//
// Changed from bosch-alarm-mode2:
// - one request in flight at a time on every panel (the reference allows
//   100 on B and G series); answers are matched in order, so a request
//   without an answer, an unexpected answer or an answer nobody asked for
//   resets the connection instead of guessing (the reference checks for a
//   "command skew" every minute);
// - a code refused at login (AUTHENTICATE "not authorized", a NACK of the
//   login) never reconnects by itself: the client parks and says so (a panel
//   may count wrong codes, "user code tamper"); "max connections" waits;
// - reconnection with growing waits (10 s to 5 min), never two connections
//   at once, at least 5 s between two; a keep-alive after 60 s without a
//   request; a watchdog;
// - the event log is not followed (no history in this version): the faults
//   are read every minute instead; the doors are not followed;
// - a command is never written after its deadline, its option is read
//   again right before the write; one that may have reached the panel is
//   reported `sent: true`, never "not sent";
// - the codes are never logged: requests are logged by a label.
//
// Events: 'up' { model }, 'down' { reason, retryIn, busy, refused, problem,
// parked, wasUp }, 'change'.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { LIMITS, TIMINGS } from '../constants.js';
import {
  FrameReader,
  decodeAnswer,
  decodeIdSet,
  encodeAreaMask,
  encodeAutomationCode,
  encodeIds16,
  encodeRequest,
  encodeUserCode,
  parseAlarmDetail,
  parseNameOne,
  parseNamesMany,
  parseStatusTriplets,
  parseStatusUpdates,
} from './frame.js';
import {
  ARM_TYPE,
  AUTH_RESULT,
  CMD,
  PRIORITIES,
  REQUEST_MAX,
  credentialsFor,
  errorName,
  parseWhatAreYou,
} from './protocol.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The panel's certificate is self-signed: TLS keeps the exchanges private
 * from a passive listener, without proving the panel's identity (as the
 * reference: no certificate check).
 */
const defaultConnect = ({ host, port }) =>
  tlsConnect({
    host,
    port,
    rejectUnauthorized: false,
    ciphers: 'DEFAULT',
    ...(isIP(host) ? {} : { servername: host }),
  });

/**
 * kind: `offline` (nothing sent), `late` (not written in time, nothing sent),
 * `withdrawn` (its option was switched off before the write, nothing sent),
 * `timeout` (sent, no answer), `lost` (the connection ended while it waited),
 * `nack` (the panel answered a refusal, with its error code), `unexpected`
 * (an answer that cannot be read). `sent` tells whether the request may
 * have reached the panel.
 */
export class BoschError extends Error {
  constructor(message, kind, { sent = false, code } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

const hex = (n) => `0x${Number(n).toString(16).padStart(2, '0')}`;

export const emptyModel = () => ({
  panel: undefined,
  areas: new Map(),
  points: new Map(),
  outputs: new Map(),
  /** priority -> [{ area, point }] of the alarm memory. */
  alarms: new Map(),
  faults: undefined,
});

/** A NACK becomes undefined (a command the panel does not have); anything else is thrown. */
const optional = (promise) =>
  promise.catch((err) => {
    if (err instanceof BoschError && err.kind === 'nack') return undefined;
    throw err;
  });

export class BoschClient extends EventEmitter {
  constructor({
    connect = defaultConnect,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 7700, automationCode: '', userCode: '' };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.closedAt = undefined;
    this.queue = [];
    this.inflight = undefined;
    this.model = emptyModel();
    this.caps = {};
    /** kind -> { key, names }: the names of the last session, read again only when the list changes. */
    this.namesCache = new Map();
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    this.ticker = undefined;
    /** Reads running in the background (polling, refreshes), by name: one of each at a time. */
    this.background = new Set();
  }

  configure({ host, port, automationCode = '', userCode = '' }) {
    this.options = { host, port, automationCode, userCode };
  }

  get connected() {
    return this.ready;
  }

  /** A socket is open (connecting, logging in or up). */
  get busy() {
    return Boolean(this.socket);
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.openSoon(0);
  }

  /** Opens after `wait`, never sooner than sessionGap after the last connection closed. */
  openSoon(wait) {
    const gap = this.closedAt === undefined ? 0 : this.closedAt + TIMINGS.sessionGap - this.now();
    const delay = Math.max(wait, gap, 0);
    if (delay === 0) {
      this.open();
      return;
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running && !this.socket) this.open();
    }, delay);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close();
  }

  clearTimers() {
    if (this.connectTimer) this.timers.clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    if (this.ticker) this.timers.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Ends the socket; every waiting request fails (sent or not, as it was). */
  close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.background.clear();
    const inflight = this.inflight;
    this.inflight = undefined;
    if (inflight) {
      this.timers.clearTimeout(inflight.timer);
      inflight.reject(
        new BoschError('The connection to the panel ended', 'lost', { sent: inflight.written }),
      );
    }
    for (const entry of this.queue.splice(0)) {
      this.timers.clearTimeout(entry.deadline);
      entry.reject(new BoschError('Not connected to the panel', 'offline'));
    }
    if (!socket) return;
    this.closedAt = this.now();
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port } = this.options;
    this.model = emptyModel();
    this.caps = {};
    this.reader = new FrameReader({
      onAnswer: (payload) => {
        if (generation === this.generation) this.answer(generation, payload);
      },
      onStatus: (payload) => {
        if (generation === this.generation) this.statusFrame(generation, payload);
      },
      onError: (why) => this.lost(generation, `unreadable data from the panel (${why})`),
    });
    this.logger.debug(`Connecting to the Bosch panel at ${host}:${port}`);
    let socket;
    try {
      socket = this.connectFn({ host, port });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('secureConnect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.lastReceived = this.now();
      this.lastSent = this.now();
      this.ticker = this.timers.setInterval(() => this.tick(generation), 1_000);
      this.run(generation);
    });
    socket.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.lastReceived = this.now();
      this.reader.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by the panel'));
  }

  /** The session ended: reconnect later, unless stopped. `retry`: the least wait. */
  lost(generation, reason, { retry = 0, busy = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    this.close();
    if (!this.running) return;
    this.failures = wasUp ? 1 : this.failures + 1;
    const retryIn = Math.max(
      retry,
      TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)],
    );
    this.openSoon(retryIn);
    this.emit('down', { reason, retryIn, busy, wasUp });
  }

  /**
   * The session ended and must not come back by itself (a refused code, a
   * code missing for this panel): only start() opens again.
   */
  park(generation, info) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    this.running = false;
    this.close();
    this.emit('down', { ...info, parked: true, wasUp });
  }

  /** Identify, log in, read everything, subscribe; 'up' once done. */
  async run(generation) {
    try {
      const info = await this.identify();
      if (generation !== this.generation) return;
      if (!info.model) {
        this.lost(generation, `unsupported panel model ${hex(info.code)}`, {
          retry: TIMINGS.unsupportedRetry,
        });
        return;
      }
      this.model.panel = {
        code: info.code,
        model: info.model,
        family: info.family,
        protocol: info.protocol,
      };
      this.caps = info.caps;
      const credentials = credentialsFor(info.family, this.options);
      if (credentials.problem) {
        this.park(generation, { problem: credentials.problem, reason: credentials.problem });
        return;
      }
      const login = await this.login(credentials);
      if (generation !== this.generation) return;
      if (login === 'busy') {
        this.lost(generation, 'the panel has no free automation connection', {
          retry: TIMINGS.busyRetry,
          busy: true,
        });
        return;
      }
      if (login === 'refused') {
        this.park(generation, { refused: true, reason: 'the panel refused the code' });
        return;
      }
      await this.extendedInfo();
      await this.loadEntities(generation);
      if (generation !== this.generation) return;
      await this.loadStatus({ internal: true });
      if (this.caps.subscription) await this.subscribe();
      if (generation !== this.generation) return;
      const now = this.now();
      this.lastPoll = now;
      this.lastFaults = now;
      this.lastResync = now;
      this.lastRepair = 0;
      this.ready = true;
      this.failures = 0;
      this.emit('up', { model: this.model });
    } catch (err) {
      if (generation !== this.generation) return;
      this.lost(generation, err.message);
    }
  }

  /** WHAT_ARE_YOU, CF03 form first, then the older one (as the reference). */
  async identify() {
    const label = 'what are you';
    try {
      return parseWhatAreYou(await this.request(CMD.WHAT_ARE_YOU, [3], { internal: true, label }));
    } catch (err) {
      if (!(err instanceof BoschError && err.kind === 'nack')) throw err;
      return parseWhatAreYou(await this.request(CMD.WHAT_ARE_YOU, [], { internal: true, label }));
    }
  }

  /**
   * The login of the family: 'ok', 'busy' (max connections) or 'refused'.
   * A refusal of a code is never retried here. The codes go in the frames
   * only, never in a log or an error.
   */
  async login(credentials) {
    if (credentials.automation) {
      let result;
      try {
        result = await this.request(
          CMD.AUTHENTICATE,
          encodeAutomationCode(credentials.userType, credentials.automation),
          { internal: true, label: 'log in (automation code)' },
        );
      } catch (err) {
        if (err instanceof BoschError && err.kind === 'nack') return 'refused';
        throw err;
      }
      if (result[0] === AUTH_RESULT.MAX_CONNECTIONS) return 'busy';
      if (result[0] !== AUTH_RESULT.AUTHORIZED) return 'refused';
    }
    if (credentials.user) {
      try {
        await this.request(CMD.LOGIN_REMOTE_USER, encodeUserCode(credentials.user), {
          internal: true,
          label: 'log in (user code)',
        });
      } catch (err) {
        if (err instanceof BoschError && err.kind === 'nack') return 'refused';
        throw err;
      }
    }
    return 'ok';
  }

  /** Serial number and firmware, when the panel has them. */
  async extendedInfo() {
    if (this.caps.serial) {
      const data = await optional(
        this.request(CMD.PRODUCT_SERIAL, [0, 0], { internal: true, label: 'serial number' }),
      );
      if (data?.length >= 6) this.model.panel.serial = String(data.readUIntBE(0, 6));
    }
    if (this.caps.status) {
      const data = await optional(
        this.request(CMD.REQUEST_PANEL_SYSTEM_STATUS, [], { internal: true, label: 'status' }),
      );
      if (data?.length >= 2) this.model.panel.firmware = `v${data[0]}.${data[1]}`;
    }
  }

  /** The configured areas, points and outputs, and their names. */
  async loadEntities(generation) {
    const kinds = [
      [
        'areas',
        CMD.REQUEST_CONFIGURED_AREAS,
        CMD.AREA_TEXT,
        this.caps.areaText,
        2,
        LIMITS.maxAreas,
      ],
      [
        'points',
        CMD.REQUEST_CONFIGURED_POINTS,
        CMD.POINT_TEXT,
        this.caps.pointText,
        2,
        LIMITS.maxPoints,
      ],
      [
        'outputs',
        CMD.REQUEST_CONFIGURED_OUTPUTS,
        CMD.OUTPUT_TEXT,
        this.caps.outputText,
        1,
        LIMITS.maxOutputs,
      ],
    ];
    for (const [kind, configCmd, textCmd, format, idSize, max] of kinds) {
      if (generation !== this.generation) return;
      const data = await optional(
        this.request(configCmd, [], { internal: true, label: `configured ${kind}` }),
      );
      const ids = data ? decodeIdSet(data, max) : [];
      const names = await this.names(kind, textCmd, format, idSize, ids);
      this.model[kind] = new Map(ids.map((id) => [id, { name: names.get(id) ?? '' }]));
    }
  }

  /** Names read once per list (CF03 pages, CF01 one by one, or none). */
  async names(kind, cmd, format, idSize, ids) {
    const key = JSON.stringify([this.options.host, this.options.port, format, ids]);
    const cached = this.namesCache.get(kind);
    if (cached?.key === key) return cached.names;
    const names = new Map();
    const label = `${kind} names`;
    if (format === 3) {
      const wanted = new Set(ids);
      let from = 0;
      // Every page brings at least one name: never more pages than names.
      for (let page = 0; page < ids.length + 2; page += 1) {
        const request = Buffer.alloc(4);
        request.writeUInt16BE(from, 0);
        request[2] = 0x00; // primary language
        request[3] = 0x01; // return many
        const data = await optional(this.request(cmd, request, { internal: true, label }));
        if (!data || data.length === 0) break;
        let last = from;
        for (const { id, name } of parseNamesMany(data)) {
          if (wanted.has(id) && name) names.set(id, name);
          last = Math.max(last, id);
        }
        // No progress: a broken answer, never a loop.
        if (last <= from) break;
        from = last;
      }
    } else if (format === 1) {
      for (const id of ids) {
        if (idSize === 1 && id > 0xff) continue;
        const request = idSize === 1 ? [id, 0x00] : [id >> 8, id & 0xff, 0x00];
        const data = await optional(this.request(cmd, request, { internal: true, label }));
        const name = data ? parseNameOne(data) : '';
        if (name) names.set(id, name);
      }
    }
    this.namesCache.set(kind, { key, names });
    return names;
  }

  /** Every status: areas, points, outputs, alarm memory, faults. */
  async loadStatus(options = {}) {
    await this.loadEntityStatus(CMD.AREA_STATUS, this.model.areas, options);
    await this.loadEntityStatus(CMD.POINT_STATUS, this.model.points, options);
    await this.loadOutputs(options);
    await this.loadAlarms(options);
    await this.loadFaults(options);
  }

  async loadEntityStatus(cmd, entities, options = {}) {
    const ids = [...entities.keys()];
    const size = REQUEST_MAX[cmd];
    for (let i = 0; i < ids.length; i += size) {
      const data = await this.request(cmd, encodeIds16(ids.slice(i, i + size)), {
        label: `status ${hex(cmd)}`,
        ...options,
      });
      for (const [id, status] of parseStatusTriplets(data)) {
        const entity = entities.get(id);
        if (entity) entity.status = status;
      }
    }
  }

  /** The active outputs (an id set), read now. */
  async loadOutputs(options = {}) {
    if (this.model.outputs.size === 0) return new Set();
    const data = await this.request(CMD.OUTPUT_STATUS, [], { label: 'outputs status', ...options });
    const active = new Set(decodeIdSet(data, LIMITS.maxOutputs));
    for (const [id, output] of this.model.outputs) output.active = active.has(id);
    return active;
  }

  async loadAlarms(options = {}) {
    const format = this.caps.alarmSummary;
    if (!format) return;
    const data = await this.request(CMD.ALARM_MEMORY_SUMMARY, format === 2 ? [0x02] : [], {
      label: 'alarm memory',
      ...options,
    });
    for (const priority of PRIORITIES) {
      const at = (priority - 1) * 2;
      const count = data.length >= at + 2 ? data.readUInt16BE(at) : 0;
      if (count > 0) await this.loadAlarmDetail(priority, options);
      else this.model.alarms.set(priority, []);
    }
  }

  /** The areas (and points) of one priority; 0xFFFF asks for the next page, bounded. */
  async loadAlarmDetail(priority, options = {}) {
    const records = [];
    let last;
    for (let page = 0; page < LIMITS.maxAlarmPages; page += 1) {
      const request = [priority];
      if (last) request.push(last.area >> 8, last.area & 0xff, last.point >> 8, last.point & 0xff);
      const data = await this.request(CMD.ALARM_MEMORY_DETAIL, request, {
        label: 'alarm memory detail',
        ...options,
      });
      const before = last;
      let more = false;
      for (const record of parseAlarmDetail(data)) {
        if (record.point === 0xffff) {
          more = true;
          break;
        }
        records.push(record);
        last = record;
      }
      if (!more || !last || last === before) break;
    }
    this.model.alarms.set(
      priority,
      records.filter((r) => this.model.areas.has(r.area)),
    );
  }

  async loadFaults(options = {}) {
    if (!this.caps.status) return;
    const data = await this.request(CMD.REQUEST_PANEL_SYSTEM_STATUS, [], {
      label: 'faults',
      ...options,
    });
    if (data.length >= 7) this.model.faults = data.readUInt16BE(5);
  }

  /** Subscribe to the updates (not the event log, not the doors); a NACK falls back to polling. */
  async subscribe() {
    const format = this.caps.subscription;
    const on = 0x01;
    const off = 0x00;
    // format, heartbeat, alarm memory, event log, config change, area on/off,
    // area ready, outputs, points, doors, walk test (+ panel status, wireless learn).
    const data = [format, on, on, off, off, on, on, on, on, off, off];
    if (format === 2) data.push(on, off);
    const answer = await optional(
      this.request(CMD.SET_SUBSCRIPTION, data, { internal: true, label: 'subscribe' }),
    );
    if (answer === undefined) {
      this.logger.info('Bosch: the panel refused the subscription, polling instead');
      this.caps.subscription = 0;
    }
  }

  tick(generation) {
    if (generation !== this.generation || !this.socket) return;
    const now = this.now();
    if (now - this.lastReceived > TIMINGS.watchdog) {
      this.logger.warn('Bosch: nothing received for too long, reconnecting');
      this.lost(generation, 'nothing received from the panel');
      return;
    }
    if (!this.ready || this.inflight || this.queue.length > 0) return;
    if (!this.caps.subscription && now - this.lastPoll >= TIMINGS.poll) {
      this.lastPoll = now;
      this.refresh('status', () => this.loadStatus());
    } else if (now - this.lastResync >= TIMINGS.resync) {
      this.lastResync = now;
      this.refresh('status', () => this.loadStatus());
    } else if (now - this.lastFaults >= TIMINGS.faultPoll) {
      this.lastFaults = now;
      this.refresh('faults', () => this.loadFaults());
    } else if (now - this.lastSent >= TIMINGS.keepAlive) {
      this.refresh('keep-alive', () => this.keepAlive(generation));
    }
  }

  /** WHAT_ARE_YOU again: the same model proves the answers are still in step. */
  async keepAlive(generation) {
    const data = await this.request(CMD.WHAT_ARE_YOU, [], { label: 'keep-alive' });
    if (data[0] !== this.model.panel?.code) this.lost(generation, 'answers out of step');
  }

  /** A read in the background, one of each name at a time; 'change' after it. */
  refresh(name, fn) {
    if (!this.ready || this.background.has(name)) return;
    this.background.add(name);
    const generation = this.generation;
    fn()
      .then(() => {
        if (generation === this.generation) this.emit('change');
      })
      .catch((err) => this.logger.debug(`Bosch: ${name} read failed: ${err.message}`))
      .finally(() => {
        if (generation === this.generation) this.background.delete(name);
      });
  }

  // --- Frames -----------------------------------------------------------------

  /** Status updates of the subscription. */
  statusFrame(generation, payload) {
    const { updates, stopped } = parseStatusUpdates(payload);
    const { areas, points, alarms } = this.model;
    for (const update of updates) {
      if (update.type === 'area') {
        const area = areas.get(update.id);
        if (area) area.status = update.status;
      } else if (update.type === 'ready') {
        const area = areas.get(update.id);
        if (area) {
          area.ready = update.ready;
          area.notReady = update.faults;
        }
      } else if (update.type === 'point') {
        const point = points.get(update.id);
        if (point) point.status = update.status;
      } else if (update.type === 'faults') {
        this.model.faults = update.faults;
      } else if (update.type === 'output') {
        // The ids of these updates do not match on Solution panels (the
        // reference reads the outputs again instead).
        this.refresh('outputs', () => this.loadOutputs());
      } else if (update.type === 'alarms') {
        if (update.count === 0) alarms.set(update.priority, []);
        else this.refresh(`alarms-${update.priority}`, () => this.loadAlarmDetail(update.priority));
      }
    }
    if (stopped) {
      this.logger.debug(`Bosch: status frame not fully read (${stopped})`);
      // Read everything again, at most once every 10 s.
      const now = this.now();
      if (now - (this.lastRepair ?? 0) >= 10_000) {
        this.lastRepair = now;
        this.refresh('status', () => this.loadStatus());
      }
    }
    if (this.ready && generation === this.generation) this.emit('change');
  }

  /** An answer for the request in flight; in order, or the session is reset. */
  answer(generation, payload) {
    const entry = this.inflight;
    if (!entry) {
      this.lost(generation, 'an answer nobody asked for');
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.inflight = undefined;
    const answer = decodeAnswer(payload);
    if (answer.kind === 'unexpected') {
      entry.reject(
        new BoschError(`Unexpected answer to ${entry.label}`, 'unexpected', { sent: true }),
      );
      this.lost(generation, 'an unexpected answer from the panel');
      return;
    }
    if (answer.kind === 'nack') {
      entry.reject(
        new BoschError(`The panel refused ${entry.label}: ${errorName(answer.code)}`, 'nack', {
          sent: true,
          code: answer.code,
        }),
      );
    } else {
      entry.resolve(answer.data);
    }
    this.pump();
  }

  // --- Requests ---------------------------------------------------------------

  /**
   * Queues a request; resolves with the answer data (empty for a plain ack).
   * `label` replaces the command in the logs. `sendBy` (a time): never
   * written after it, rejected as not sent instead. `answerBy` (a time): the
   * answer is awaited up to it. `check()`: read right before the write,
   * false withdraws the request (nothing sent).
   */
  request(
    cmd,
    data = [],
    {
      timeout = TIMINGS.requestTimeout,
      label = hex(cmd),
      internal = false,
      sendBy,
      answerBy,
      check,
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (!this.socket || (!internal && !this.ready)) {
        reject(new BoschError('Not connected to the panel', 'offline'));
        return;
      }
      const entry = { cmd, data, label, timeout, answerBy, check, resolve, reject, written: false };
      if (sendBy !== undefined) {
        const wait = sendBy - this.now();
        if (wait <= 0) {
          reject(new BoschError(`${label} not sent in time`, 'late'));
          return;
        }
        // Withdrawn at its deadline if the line is still busy: never written late.
        entry.deadline = this.timers.setTimeout(() => {
          const at = this.queue.indexOf(entry);
          if (at < 0) return;
          this.queue.splice(at, 1);
          reject(new BoschError(`${label} not sent in time`, 'late'));
        }, wait);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  pump() {
    if (this.inflight || this.queue.length === 0 || !this.socket) return;
    const entry = this.queue.shift();
    this.timers.clearTimeout(entry.deadline);
    const generation = this.generation;
    // Last look before the socket: a command whose option was switched off
    // while it waited is withdrawn, never written.
    if (entry.check && !entry.check()) {
      entry.reject(new BoschError(`${entry.label} withdrawn: not allowed any more`, 'withdrawn'));
      this.pump();
      return;
    }
    let bytes;
    try {
      bytes = encodeRequest(entry.cmd, entry.data);
    } catch (err) {
      entry.reject(new BoschError(err.message, 'offline'));
      this.pump();
      return;
    }
    this.inflight = entry;
    this.logger.debug(`Bosch <- ${entry.label}`);
    entry.written = true;
    this.lastSent = this.now();
    const wait =
      entry.answerBy === undefined ? entry.timeout : Math.max(200, entry.answerBy - this.now());
    try {
      this.socket.write(bytes);
    } catch (err) {
      this.lost(generation, err.message);
      return;
    }
    if (this.overflowing(generation)) return;
    entry.timer = this.timers.setTimeout(() => {
      if (this.inflight !== entry) return;
      this.inflight = undefined;
      entry.reject(new BoschError(`No answer to ${entry.label}`, 'timeout', { sent: true }));
      // A late answer would be taken for the next request's: start again.
      this.lost(generation, `no answer to ${entry.label}`);
    }, wait);
  }

  /** A peer reading slower than we write: cut. */
  overflowing(generation) {
    if ((this.socket?.writableLength ?? 0) <= LIMITS.maxPendingWrite) return false;
    this.logger.warn('Bosch: too much data waiting to be written, connection cut');
    this.lost(generation, 'write buffer full');
    return true;
  }

  // --- Reads and commands ---------------------------------------------------

  /** The status byte of one area, read now (the model follows). */
  async readArea(area, options = {}) {
    const data = await this.request(CMD.AREA_STATUS, encodeIds16([area]), {
      label: `read area ${area}`,
      ...options,
    });
    const found = parseStatusTriplets(data).find(([id]) => id === area);
    if (!found) throw new BoschError(`No status of area ${area}`, 'unexpected', { sent: true });
    const entry = this.model.areas.get(area);
    if (entry) entry.status = found[1];
    this.emit('change');
    return found[1];
  }

  /** The active outputs, read now (the model follows). */
  async readOutputs(options = {}) {
    const active = await this.loadOutputs(options);
    this.emit('change');
    return active;
  }

  /** Arming type of protocol.armType(); the area mask holds only `area`. */
  arm(area, type, options = {}) {
    return this.request(CMD.AREA_ARM, [type, ...encodeAreaMask(area)], {
      label: `arm (type ${hex(type)}), area ${area}`,
      ...options,
    });
  }

  disarm(area, options = {}) {
    return this.request(CMD.AREA_ARM, [ARM_TYPE.DISARM, ...encodeAreaMask(area)], {
      label: `disarm, area ${area}`,
      ...options,
    });
  }

  setOutput(output, on, options = {}) {
    return this.request(CMD.SET_OUTPUT_STATE, [output, on ? 0x01 : 0x00], {
      label: `output ${output} ${on ? 'on' : 'off'}`,
      ...options,
    });
  }
}
