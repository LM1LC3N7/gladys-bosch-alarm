// -----------------------------------------------------------------------------
// The integration: one TLS connection with the Bosch panel (Mode 2,
// src/bosch/client.js), the areas, points and outputs it reports, the Gladys
// devices and states (src/devices.js), the scene events, the commands.
// index.js only wires the SDK handlers to it.
//
// Safety:
// - arming is never blocked by an option; disarming and the outputs are off
//   unless the configuration allows them (two options); going from armed
//   away to armed stay lowers the protection: it needs the disarm option;
// - a command decides on the state read from the panel right before it,
//   never on the state in memory; one command at a time; its option is read
//   again right before the write; an arming withdraws a disarm of the same
//   area still waiting its turn;
// - a command is sent within 3.5 s of the request or not at all (Gladys
//   waits 5 s); one that may have reached the panel is never reported "not
//   sent", but "sent, not confirmed", and the state is read again;
// - a code refused by the panel at login is never sent again by itself (a
//   panel may count wrong codes): the connection stops, across restarts,
//   until a code changes or "Allow a new try of the code" is clicked;
// - every command, sent or refused, is logged; the codes never are.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { codesKey, normalizeConfig, placeKey, sessionKey } from './config.js';
import { ARM_MODES, BUTTON_PUSH, LIMITS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { areaStatus, buildDevices, buildStates, parseFeatureId } from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { BoschClient, BoschError, emptyModel } from './bosch/client.js';
import { NACK, areaMode, armType, errorName } from './bosch/protocol.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent to the panel. */
export class Refused extends Error {}

/** Option-guarded command -> [config flag, refusal message, log name]. Arming has none. */
const OPTIONS = {
  disarm: ['allowDisarm', T.disarmRefused, 'Disarm'],
  lower: ['allowDisarm', T.lowerRefused, 'Arm stay from away'],
  output: ['allowOutputs', T.outputsRefused, 'Output'],
};

/** The mode an exit delay leads to (0x07 all on, 0x08 part on, 0x0D away). */
const ARMING_TARGET = new Map([
  [0x07, 'armed_away'],
  [0x08, 'armed_stay'],
  [0x0d, 'armed_away'],
]);

const settled = (mode) => mode !== 'arming' && mode !== 'pending';

export class BoschApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'bosch-alarm' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    // The updates of one change may come in several frames: published once
    // they stopped for settleMs.
    settleMs = 250,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.settleMs = settleMs;
    this.client = client ?? new BoschClient({ connect, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.raw = {};
    this.key = undefined;
    this.codes = undefined;
    this.model = emptyModel();
    this.online = false;
    this.memory = undefined;
    /** area -> { mode, until }: what the last Gladys command asked. */
    this.commanded = new Map();
    /** area -> { mode (last settled), alarm, fire } at the last flush. */
    this.seen = new Map();
    this.readBacks = new Set();
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.flushTimer = undefined;
    this.modelPlace = undefined;
    /** Commands waiting their turn (not started yet), arms first; the one being handled. */
    this.waiting = [];
    this.current = undefined;
    this.starting = Promise.resolve();
    /** When the first change of a burst came: its publication waits at most 4 x settleMs. */
    this.changeSince = undefined;
    /** Whether the last persisted stop reached /data. */
    this.stopSaved = true;
    this.client.on('up', ({ model }) => {
      this.model = model;
      this.online = true;
      this.guard(() => this.onUp());
    });
    this.client.on('down', (info) => {
      const wasOnline = this.online;
      this.online = false;
      // At once, before anything queued behind a slow Gladys: no start may
      // send a refused (or doubtful) code again meanwhile.
      if (info.refused) this.markCodeStop(info);
      this.guard(() => this.onDown(info, wasOnline));
    });
    this.client.on('change', () => this.noteChange());
  }

  /** Client events run one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Bosch event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  /** Persists the memory; false (logged) when /data refused it. */
  async saveMemory() {
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (placeKey(next) !== this.modelPlace) {
      // Another panel, maybe: what we knew no longer holds.
      this.model = emptyModel();
      this.seen.clear();
      this.modelPlace = placeKey(next);
    }
    this.config = next;
    this.raw = raw;
    this.key = sessionKey(next);
    this.codes = codesKey(next);
    this.online = false;
    if (next.kindErrors.length > 0) {
      this.logger.warn(`Point kinds not understood: ${next.kindErrors.join(', ')}`);
    }
    await this.loadMemory();
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    await this.startClient();
  }

  /**
   * Starts the client, unless a code was refused: checked again right
   * before client.start() (a stop may have come while the status was sent).
   * `retryCode`: the user's click for one new try.
   */
  async startClient({ retryCode = false } = {}) {
    if (!this.codeStopped()) await this.setStatus(false, T.connecting);
    if (this.codeStopped()) {
      this.logger.warn('Bosch: the panel refused the code before: not connecting');
      await this.setStatus(false, this.stopMessage());
      return false;
    }
    this.client.configure({
      host: this.config.host,
      port: this.config.port,
      automationCode: this.config.automationCode,
      userCode: this.config.userCode,
    });
    if (!this.client.start({ retryCode })) {
      await this.setStatus(false, T.codeStopped);
      return false;
    }
    if (!this.sweeper) this.startSweeper();
    return true;
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(() => this.guard(() => this.sweep()), TIMINGS.sweep);
  }

  /**
   * Stops the connection. `final` only when the container stops: a restart
   * (new address) keeps the alarm_triggered retries running.
   */
  stop({ final = false } = {}) {
    this.client.stop();
    this.online = false;
    this.publisher.stop({ final });
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.changeSince = undefined;
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    const config = this.config;
    if (!config.host) return T.noHost;
    if (config.automationCodeInvalid) return T.badAutomationCode;
    if (config.userCodeInvalid) return T.badUserCode;
    if (!config.automationCode && !config.userCode) return T.noCode;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /**
   * A new address, port or code reconnects (a new code also lifts the stop
   * on a refused one); the rest applies at once.
   */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    // First of all: an option switched off applies to the commands at once.
    this.config = next;
    if (codesKey(next) !== this.codes) {
      this.codes = codesKey(next);
      await this.liftCodeStop();
    }
    if (sessionKey(next) !== this.key) return this.start(raw);
    this.raw = raw;
    await this.publishDevices();
    await this.publishStates();
    if (this.online) await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async liftCodeStop() {
    const memory = await this.loadMemory();
    if (!memory.codeStop) return;
    memory.codeStop = null;
    this.stopSaved = true;
    await this.saveMemory();
    this.logger.info('Bosch: the stop on the refused code is lifted');
  }

  /** The stop belongs to the integration (its codes), whatever the address. */
  codeStopped() {
    return Boolean(this.memory?.codeStop);
  }

  /**
   * The panel refused a code at login, or never answered it clearly: the
   * stop is set in memory at once (synchronously) and written to /data.
   */
  markCodeStop({ doubtful = false } = {}) {
    if (!this.memory) this.memory = normalizeMemory(null);
    const already = Boolean(this.memory.codeStop);
    this.memory.codeStop = { at: this.now(), doubtful: Boolean(doubtful) };
    if (!already) {
      this.logger.error(
        doubtful
          ? 'Bosch: the panel never answered the login clearly: connection stopped'
          : 'Bosch: the panel refused the code at login: connection stopped',
      );
    }
    this.stopSaving = this.saveMemory().then((saved) => {
      this.stopSaved = saved;
      return saved;
    });
  }

  /** The status of a stop on a code (refused or doubtful; not saved to /data). */
  stopMessage() {
    const stop = this.memory?.codeStop;
    const base = stop?.doubtful ? T.codeDoubtful : T.codeStopped;
    if (this.stopSaved) return base;
    return { en: base.en + T.stopNotSaved.en, fr: base.fr + T.stopNotSaved.fr };
  }

  /** Gladys side of a stop on a code. */
  async stopOnCode(info = {}) {
    if (!this.codeStopped()) this.markCodeStop(info);
    await this.stopSaving;
    await this.setStatus(false, this.stopMessage());
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  areasSummary() {
    return [...this.model.areas.keys()].map((area) => ({
      area,
      mode: areaStatus(this.model, area).mode,
    }));
  }

  connectedMessage() {
    return fill(
      T.connected,
      this.model.panel?.model ?? 'Bosch',
      this.areasSummary(),
      this.model.points.size,
      this.model.outputs.size,
    );
  }

  // --- Client events ---------------------------------------------------------

  /** Gladys side of a new session: devices, states, status, transports, events. */
  async onUp() {
    await this.publishDevices();
    await this.flushChanges();
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
  }

  /** Gladys side of a session lost (the app went offline when it was emitted). */
  async onDown({ reason, retryIn, busy, refused, doubtful, problem }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (refused) {
      await this.stopOnCode({ doubtful });
    } else if (problem && T[problem]) {
      this.logger.warn(`Bosch: ${problem}: connection stopped until the configuration changes`);
      await this.setStatus(false, T[problem]);
    } else if (busy) {
      this.logger.warn(`Bosch: no free automation connection; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.busy, seconds));
    } else {
      this.logger.warn(`Bosch: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    if (wasOnline || this.lastTransport !== undefined) {
      await this.publishStates();
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
    }
  }

  /**
   * Something changed: published once the updates stopped for settleMs, at
   * most 4 x settleMs after the first one (a flapping point never holds
   * back the states and the alarm events).
   */
  noteChange() {
    if (!this.online) return;
    const now = this.now();
    if (this.changeSince === undefined) this.changeSince = now;
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    const wait = Math.min(this.settleMs, this.changeSince + this.settleMs * 4 - now);
    this.flushTimer = this.timers.setTimeout(
      () => {
        this.flushTimer = undefined;
        this.changeSince = undefined;
        this.guard(() => this.flushChanges());
      },
      Math.max(0, wait),
    );
  }

  async flushChanges() {
    const events = [];
    for (const n of this.model.areas.keys()) {
      const status = areaStatus(this.model, n);
      if (!status.known) continue;
      const before = this.seen.get(n);
      events.push(...this.transitions(n, before, status));
      this.seen.set(n, {
        // Only a settled mode is remembered: an exit or entry delay fires nothing by itself.
        mode: settled(status.mode) ? status.mode : before?.mode,
        alarm: status.alarm,
        fire: status.fire,
      });
    }
    await this.publishStates();
    for (const event of events) await this.effect(event);
    if (this.online) await this.setStatus(true, this.connectedMessage());
  }

  /** Nothing for the first status seen of an area after a start. */
  transitions(n, before, after) {
    if (!before) return [];
    const events = [];
    if (settled(after.mode) && before.mode !== after.mode) {
      if (after.mode === 'disarmed') {
        // An exit delay cancelled is not a disarm.
        if (before.mode === 'armed_away' || before.mode === 'armed_stay') {
          events.push({ type: 'disarmed', area: n });
        }
      } else {
        events.push({ type: 'armed', area: n, mode: after.mode });
      }
    }
    if ((!before.alarm && after.alarm) || (!before.fire && after.fire)) {
      events.push({
        type: 'alarm',
        area: n,
        fire: Boolean(after.fire && !before.fire),
        point: after.point,
      });
    }
    return events;
  }

  /** Whether a transition answers a Gladys command; the entry is used once. */
  byGladys(area, mode) {
    const asked = this.commanded.get(area);
    const match = Boolean(asked && asked.mode === mode && this.now() < asked.until);
    if (match) this.commanded.delete(area);
    return match;
  }

  async effect(event) {
    const area = String(event.area);
    if (event.type === 'armed') {
      const byGladys = this.byGladys(event.area, event.mode);
      this.logger.info(
        `Panel: area ${area} ARMED ${event.mode} (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ARMED, {
        area,
        mode: event.mode,
        by_gladys: byGladys,
      });
    } else if (event.type === 'disarmed') {
      const byGladys = this.byGladys(event.area, 'disarmed');
      this.logger.info(
        `Panel: area ${area} DISARMED (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.DISARMED, { area, by_gladys: byGladys });
    } else if (event.type === 'alarm') {
      this.logger.warn(
        `Panel: ${event.fire ? 'FIRE ' : ''}ALARM area ${area}${event.point ? ` point ${event.point}` : ''}`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ALARM_TRIGGERED, {
        area,
        point: event.point,
        fire: event.fire,
      });
    }
  }

  /** Heartbeats of the unchanged states; expired memories go. */
  async sweep() {
    const now = this.now();
    for (const [id, asked] of this.commanded) if (now >= asked.until) this.commanded.delete(id);
    await this.publishStates();
  }

  // --- Gladys ----------------------------------------------------------------

  devices() {
    // Nothing to show before the panel was read once (the lists come from it).
    if (!this.model.panel) return undefined;
    return buildDevices(this.gladys, this.config, this.model);
  }

  async publishDevices({ force = false } = {}) {
    const devices = this.devices();
    if (!devices) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (!this.model.panel) return Promise.resolve();
    return this.publisher.publish(
      buildStates(this.gladys, this.config, this.model, { online: this.online }),
    );
  }

  async publishTransports(transport) {
    if (transport === this.lastTransport) return;
    const devices = this.devices();
    if (!devices) return;
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  async scan() {
    await this.publishDevices({ force: true });
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  /**
   * One command at a time, in the order asked (a scene runs its actions in
   * parallel: "arm 1" and "arm 2" both go, one after the other); a failed
   * one never blocks the next. A command whose own time ran out while it
   * waited its turn is refused, nothing sent (Gladys would give up on it
   * anyway). An arming goes before the disarms and outputs waiting, and
   * withdraws a disarm of the same area, waiting or being handled, as long
   * as it is not written.
   */
  serial({ asked = this.now(), area, kind } = {}, fn) {
    return new Promise((resolve, reject) => {
      const ticket = { asked, area, kind, withdrawn: false, fn, resolve, reject };
      if (kind === 'arm') {
        // A protective command: it withdraws a disarm of the same area, waiting
        // or being handled (until its write), and goes before the disarms and
        // outputs still waiting.
        for (const other of [this.current, ...this.waiting]) {
          if (other?.kind === 'disarm' && other.area === area) other.withdrawn = true;
        }
        const at = this.waiting.findIndex((t) => t.kind !== 'arm');
        if (at < 0) this.waiting.push(ticket);
        else this.waiting.splice(at, 0, ticket);
      } else {
        this.waiting.push(ticket);
      }
      this.nextCommand();
    });
  }

  nextCommand() {
    if (this.current || this.waiting.length === 0) return;
    const ticket = this.waiting.shift();
    this.current = ticket;
    Promise.resolve()
      .then(() => this.startCommand(ticket))
      .then(ticket.resolve, ticket.reject)
      .finally(() => {
        this.current = undefined;
        this.nextCommand();
      });
  }

  startCommand(ticket) {
    this.checkWithdrawn(ticket);
    if (this.now() >= ticket.asked + TIMINGS.readBy) {
      this.logger.warn('Command REFUSED: its time ran out behind other commands');
      throw this.refused(T.commandBusy);
    }
    return ticket.fn(ticket);
  }

  /** A disarm withdrawn by an arming of its area: refused, nothing sent. */
  checkWithdrawn(ticket) {
    if (!ticket?.withdrawn) return;
    this.logger.warn(`Disarm WITHDRAWN (area ${ticket.area}): an arming was asked meanwhile`);
    throw this.refused(T.disarmWithdrawn);
  }

  /** A whole number given by Gladys or a scene; '', null, 1.5 or 'x' are not numbers. */
  numberOf(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
      return undefined;
    }
    const n = Number(value);
    return Number.isInteger(n) ? n : undefined;
  }

  areaOf(value) {
    const n = this.numberOf(value);
    if (n === undefined || !this.model.areas.has(n)) {
      if (!this.client.connected && this.model.areas.size === 0) throw this.refused(T.offline);
      throw this.refused(fill(T.unknownArea, String(value).slice(0, 10)));
    }
    return n;
  }

  outputOf(value) {
    const n = this.numberOf(value);
    if (n === undefined || !this.model.outputs.has(n) || n > LIMITS.maxCommandOutput) {
      if (!this.client.connected && this.model.outputs.size === 0) throw this.refused(T.offline);
      throw this.refused(fill(T.unknownOutput, String(value).slice(0, 10)));
    }
    return n;
  }

  /** A button pressed in Gladys. Only a push (1) of a button feature acts. */
  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    const asked = this.now();
    const pressed = value === BUTTON_PUSH.PRESSED || value === String(BUTTON_PUSH.PRESSED);
    const action = target && `${target.kind}:${target.key}`;
    const handlers = {
      'area:arm-away': () => this.arm(target.number, 'armed_away', asked),
      'area:arm-stay': () => this.arm(target.number, 'armed_stay', asked),
      'area:disarm': () => this.disarm(target.number, asked),
      'output:turn-on': () => this.output(target.number, true, asked),
      'output:turn-off': () => this.output(target.number, false, asked),
    };
    if (!handlers[action]) throw new Error(`${feature?.external_id} is read-only`);
    if (!pressed) throw new Error(`Unexpected value ${JSON.stringify(value)} for a button`);
    await handlers[action]();
  }

  /**
   * The option of a command, read now; refused (nothing sent) once switched
   * off. Arming has no option: it is never blocked.
   */
  check(command, what) {
    const option = OPTIONS[command];
    if (!option || this.config[option[0]]) return;
    this.logger.warn(`${option[2]} REFUSED (${word(what, 'en')}): disabled in the configuration`);
    throw this.refused(option[1]);
  }

  /** Turns a failed fresh read into its refusal (nothing was sent). */
  readRefusal(err) {
    if (err instanceof BoschError && err.kind === 'late') return this.refused(T.tooLate);
    if (err instanceof BoschError && err.kind === 'offline') return this.refused(T.offline);
    // Timeout, refused or unexpected answer, lost session: unreadable.
    return this.refused(T.stateUnknown);
  }

  /** The status byte of an area read now; refused (nothing sent) when it cannot be read by readBy. */
  async freshArea(n, asked) {
    if (!this.client.connected) throw this.refused(T.offline);
    const readBy = asked + TIMINGS.readBy;
    if (readBy - this.now() < 100) throw this.refused(T.tooLate);
    let status;
    try {
      status = await this.client.readArea(n, { sendBy: readBy, answerBy: readBy, priority: true });
    } catch (err) {
      throw this.readRefusal(err);
    }
    const mode = areaMode(status);
    if (mode === undefined) throw this.refused(T.stateUnknown);
    return { mode, target: ARMING_TARGET.get(status) };
  }

  /** The active outputs read now. */
  async freshOutputs(asked) {
    if (!this.client.connected) throw this.refused(T.offline);
    const readBy = asked + TIMINGS.readBy;
    if (readBy - this.now() < 100) throw this.refused(T.tooLate);
    try {
      return await this.client.readOutputs({ sendBy: readBy, answerBy: readBy, priority: true });
    } catch (err) {
      throw this.readRefusal(err);
    }
  }

  /**
   * Sends a command decided on a fresh state. Resolves when the panel
   * accepted it; throws Refused when nothing was sent, an Error otherwise.
   * Only a NACK of the panel is a refusal: no answer, an unreadable answer
   * or a lost connection after the write is "sent, without confirmation",
   * with onSent() and a read back.
   */
  async send(what, asked, run, { command, onSent, readBack, ticket }) {
    const label = word(what, 'en');
    if (this.now() > asked + TIMINGS.sendBy) {
      this.logger.warn(`Command NOT sent (${label}): too late`);
      throw this.refused(T.tooLate);
    }
    // The configuration may have changed while the command waited its turn.
    this.check(command, what);
    this.checkWithdrawn(ticket);
    const request = run({
      sendBy: asked + TIMINGS.sendBy,
      // Absolute: the client waits from the write up to it, whatever was ahead in the queue.
      answerBy: asked + TIMINGS.answerBy,
      // …and once more by the client, right before the socket write.
      check: () => {
        try {
          this.check(command, what);
          return !ticket?.withdrawn;
        } catch {
          return false;
        }
      },
    });
    try {
      await request;
    } catch (err) {
      if (err instanceof BoschError && !err.sent) {
        this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
        if (err.kind === 'withdrawn') {
          this.checkWithdrawn(ticket);
          this.check(command, what);
        }
        throw this.refused(err.kind === 'late' || err.kind === 'withdrawn' ? T.tooLate : T.offline);
      }
      if (err instanceof BoschError && err.kind === 'nack') {
        this.scheduleReadBack(readBack);
        throw this.panelRefusal(what, err.code);
      }
      this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
      onSent();
      this.scheduleReadBack(readBack);
      throw this.error(fill(T.unconfirmed, word(what, this.language)), err);
    }
    onSent();
    this.logger.info(`Command accepted by the panel (${label})`);
    this.scheduleReadBack(readBack);
  }

  /** The error of a NACK. */
  panelRefusal(what, code) {
    const name = word(what, this.language);
    this.logger.warn(`Command REFUSED by the panel (${word(what, 'en')}): ${errorName(code)}`);
    if (code === NACK.NO_AUTHORITY) return this.error(fill(T.noAccess, name));
    if (code === NACK.CANNOT_ARM) return this.error(fill(T.cannotArm, name));
    return this.error(fill(T.panelRefused, name, errorName(code)));
  }

  scheduleReadBack(readBack) {
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!this.client.connected) return;
      readBack().catch((err) => this.logger.debug(`Read back failed: ${err.message}`));
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  /** Arm away or stay: never blocked by an option, except away -> stay (a lower protection). */
  async arm(rawArea, mode, asked = this.now()) {
    if (!ARM_MODES.includes(mode)) {
      throw this.refused({
        en: `Unknown arming mode: nothing was sent.`,
        fr: `Mode d'armement inconnu : rien n'a été envoyé.`,
      });
    }
    const n = this.areaOf(rawArea);
    const what = fill(COMMAND_NAMES[mode], n);
    return this.serial({ asked, area: n, kind: 'arm' }, async () => {
      const current = await this.freshArea(n, asked);
      const already = current.mode === 'arming' ? current.target : current.mode;
      if (already === mode) {
        this.logger.info(`Area ${n} already ${current.mode} (${mode}): nothing sent`);
        return;
      }
      if (current.mode === 'pending') {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): area ${n} is in its entry delay`);
        throw this.refused(T.entryDelay);
      }
      const command = mode === 'armed_stay' && already === 'armed_away' ? 'lower' : 'arm';
      this.check(command, what);
      const type = armType(this.model.panel?.family, mode);
      this.logger.info(`ARMING from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => this.client.arm(n, type, options), {
        command,
        onSent: () => this.commanded.set(n, { mode, until: this.now() + TIMINGS.commandMemory }),
        readBack: () => this.client.readArea(n),
      });
    });
  }

  async disarm(rawArea, asked = this.now()) {
    const n = this.areaOf(rawArea);
    const what = fill(COMMAND_NAMES.disarm, n);
    this.check('disarm', what);
    return this.serial({ asked, area: n, kind: 'disarm' }, async (ticket) => {
      this.check('disarm', what);
      const current = await this.freshArea(n, asked);
      // An arming asked during the read wins.
      this.checkWithdrawn(ticket);
      if (current.mode === 'disarmed') {
        this.logger.info(`Area ${n} already disarmed: nothing sent`);
        return;
      }
      this.check('disarm', what);
      this.logger.info(`DISARMING from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => this.client.disarm(n, options), {
        ticket,
        command: 'disarm',
        onSent: () =>
          this.commanded.set(n, { mode: 'disarmed', until: this.now() + TIMINGS.commandMemory }),
        readBack: () => this.client.readArea(n),
      });
    });
  }

  async output(rawOutput, on, asked = this.now()) {
    const n = this.outputOf(rawOutput);
    const what = fill(COMMAND_NAMES[on ? 'turn-on' : 'turn-off'], n);
    this.check('output', what);
    return this.serial({ asked, area: undefined, kind: 'output' }, async () => {
      this.check('output', what);
      const active = await this.freshOutputs(asked);
      if (active.has(n) === on) {
        this.logger.info(`Output ${n} already ${on ? 'on' : 'off'}: nothing sent`);
        return;
      }
      this.check('output', what);
      this.logger.info(`OUTPUT from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => this.client.setOutput(n, on, options), {
        command: 'output',
        onSent: () => undefined,
        readBack: () => this.client.readOutputs(),
      });
    });
  }

  // --- Configuration buttons ---------------------------------------------------

  /** Waits for the session to come up or go down, at most `timeout` ms. */
  waitForLink(timeout = TIMINGS.testWait) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": connects now when no connection is open (else
   * waits for the one in progress), tells what the panel holds. Never after
   * a refused code (that is "Allow a new try of the code").
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (this.codeStopped()) throw this.error(T.codeStoppedTest);
    if (this.client.waiting) {
      // A new try is planned (backoff, "max connections"): never sooner.
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.stillConnecting);
    }
    if (!this.client.connected && !this.client.busy) {
      if (!(await this.startClient())) throw this.error(this.stopMessage());
    }
    const result = await this.waitForLink();
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    await this.setStatus(true, this.connectedMessage());
    return this.connectedMessage();
  }

  /**
   * "Allow a new try of the code": the user's explicit go for ONE new login
   * with the codes of the configuration; refused again, it stops again.
   */
  async allowCodeRetry() {
    await this.loadMemory();
    if (!this.codeStopped()) return T.codeNotStopped;
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    await this.liftCodeStop();
    await this.startClient({ retryCode: true });
    return T.codeRetryAllowed;
  }
}
