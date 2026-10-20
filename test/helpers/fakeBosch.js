// -----------------------------------------------------------------------------
// An in-memory Bosch panel speaking Mode 2: no socket, no TLS, no network.
// `connect` is given to the client in place of tls.connect; each call opens
// a connection that answers as bosch-alarm-mode2 describes the panels
// ("what are you" with its capability bits, the login by family, the
// configured lists, the names, the status, the alarm memory, the
// subscription and its status updates, the arming and output commands). It
// records every request the client sent.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits until `check()` is true, at most `timeout` ms. */
export async function until(check, timeout = 6_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await settle(5);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never met');
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};

/** Ids -> id set bytes (bit 7 of byte 0 is id 1). */
export function idSet(ids, bytes) {
  const size = bytes ?? Math.max(1, Math.ceil(Math.max(0, ...ids) / 8));
  const out = Buffer.alloc(size);
  for (const id of ids) out[Math.floor((id - 1) / 8)] |= 0x80 >> ((id - 1) % 8);
  return out;
}

const MODEL_FAMILY = { 0x20: 'solution', 0x24: 'amax', 0xa4: 'b-series', 0xa7: 'g-series' };

class FakeSocket extends EventEmitter {
  constructor(panel) {
    super();
    this.panel = panel;
    this.destroyed = false;
    this.writableLength = 0;
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.subscribed = false;
  }

  setNoDelay() {}

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    const copy = Buffer.from(bytes);
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.buffer = Buffer.concat([this.buffer, copy]);
      while (this.buffer.length >= 2 && this.buffer.length >= this.buffer[1] + 2) {
        const length = this.buffer[1];
        const cmd = this.buffer[2];
        const data = Buffer.from(this.buffer.subarray(3, 2 + length));
        this.buffer = this.buffer.subarray(2 + length);
        this.panel.receive(this, cmd, data);
      }
    });
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Server side: an answer payload (0xFE + data, 0xFC, 0xFD + error). */
  answer(payload) {
    this.raw(Buffer.concat([Buffer.from([0x01, payload.length]), Buffer.from(payload)]));
  }

  /** Server side: status updates (0x02 frame). */
  status(payload) {
    const head = Buffer.alloc(3);
    head[0] = 0x02;
    head.writeUInt16BE(payload.length, 1);
    this.raw(Buffer.concat([head, Buffer.from(payload)]));
  }

  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

const ok = () => [0xfc];
const data = (bytes) => [0xfe, ...bytes];
const nack = (code) => [0xfd, code];

export class FakePanel {
  constructor({
    model = 0xa4,
    automationCode = 'Gladys2026',
    userCode = '1234',
    subscription = true,
    maxConnections = false,
    names = true,
    areas = { 1: 'Maison', 2: 'Garage' },
    points = { 1: 'Porte entree', 2: 'Couloir', 7: 'Salon' },
    outputs = { 3: 'Sirene' },
  } = {}) {
    this.model = model;
    this.family = MODEL_FAMILY[model];
    this.automationCode = automationCode;
    this.userCode = userCode;
    this.subscription = subscription;
    this.maxConnections = maxConnections;
    this.names = names;
    this.areas = new Map(
      Object.entries(areas).map(([id, name]) => [Number(id), { name, status: 0x04 }]),
    );
    this.points = new Map(
      Object.entries(points).map(([id, name]) => [Number(id), { name, status: 0x03 }]),
    );
    this.outputs = new Map(
      Object.entries(outputs).map(([id, name]) => [Number(id), { name, on: false }]),
    );
    /** priority -> [{ area, point }] */
    this.alarms = new Map();
    this.faults = 0;
    /** NACK code for every arming / output command, undefined: accepted. */
    this.rejectCode = undefined;
    /** Arming goes through the exit delay first (0x07 / 0x08). */
    this.exitDelay = false;
    this.sockets = [];
    /** Every request: [{ session, cmd, data }]. */
    this.log = [];
    /** (cmd, data) -> true: that request gets no answer. */
    this.hold = () => false;
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    const open = this.sockets.filter((s) => s !== socket && !s.destroyed).length;
    this.maxOpen = Math.max(this.maxOpen ?? 0, open + 1);
    queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** The commands of every session, by code. */
  sent(cmd) {
    return this.log.filter((e) => e.cmd === cmd);
  }

  /** The logins (AUTHENTICATE or LOGIN_REMOTE_USER), every session. */
  get logins() {
    return this.log.filter((e) => e.cmd === 0x06 || e.cmd === 0x3e);
  }

  receive(socket, cmd, body) {
    this.log.push({ session: socket.session, cmd, data: body });
    if (this.hold(cmd, body)) return;
    const reply = this.respond(socket, cmd, body);
    if (reply) socket.answer(reply);
  }

  whatAreYou() {
    const out = Buffer.alloc(23 + 33);
    out[0] = this.model;
    out[5] = 5;
    out[6] = 3;
    const bits = out.subarray(23);
    bits[13] |= 0x04; // serial
    bits[5] |= 0x08; // status
    if (this.names) {
      bits[7] |= 0x08; // area text CF03
      bits[9] |= 0x40; // output text CF01
      bits[11] |= 0x20; // point text CF03
    }
    bits[2] |= 0x10; // alarm summary, format 2
    if (this.subscription) bits[24] |= 0x40; // subscription, format 2
    return out;
  }

  respond(socket, cmd, body) {
    if (cmd === 0x01)
      return body[0] === 3 && this.family === 'amax' ? nack(0x03) : data(this.whatAreYou());
    if (cmd === 0x06) {
      if (this.maxConnections) return data([0x02]);
      const code = body.subarray(1, body.indexOf(0, 1)).toString('latin1');
      const typeOk = body[0] === (this.family === 'amax' ? 0x00 : 0x01);
      if (code === this.automationCode && typeOk) {
        socket.authenticated = this.family !== 'amax';
        socket.automation = true;
        return data([0x01]);
      }
      return data([0x00]);
    }
    if (cmd === 0x3e) {
      if (body.toString('hex') !== this.userCode.padEnd(8, 'f')) return nack(0x24);
      socket.authenticated = true;
      return ok();
    }
    if (!socket.authenticated) return nack(0x23);
    switch (cmd) {
      case 0x4a:
        return data([0, 0, 0x01, 0x02, 0x03, 0x04]);
      case 0x20: {
        const out = Buffer.alloc(8);
        out[0] = 3;
        out[1] = 4;
        out.writeUInt16BE(this.faults, 5);
        return data(out);
      }
      case 0x24:
        return data(idSet([...this.areas.keys()], 4));
      case 0x35:
        return data(idSet([...this.points.keys()], 8));
      case 0x30:
        return data(idSet([...this.outputs.keys()], 8));
      case 0x29:
        return this.textMany(this.areas, body);
      case 0x3c:
        return this.textMany(this.points, body);
      case 0x33: {
        const output = this.outputs.get(body[0]);
        return data(output ? [...Buffer.from(output.name), 0] : [0]);
      }
      case 0x26:
        return this.statuses(this.areas, body);
      case 0x38:
        return this.statuses(this.points, body);
      case 0x31:
        return data(
          idSet(
            [...this.outputs].filter(([, o]) => o.on).map(([id]) => id),
            8,
          ),
        );
      case 0x08: {
        const out = Buffer.alloc(20);
        for (const [priority, records] of this.alarms)
          out.writeUInt16BE(records.length, (priority - 1) * 2);
        return data(out);
      }
      case 0x23: {
        const records = this.alarms.get(body[0]) ?? [];
        const out = Buffer.alloc(records.length * 5);
        records.forEach((r, i) => {
          out.writeUInt16BE(r.area, i * 5);
          out.writeUInt16BE(r.point, i * 5 + 3);
        });
        return data(out);
      }
      case 0x5f:
        if (!this.subscription) return nack(0x07);
        socket.subscribed = true;
        return ok();
      case 0x27:
        return this.arm(socket, body);
      case 0x32:
        return this.setOutput(socket, body);
      default:
        return nack(0x03);
    }
  }

  textMany(entities, body) {
    const from = body.readUInt16BE(0);
    const parts = [];
    let count = 0;
    for (const [id, entity] of [...entities].sort(([a], [b]) => a - b)) {
      if (id <= from || count >= 2) continue;
      const head = Buffer.alloc(2);
      head.writeUInt16BE(id);
      parts.push(head, Buffer.from(entity.name), Buffer.from([0]));
      count += 1;
    }
    return data(Buffer.concat(parts));
  }

  statuses(entities, body) {
    const out = [];
    for (let i = 0; i + 1 < body.length; i += 2) {
      const id = body.readUInt16BE(i);
      const entity = entities.get(id);
      if (entity) out.push(id >> 8, id & 0xff, entity.status);
    }
    return data(out);
  }

  arm(socket, body) {
    if (this.rejectCode !== undefined) return nack(this.rejectCode);
    const type = body[0];
    const mask = body.subarray(1);
    // Only the last byte holds a bit (section 3.1.4): bit 7 is the first area of that byte.
    const id = (mask.length - 1) * 8 + (7 - Math.log2(mask.at(-1))) + 1;
    const entry = this.areas.get(id);
    if (!entry) return nack(0x21);
    const away = [0x02, 0x03, 0x0c].includes(type);
    if (type === 0x01) entry.status = 0x04;
    else if (this.exitDelay) entry.status = away ? 0x07 : 0x08;
    else entry.status = away ? 0x01 : 0x03;
    queueMicrotask(() => this.pushArea(id));
    return ok();
  }

  setOutput(socket, body) {
    if (this.rejectCode !== undefined) return nack(this.rejectCode);
    const output = this.outputs.get(body[0]);
    if (!output) return nack(0x05);
    output.on = body[1] === 1;
    queueMicrotask(() => this.push([0x06, 1, 0, body[0], body[1]]));
    return ok();
  }

  /** Status updates to the subscribed client. */
  push(payload) {
    const socket = this.current;
    if (socket?.subscribed && !socket.destroyed) socket.status(payload);
  }

  pushArea(id) {
    this.push([0x04, 1, id >> 8, id & 0xff, this.areas.get(id).status]);
  }

  /** Panel-side changes. */
  setArea(id, status) {
    this.areas.get(id).status = status;
    this.pushArea(id);
  }

  setPoint(id, status) {
    this.points.get(id).status = status;
    this.push([0x07, 1, id >> 8, id & 0xff, status]);
  }

  setReady(id, ready) {
    this.push([0x05, 1, id >> 8, id & 0xff, ready, 0, 0]);
  }

  setAlarm(priority, records) {
    this.alarms.set(priority, records);
    const count = records.length;
    this.push([0x01, 1, priority, count >> 8, count & 0xff]);
  }

  setFaults(faults) {
    this.faults = faults;
    this.push([0x0a, 1, 0, faults >> 8, faults & 0xff, 0, 0, 0]);
  }

  /** The panel closes the connection. */
  drop() {
    this.current.destroy();
  }
}
