// The bytes of Mode 2 (src/bosch/frame.js) and the protocol tables
// (src/bosch/protocol.js), checked against the reference's own behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameReader,
  decodeAnswer,
  decodeIdSet,
  decodeName,
  encodeAreaMask,
  encodeAutomationCode,
  encodeRequest,
  encodeUserCode,
  parseAlarmDetail,
  parseNamesMany,
  parseStatusUpdates,
} from '../src/bosch/frame.js';
import {
  ARM_TYPE,
  FAMILY,
  areaMode,
  armType,
  credentialsFor,
  isArmed,
  parseWhatAreYou,
  pointOpen,
} from '../src/bosch/protocol.js';

/** The reference's _load_entity_set, for comparison. */
function referenceIdSet(bytes) {
  const ids = [];
  let index = 0;
  for (let b of bytes) {
    for (let i = 0; i < 8; i += 1) {
      if (b & 1) ids.push(index + (8 - i));
      b >>= 1;
    }
    index += 8;
  }
  return ids.sort((a, b) => a - b);
}

test('a request: 0x01, length of command + data, command, data', () => {
  assert.deepEqual([...encodeRequest(0x26, [0, 1])], [0x01, 0x03, 0x26, 0x00, 0x01]);
  assert.deepEqual([...encodeRequest(0x01)], [0x01, 0x01, 0x01]);
  assert.throws(() => encodeRequest(0x01, Buffer.alloc(255)), /too long/);
});

test('the reader cuts answers and status frames, across chunks', () => {
  const answers = [];
  const statuses = [];
  const reader = new FrameReader({
    onAnswer: (p) => answers.push([...p]),
    onStatus: (p) => statuses.push([...p]),
    onError: (why) => assert.fail(why),
  });
  const bytes = Buffer.from([
    0x01, 0x02, 0xfe, 0x07, 0x02, 0x00, 0x02, 0x00, 0x00, 0x04, 0x00, 0x01, 0xfc,
  ]);
  for (const b of bytes) reader.push(Buffer.from([b]));
  assert.deepEqual(answers, [[0xfe, 0x07], [0xfc]]);
  assert.deepEqual(statuses, [[0x00, 0x00]]);
  assert.equal(reader.total, 0);
});

test('an unknown frame type or a frame too long stops the reader', () => {
  const errors = [];
  const reader = new FrameReader({
    onAnswer: () => assert.fail('nothing to read'),
    onStatus: () => assert.fail('nothing to read'),
    onError: (why) => errors.push(why),
  });
  reader.push(Buffer.from([0x09, 0x01, 0x02]));
  reader.push(Buffer.from([0x01, 0x01, 0xfc]));
  assert.deepEqual(errors, ['unknown frame type 0x09']);
  const small = new FrameReader({
    onAnswer: () => assert.fail('too long'),
    onStatus: () => assert.fail('too long'),
    onError: (why) => errors.push(why),
    maxFrame: 4,
  });
  small.push(Buffer.from([0x02, 0x00, 0x05]));
  assert.equal(errors.at(-1), 'frame too long');
});

test('answers: ack, nack with its code, data, anything else unexpected', () => {
  assert.deepEqual(decodeAnswer(Buffer.from([0xfc])).kind, 'ack');
  assert.deepEqual(decodeAnswer(Buffer.from([0xfd, 0x08])), { kind: 'nack', code: 0x08 });
  assert.deepEqual([...decodeAnswer(Buffer.from([0xfe, 1, 2])).data], [1, 2]);
  assert.equal(decodeAnswer(Buffer.from([0x00])).kind, 'unexpected');
  assert.equal(decodeAnswer(Buffer.alloc(0)).kind, 'unexpected');
});

test('id sets number as the reference: bit 7 of byte 0 is id 1', () => {
  for (const bytes of [[0x80], [0x01], [0xa5, 0x0f], [0x00, 0x40, 0xff]]) {
    assert.deepEqual(decodeIdSet(Buffer.from(bytes)), referenceIdSet(bytes), bytes.join(','));
  }
  assert.deepEqual(decodeIdSet(Buffer.from([0xff, 0xff]), 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('the area mask of an arming: only that area bit, from the left', () => {
  assert.deepEqual([...encodeAreaMask(1)], [0x80]);
  assert.deepEqual([...encodeAreaMask(8)], [0x01]);
  assert.deepEqual([...encodeAreaMask(9)], [0x00, 0x80]);
  assert.deepEqual([...encodeAreaMask(32)], [0, 0, 0, 0x01]);
});

test('the codes in their frames (never anywhere else)', () => {
  assert.deepEqual([...encodeUserCode('1234')], [0x12, 0x34, 0xff, 0xff]);
  assert.deepEqual([...encodeUserCode('12345678')], [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual([...encodeAutomationCode(1, 'Ab1')], [0x01, 0x41, 0x62, 0x31, 0x00]);
});

test('names: many per answer, cleaned and bounded', () => {
  const data = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.from('Maison\0'),
    Buffer.from([0, 2]),
    Buffer.from('Gar\u0007age'),
  ]);
  assert.deepEqual(parseNamesMany(data), [
    { id: 1, name: 'Maison' },
    { id: 2, name: 'Gar age' },
  ]);
  assert.equal(decodeName(Buffer.from('x'.repeat(100))).length, 40);
});

test('status updates: every known type; an unknown one stops the frame', () => {
  const frame = Buffer.from([
    0x00, 0x01, 0x04, 0x01, 0x00, 0x02, 0x01, 0x07, 0x02, 0x00, 0x05, 0x02, 0x00, 0x06, 0x03, 0x05,
    0x01, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x01, 0x07, 0x00, 0x01, 0x0a, 0x01, 0x00, 0x00, 0x20,
    0x00, 0x00, 0x00, 0x02, 0x01, 0xaa,
  ]);
  const { updates, stopped } = parseStatusUpdates(frame);
  assert.deepEqual(updates, [
    { type: 'heartbeat' },
    { type: 'area', id: 2, status: 0x01 },
    { type: 'point', id: 5, status: 0x02 },
    { type: 'point', id: 6, status: 0x03 },
    { type: 'ready', id: 1, ready: 2, faults: 0 },
    { type: 'alarms', priority: 7, count: 1 },
    { type: 'faults', faults: 0x20 },
  ]);
  assert.equal(stopped, 'update type 0x02');
  assert.equal(
    parseStatusUpdates(Buffer.from([0x07, 0x02, 0x00, 0x01, 0x02])).stopped,
    'truncated',
  );
});

test('alarm detail records: area, point, the 0xFFFF sentinel', () => {
  assert.deepEqual(parseAlarmDetail(Buffer.from([0, 1, 0, 0, 7, 0, 2, 0, 0xff, 0xff, 9])), [
    { area: 1, point: 7 },
    { area: 2, point: 0xffff },
  ]);
});

test('area modes, arming types by family, point states', () => {
  assert.equal(areaMode(0x04), 'disarmed');
  assert.equal(areaMode(0x07), 'arming');
  assert.equal(areaMode(0x05), 'pending');
  assert.equal(areaMode(0x01), 'armed_away');
  assert.equal(areaMode(0x03), 'armed_stay');
  assert.equal(areaMode(0x0a), 'armed_stay');
  assert.equal(areaMode(0x00), undefined);
  assert.equal(isArmed('pending'), true);
  assert.equal(isArmed('arming'), false);
  assert.equal(armType(FAMILY.B_SERIES, 'armed_away'), ARM_TYPE.MASTER_DELAY);
  assert.equal(armType(FAMILY.G_SERIES, 'armed_stay'), ARM_TYPE.PERIMETER_DELAY);
  assert.equal(armType(FAMILY.SOLUTION, 'armed_away'), ARM_TYPE.AWAY);
  assert.equal(armType(FAMILY.AMAX, 'armed_stay'), ARM_TYPE.STAY1);
  assert.equal(pointOpen(0x02), true);
  assert.equal(pointOpen(0x01), true);
  assert.equal(pointOpen(0x03), false);
  assert.equal(pointOpen(0x04), undefined);
});

test('which codes each family needs', () => {
  const both = { automationCode: 'abc', userCode: '12' };
  assert.deepEqual(credentialsFor(FAMILY.SOLUTION, both), { user: '12' });
  assert.deepEqual(credentialsFor(FAMILY.AMAX, both), {
    automation: 'abc',
    userType: 0,
    user: '12',
  });
  assert.deepEqual(credentialsFor(FAMILY.B_SERIES, both), { automation: 'abc', userType: 1 });
  assert.equal(credentialsFor(FAMILY.SOLUTION, { automationCode: 'abc' }).problem, 'needUserCode');
  assert.equal(credentialsFor(FAMILY.AMAX, { userCode: '1' }).problem, 'needBothCodes');
  assert.equal(credentialsFor(FAMILY.GV4, { userCode: '1' }).problem, 'needAutomationCode');
});

test('what are you: the model, the protocol, the capability bits', () => {
  const data = Buffer.alloc(23 + 33);
  data[0] = 0xa7;
  data[5] = 3;
  data[6] = 1;
  data[23 + 7] = 0x20;
  data[23 + 2] = 0x20;
  data[23 + 16] = 0x20;
  const info = parseWhatAreYou(data);
  assert.equal(info.model, 'B9512G');
  assert.equal(info.family, FAMILY.G_SERIES);
  assert.equal(info.protocol, 'v3.1');
  assert.equal(info.caps.areaText, 1);
  assert.equal(info.caps.alarmSummary, 1);
  assert.equal(info.caps.subscription, 1);
  assert.equal(info.caps.serial, false);
  assert.equal(parseWhatAreYou(Buffer.from([0x99, 0, 0, 0, 0, 0, 0])).model, undefined);
  assert.throws(() => parseWhatAreYou(Buffer.from([0xa4])), /short/);
});
