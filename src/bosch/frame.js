// -----------------------------------------------------------------------------
// Bytes of the Mode 2 protocol, ported from bosch-alarm-mode2 0.4.11
// (`connection.py`, `panel.py`, `utils.py`, MIT, see THIRD_PARTY_NOTICES.md):
// - a request: 0x01, length (command + data), command, data;
// - what the panel sends: 0x01 + 1-byte length (an answer), 0x04 + 2-byte
//   length (an answer, extended protocol), 0x02 + 2-byte length (status
//   updates of a subscription);
// - an answer: 0xFC (ack), 0xFD + error (nack), 0xFE + data;
// - the id sets (bit 7 of the first byte is id 1), the area mask of an
//   arming, the names, the status updates.
//
// Everything is read in one linear pass, with bounded lengths; nothing read
// from the panel becomes an object key.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { ANSWER, FRAME } from './protocol.js';

/** A request frame (basic protocol: the length holds in one byte). */
export function encodeRequest(cmd, data = []) {
  const body = Buffer.from(data);
  if (body.length + 1 > 0xff) throw new Error('request too long');
  return Buffer.concat([Buffer.from([FRAME.BASIC, body.length + 1, cmd]), body]);
}

/**
 * Cuts the stream into frames. `onAnswer(payload)` for 0x01 / 0x04,
 * `onStatus(payload)` for 0x02, `onError(why)` for an unknown frame type (the
 * stream is then unreadable: nothing more is read).
 */
export class FrameReader {
  constructor({ onAnswer, onStatus, onError, maxFrame = LIMITS.maxFrame }) {
    this.onAnswer = onAnswer;
    this.onStatus = onStatus;
    this.onError = onError;
    this.maxFrame = maxFrame;
    this.buffer = Buffer.alloc(0);
    this.broken = false;
  }

  push(chunk) {
    if (this.broken) return;
    // What is kept between two chunks is less than one frame (bounded).
    const data =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    let pos = 0;
    while (pos < data.length) {
      const type = data[pos];
      let header;
      let length;
      if (type === FRAME.BASIC) {
        if (data.length - pos < 2) break;
        header = 2;
        length = data[pos + 1];
      } else if (type === FRAME.STATUS || type === FRAME.EXTENDED) {
        if (data.length - pos < 3) break;
        header = 3;
        length = data.readUInt16BE(pos + 1);
      } else {
        this.broken = true;
        this.buffer = Buffer.alloc(0);
        this.onError(`unknown frame type 0x${type.toString(16).padStart(2, '0')}`);
        return;
      }
      if (length > this.maxFrame) {
        this.broken = true;
        this.buffer = Buffer.alloc(0);
        this.onError('frame too long');
        return;
      }
      if (data.length - pos < header + length) break;
      const payload = Buffer.from(data.subarray(pos + header, pos + header + length));
      pos += header + length;
      if (type === FRAME.STATUS) this.onStatus(payload);
      else this.onAnswer(payload);
      if (this.broken) return;
    }
    this.buffer = Buffer.from(data.subarray(pos));
  }
}

/** An answer payload -> { kind: 'ack' | 'nack' | 'data' | 'unexpected', data?, code? }. */
export function decodeAnswer(payload) {
  if (!payload || payload.length === 0) return { kind: 'unexpected' };
  if (payload[0] === ANSWER.ACK) return { kind: 'ack', data: Buffer.alloc(0) };
  if (payload[0] === ANSWER.DATA) return { kind: 'data', data: Buffer.from(payload.subarray(1)) };
  if (payload[0] === ANSWER.NACK) {
    return { kind: 'nack', code: payload.length > 1 ? payload[1] : undefined };
  }
  return { kind: 'unexpected' };
}

/** An id set: bit 7 of byte 0 is id 1, bit 0 of byte 0 id 8, bit 7 of byte 1 id 9… */
export function decodeIdSet(data, max = Infinity) {
  const ids = [];
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (byte === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      const id = i * 8 + bit + 1;
      if (id > max) return ids;
      if (byte & (0x80 >> bit)) ids.push(id);
    }
  }
  return ids;
}

/** The area mask of AREA_ARM: only the bit of `area` set (section 3.1.4). */
export function encodeAreaMask(area) {
  const index = Math.floor((area - 1) / 8);
  const mask = Buffer.alloc(index + 1);
  mask[index] = 0x80 >> ((area - 1) % 8);
  return mask;
}

/** 16-bit ids, big-endian. */
export const encodeIds16 = (ids) => {
  const out = Buffer.alloc(ids.length * 2);
  ids.forEach((id, i) => out.writeUInt16BE(id, i * 2));
  return out;
};

/** A name read from the panel: UTF-8, without control characters, trimmed, bounded. */
export function decodeName(bytes) {
  return (
    Buffer.from(bytes)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f�]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITS.maxName)
      .trim()
  );
}

/** The names of a "return many" text answer (CF03): [{ id, name }], in order. */
export function parseNamesMany(data) {
  const names = [];
  let pos = 0;
  while (data.length - pos >= 2) {
    const id = data.readUInt16BE(pos);
    const end = data.indexOf(0, pos + 2);
    const stop = end < 0 ? data.length : end;
    names.push({ id, name: decodeName(data.subarray(pos + 2, stop)) });
    pos = end < 0 ? data.length : end + 1;
  }
  return names;
}

/** The name of a "one" text answer (CF01): up to the first 0. */
export function parseNameOne(data) {
  const end = data.indexOf(0);
  return decodeName(data.subarray(0, end < 0 ? data.length : end));
}

/** [id16, status] triplets of AREA_STATUS / POINT_STATUS. */
export function parseStatusTriplets(data) {
  const entries = [];
  for (let pos = 0; data.length - pos >= 3; pos += 3) {
    entries.push([data.readUInt16BE(pos), data[pos + 2]]);
  }
  return entries;
}

/** Records of ALARM_MEMORY_DETAIL: { area, point } every 5 bytes; point 0xFFFF: more to read. */
export function parseAlarmDetail(data) {
  const records = [];
  for (let pos = 0; data.length - pos >= 5; pos += 5) {
    records.push({ area: data.readUInt16BE(pos), point: data.readUInt16BE(pos + 3) });
  }
  return records;
}

/** Bytes of each status update, by type; heartbeat has none. */
const UPDATE_SIZES = new Map([
  [0x00, 0],
  [0x01, 3],
  [0x04, 3],
  [0x05, 5],
  [0x06, 3],
  [0x07, 3],
  [0x08, 3],
  [0x0a, 6],
]);

/**
 * The status updates of a subscription frame: [type, count] then `count`
 * records. -> { updates: [{ type, ... }], stopped: why | undefined }. An
 * unknown type (its size is unknown: the event log, never subscribed) or a
 * truncated record stops the reading of the frame.
 */
export function parseStatusUpdates(data) {
  const updates = [];
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 2) return { updates, stopped: 'truncated' };
    const type = data[pos];
    const count = data[pos + 1];
    pos += 2;
    const size = UPDATE_SIZES.get(type);
    if (size === undefined) {
      return { updates, stopped: `update type 0x${type.toString(16).padStart(2, '0')}` };
    }
    if (data.length - pos < size * count) return { updates, stopped: 'truncated' };
    for (let i = 0; i < count; i += 1) {
      const r = data.subarray(pos, pos + size);
      pos += size;
      if (type === 0x00) updates.push({ type: 'heartbeat' });
      else if (type === 0x01)
        updates.push({ type: 'alarms', priority: r[0], count: r.readUInt16BE(1) });
      else if (type === 0x04) updates.push({ type: 'area', id: r.readUInt16BE(0), status: r[2] });
      else if (type === 0x05) {
        updates.push({
          type: 'ready',
          id: r.readUInt16BE(0),
          ready: r[2],
          faults: r.readUInt16BE(3),
        });
      } else if (type === 0x06) updates.push({ type: 'output' });
      else if (type === 0x07) updates.push({ type: 'point', id: r.readUInt16BE(0), status: r[2] });
      else if (type === 0x0a) updates.push({ type: 'faults', faults: r.readUInt16BE(1) });
      // 0x08 (doors): not followed in this version.
    }
  }
  return { updates, stopped: undefined };
}

/** The user code of LOGIN_REMOTE_USER: its digits padded with F, as 4 bytes (0x1234FFFF). */
export const encodeUserCode = (code) => Buffer.from(code.padEnd(8, 'F'), 'hex');

/** The automation code of AUTHENTICATE: user type, the characters, a 0. */
export const encodeAutomationCode = (userType, code) =>
  Buffer.concat([Buffer.from([userType]), Buffer.from(code, 'latin1'), Buffer.from([0])]);
