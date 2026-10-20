// BoschClient against the in-memory panel: hostile or broken answers never
// make it loop, and never let it guess which answer is which.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoschClient } from '../src/bosch/client.js';
import { LIMITS } from '../src/constants.js';
import { FakePanel, quietLogger, until } from './helpers/fakeBosch.js';

function client(t, panel) {
  const logger = quietLogger();
  const c = new BoschClient({ connect: panel.connect, logger });
  c.configure({ host: '192.0.2.30', port: 7700, automationCode: panel.automationCode });
  const downs = [];
  c.on('down', (info) => downs.push(info));
  t.after(() => c.stop());
  return { c, downs, logger };
}

test('a name page without progress ends the name reading', async (t) => {
  const panel = new FakePanel();
  const respond = panel.respond.bind(panel);
  panel.respond = (socket, cmd, body) =>
    cmd === 0x3c ? [0xfe, 0, 1, ...Buffer.from('Same'), 0] : respond(socket, cmd, body);
  const { c } = client(t, panel);
  c.start();
  await until(() => c.connected);
  assert.ok(panel.sent(0x3c).length <= 2, 'the same page again: stopped');
  assert.equal(c.model.points.get(1).name, 'Same');
});

test('an alarm detail that always says "more" is read a bounded number of pages', async (t) => {
  const panel = new FakePanel();
  panel.alarms.set(7, [{ area: 1, point: 1 }]);
  const respond = panel.respond.bind(panel);
  let point = 0;
  panel.respond = (socket, cmd, body) => {
    if (cmd !== 0x23) return respond(socket, cmd, body);
    point += 1;
    return [0xfe, 0, 1, 0, 0, point, 0, 1, 0, 0xff, 0xff];
  };
  const { c } = client(t, panel);
  c.start();
  await until(() => c.connected);
  assert.equal(panel.sent(0x23).length, LIMITS.maxAlarmPages);
  assert.equal(c.model.alarms.get(7).length, LIMITS.maxAlarmPages);
});

test('an answer nobody asked for resets the session', async (t) => {
  const panel = new FakePanel();
  const { c, downs } = client(t, panel);
  c.start();
  await until(() => c.connected);
  panel.current.answer([0xfc]);
  await until(() => downs.length === 1);
  assert.match(downs[0].reason, /nobody asked/);
  assert.equal(downs[0].retryIn, 10_000, 'spaced reconnection');
});

test('an unknown frame type resets the session', async (t) => {
  const panel = new FakePanel();
  const { c, downs } = client(t, panel);
  c.start();
  await until(() => c.connected);
  panel.current.raw([0x55, 0x00]);
  await until(() => downs.length === 1);
  assert.match(downs[0].reason, /unknown frame type/);
});

test('an unsupported model waits five minutes; a refused code parks', async (t) => {
  const odd = new FakePanel({ model: 0x99 });
  const first = client(t, odd);
  first.c.start();
  await until(() => first.downs.length === 1);
  assert.equal(first.downs[0].retryIn, 300_000);
  assert.equal(odd.logins.length, 0, 'no code sent to an unknown panel');
  const wrong = new FakePanel({ automationCode: 'other' });
  const second = client(t, wrong);
  second.c.configure({ host: 'h', port: 7700, automationCode: 'mine' });
  second.c.start();
  await until(() => second.downs.length === 1);
  assert.deepEqual(
    [second.downs[0].refused, second.downs[0].parked, second.c.running],
    [true, true, false],
  );
  assert.ok(!second.logger.lines.some((l) => l.includes('mine')));
});

test('a status frame of an unconfigured id or a prototype key changes nothing', async (t) => {
  const panel = new FakePanel();
  const { c } = client(t, panel);
  c.start();
  await until(() => c.connected);
  panel.push([0x07, 0x01, 0x01, 0xf4, 0x02, 0x04, 0x01, 0x00, 0x63, 0x01]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(c.model.points.has(500), false);
  assert.equal(c.model.areas.has(99), false);
  assert.equal({}.status, undefined);
});
