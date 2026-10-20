// BoschApp with the SDK's fake Gladys (createFakeGladys) and the in-memory
// panel (test/helpers/fakeBosch.js): the whole chain from the frames to the
// Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BoschApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakePanel, quietLogger, settle, until } from './helpers/fakeBosch.js';

const CODE = 'Gladys2026';
const BASE = {
  host: '192.0.2.30',
  automation_code: CODE,
  point_kinds: '2:motion',
  language: 'en',
};

async function setup(t, { config = {}, panel: panelOptions = {}, store, devices } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const panel = new FakePanel(panelOptions);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new BoschApp({ gladys, logger, connect: panel.connect, store: memory, settleMs: 0 });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  return {
    gladys,
    panel,
    app,
    logger,
    store: memory,
    device,
    panelIds: gladys.externalIds('panel', 'bosch'),
    area: (n = 1) => gladys.externalIds('area', String(n)),
    point: (n) => gladys.externalIds('point', String(n)),
    output: (n) => gladys.externalIds('output', String(n)),
    state: (id) => gladys.fake.lastState(id),
    events: () => gladys.fake.sceneEvents,
    press: (ids, key, value = 1) => {
      const d = device(ids.device);
      const feature = d.features.find((f) => f.external_id === ids.feature(key));
      return gladys.fake.setValue(d, feature, value);
    },
  };
}

const up = async (ctx) => {
  await until(() => ctx.app.online);
  await ctx.app.chain;
  await settle();
};

/** Lets a change reported by the panel reach Gladys. */
const flush = async (ctx) => {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await ctx.app.chain;
  await settle();
};

const noCodeInLogs = (ctx, ...codes) => {
  for (const code of codes) {
    assert.ok(!ctx.logger.lines.some((l) => l.includes(code)), `${code} is never logged`);
  }
};

test('start: devices named by the panel, read-only states, push buttons, status', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const { gladys, area, point, output, panelIds } = ctx;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [panelIds.device, 'Bosch panel'],
      [area(1).device, 'Maison'],
      [area(2).device, 'Garage'],
      [point(1).device, 'Porte entree'],
      [point(2).device, 'Couloir'],
      [point(7).device, 'Salon'],
      [output(3).device, 'Sirene'],
    ],
  );
  for (const d of gladys.fake.discoveredDevices) {
    for (const f of d.features) {
      assert.notEqual(f.category, 'switch', `${f.external_id}: never a switch`);
      if (f.read_only === false) {
        assert.deepEqual([f.category, f.type], ['button', 'push'], `${f.external_id}: a button`);
      }
    }
  }
  assert.equal(ctx.device(point(2).device).features[0].category, 'motion-sensor');
  assert.equal(ctx.device(point(1).device).features[0].category, 'opening-sensor');
  assert.equal(ctx.device(panelIds.device).model, 'B5512');
  assert.deepEqual(
    ctx.device(panelIds.device).params.map((p) => p.name),
    ['model', 'firmware', 'serial'],
  );
  assert.equal(ctx.state(area(1).feature('mode')), 'Disarmed');
  assert.equal(ctx.state(area(1).feature('armed')), 0);
  assert.equal(ctx.state(area(1).feature('alarm')), 0);
  assert.equal(ctx.state(point(1).feature('opening')), 1, 'opening: 1 = closed (core)');
  assert.equal(ctx.state(point(2).feature('motion')), 0);
  assert.equal(ctx.state(output(3).feature('state')), 0);
  assert.equal(ctx.state(panelIds.feature('online')), 1);
  assert.equal(ctx.state(panelIds.feature('trouble')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /B5512 panel, area\(s\) \(1: disarmed, 2: disarmed\), 3 point\(s\), 1 output/,
  );
  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'local'));
  assert.equal(ctx.panel.sent(0x5f).length, 1, 'subscribed once');
  assert.equal(ctx.panel.maxOpen, 1, 'one connection');
  noCodeInLogs(ctx, CODE);
});

test('updates of the panel become states and scene events', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const { area, point, panelIds } = ctx;
  ctx.panel.setPoint(1, 0x02);
  ctx.panel.setReady(1, 0x02);
  ctx.panel.setFaults(1 << 5);
  await flush(ctx);
  assert.equal(ctx.state(point(1).feature('opening')), 0, 'open');
  assert.equal(ctx.state(area(1).feature('ready')), 1);
  assert.equal(ctx.state(panelIds.feature('ac-failure')), 1);
  assert.equal(ctx.state(panelIds.feature('trouble')), 1);
  // Armed from a keypad: exit delay first, then armed.
  ctx.panel.setArea(1, 0x07);
  await flush(ctx);
  assert.equal(ctx.state(area(1).feature('mode')), 'Arming');
  assert.equal(ctx.events().length, 0, 'no event for an exit delay');
  ctx.panel.setArea(1, 0x01);
  await flush(ctx);
  assert.equal(ctx.state(area(1).feature('mode')), 'Armed (away)');
  assert.deepEqual(ctx.events().at(-1), {
    key: 'armed',
    data: { area: '1', mode: 'armed_away', by_gladys: false },
  });
  // Entry delay, then a burglary alarm on point 1.
  ctx.panel.setArea(1, 0x05);
  ctx.panel.setAlarm(7, [{ area: 1, point: 1 }]);
  await until(() => ctx.events().some((e) => e.key === 'alarm_triggered'));
  assert.deepEqual(ctx.events().at(-1), {
    key: 'alarm_triggered',
    data: { area: '1', point: 1, fire: false },
  });
  assert.equal(ctx.state(area(1).feature('alarm')), 1);
  assert.equal(ctx.state(area(1).feature('mode')), 'Entry delay');
  // Disarmed at the keypad: one disarmed event, the alarm memory stays but is no longer "in progress".
  ctx.panel.setArea(1, 0x04);
  await flush(ctx);
  assert.deepEqual(ctx.events().at(-1), { key: 'disarmed', data: { area: '1', by_gladys: false } });
  assert.equal(ctx.state(area(1).feature('alarm')), 0);
  assert.equal(ctx.events().filter((e) => e.key === 'armed').length, 1, 'one event per arming');
});

test('a fire alarm while disarmed: alarm_triggered with fire, point null when unknown', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.setAlarm(10, [{ area: 2, point: 0 }]);
  await until(() => ctx.events().some((e) => e.key === 'alarm_triggered'));
  assert.deepEqual(ctx.events().at(-1), {
    key: 'alarm_triggered',
    data: { area: '2', point: null, fire: true },
  });
  assert.equal(ctx.state(ctx.area(2).feature('fire-alarm')), 1);
});

test('arm away: decided on the area read now, sent, credited to Gladys', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const before = ctx.panel.log.length;
  const ack = await ctx.press(ctx.area(1), 'arm-away');
  assert.equal(ack.success, true, ack.error);
  const sent = ctx.panel.log.slice(before).map((e) => e.cmd);
  assert.deepEqual(sent.slice(0, 2), [0x26, 0x27], 'the area read, then the arming');
  const command = ctx.panel.sent(0x27).at(-1);
  assert.deepEqual([...command.data], [0x03, 0x80], 'master delay, area 1');
  await until(() => ctx.events().some((e) => e.key === 'armed'));
  assert.deepEqual(ctx.events().at(-1).data, { area: '1', mode: 'armed_away', by_gladys: true });
  assert.equal(ctx.state(ctx.area(1).feature('mode')), 'Armed (away)');
  // Already armed: nothing sent.
  assert.equal((await ctx.press(ctx.area(1), 'arm-away')).success, true);
  assert.equal(ctx.panel.sent(0x27).length, 1);
  noCodeInLogs(ctx, CODE);
});

test('the memory never decides: the area read before the command does', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  // Armed at the keypad, the update lost: Gladys still shows disarmed.
  ctx.panel.areas.get(1).status = 0x01;
  assert.equal(ctx.state(ctx.area(1).feature('mode')), 'Disarmed');
  assert.equal((await ctx.press(ctx.area(1), 'arm-away')).success, true);
  assert.equal(ctx.panel.sent(0x27).length, 0, 'already armed on the panel: nothing sent');
});

test('arm stay on a Solution panel: user code login, stay 1, area 2 mask', async (t) => {
  const ctx = await setup(t, {
    config: { automation_code: '', user_code: '1234' },
    panel: { model: 0x20 },
  });
  await up(ctx);
  assert.deepEqual([...ctx.panel.sent(0x3e)[0].data], [0x12, 0x34, 0xff, 0xff]);
  assert.equal(ctx.panel.sent(0x06).length, 0, 'no automation code for Solution');
  const ack = await ctx.press(ctx.area(2), 'arm-stay');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual([...ctx.panel.sent(0x27).at(-1).data], [0x0a, 0x40]);
  noCodeInLogs(ctx, '1234');
});

test('AMAX: installer-app login with the automation code, then the installer code', async (t) => {
  const ctx = await setup(t, {
    config: { user_code: '987654' },
    panel: { model: 0x24, userCode: '987654' },
  });
  await up(ctx);
  assert.equal(ctx.panel.sent(0x06)[0].data[0], 0x00, 'user type: installer app');
  assert.equal(ctx.panel.sent(0x3e).length, 1);
  assert.equal(ctx.device(ctx.panelIds.device).model, 'AMAX 4000');
});

test('disarm is off by default: refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.setArea(1, 0x01);
  await flush(ctx);
  const ack = await ctx.press(ctx.area(1), 'disarm');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Disarming from Gladys is disabled.*nothing was sent/);
  assert.equal(ctx.panel.sent(0x27).length, 0);
  // Away -> stay lowers the protection: the disarm option too.
  const stay = await ctx.press(ctx.area(1), 'arm-stay');
  assert.equal(stay.success, false);
  assert.match(stay.error, /lowers the protection/);
  assert.equal(ctx.panel.sent(0x27).length, 0);
  // Stay -> away is more protection: always allowed.
  ctx.panel.setArea(2, 0x03);
  await flush(ctx);
  assert.equal((await ctx.press(ctx.area(2), 'arm-away')).success, true);
  assert.equal(ctx.panel.sent(0x27).length, 1);
});

test('disarm allowed: sent after a fresh read; by scene too', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.setArea(1, 0x01);
  await flush(ctx);
  const ack = await ctx.press(ctx.area(1), 'disarm');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual([...ctx.panel.sent(0x27).at(-1).data], [0x01, 0x80]);
  await until(() => ctx.events().some((e) => e.key === 'disarmed'));
  assert.deepEqual(ctx.events().at(-1).data, { area: '1', by_gladys: true });
  ctx.panel.setArea(2, 0x03);
  await flush(ctx);
  const result = await ctx.gladys.fake.sceneAction('disarm', { area: '2' });
  assert.equal(result.success, true, result.error);
  assert.deepEqual([...ctx.panel.sent(0x27).at(-1).data], [0x01, 0x40]);
});

test('an option switched off while the command waits blocks it', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.setArea(1, 0x01);
  await flush(ctx);
  // The fresh read hangs a little; the option goes off meanwhile.
  let release;
  ctx.panel.hold = (cmd) => cmd === 0x26 && !release;
  const pending = ctx.press(ctx.area(1), 'disarm');
  await settle();
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_disarm: false });
  release = true;
  ctx.panel.hold = () => false;
  // Answer the held read by hand.
  ctx.panel.current.answer([0xfe, 0, 1, 0x01]);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled/);
  assert.equal(ctx.panel.sent(0x27).length, 0);
});

test('an arming withdraws a disarm of the same area still waiting', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.setArea(1, 0x01);
  ctx.panel.setArea(2, 0x01);
  await flush(ctx);
  const first = ctx.app.disarm(2);
  const second = ctx.app.disarm(1);
  const arm = ctx.app.arm(1, 'armed_away');
  const results = await Promise.allSettled([first, second, arm]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /arming of this area was asked/);
  assert.equal(results[2].status, 'fulfilled', 'already armed: nothing to send');
  assert.deepEqual(
    ctx.panel.sent(0x27).map((e) => [...e.data]),
    [[0x01, 0x40]],
  );
});

test('outputs: off by default; allowed, decided on the outputs read now', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const refused = await ctx.press(ctx.output(3), 'turn-on');
  assert.equal(refused.success, false);
  assert.match(refused.error, /Controlling outputs from Gladys is disabled/);
  assert.equal(ctx.panel.sent(0x32).length, 0);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_outputs: true });
  const ack = await ctx.press(ctx.output(3), 'turn-on');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual([...ctx.panel.sent(0x32).at(-1).data], [3, 1]);
  await until(() => ctx.state(ctx.output(3).feature('state')) === 1);
  assert.equal((await ctx.press(ctx.output(3), 'turn-on')).success, true);
  assert.equal(ctx.panel.sent(0x32).length, 1, 'already on: nothing sent');
});

test('a NACK is a refusal with its meaning; no answer is "sent, without confirmation"', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.rejectCode = 0x08;
  const refused = await ctx.press(ctx.area(1), 'arm-away');
  assert.equal(refused.success, false);
  assert.match(refused.error, /cannot arm now/);
  ctx.panel.rejectCode = undefined;
  ctx.panel.hold = (cmd) => cmd === 0x27;
  const silent = await ctx.press(ctx.area(1), 'arm-away');
  assert.equal(silent.success, false);
  assert.match(silent.error, /Sent to the panel.*without confirmation/);
  assert.doesNotMatch(silent.error, /nothing was sent/);
});

test('a code refused at login: stopped, persisted, never sent again by itself', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { automation_code: 'Wrong123' }, store });
  await until(() => ctx.store.data?.codeStop);
  await ctx.app.chain;
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the code at login/);
  // Long after: still one login only (no reconnection loop).
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.panel.logins.length, 1);
  noCodeInLogs(ctx, 'Wrong123');
  assert.doesNotMatch(JSON.stringify(ctx.store.data), /Wrong123/);
  // "Test the connection" does not send it either.
  const test1 = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(test1.success, false);
  assert.equal(ctx.panel.logins.length, 1);
  // A restart (same configuration, same /data): not connecting.
  ctx.app.stop();
  const again = await setup(t, { config: { automation_code: 'Wrong123' }, store });
  await settle();
  await again.app.chain;
  assert.equal(again.panel.logins.length, 0, 'never sent after a restart');
  // One click: one new try.
  const click = await again.gladys.fake.action('allow_code_retry', {});
  assert.equal(click.success, true, click.error);
  await until(() => again.panel.logins.length === 1);
  await until(() => again.store.data?.codeStop);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(again.panel.logins.length, 1, 'refused again: stopped again');
  // A new code lifts the stop and logs in.
  await again.gladys.fake.configUpdated({ ...BASE });
  await until(() => again.app.online);
  assert.equal(again.store.data.codeStop, null);
});

test('a code missing for the family stops without a loop; "max connections" waits', async (t) => {
  const ctx = await setup(t, { config: { automation_code: '', user_code: '1234' } });
  await until(() =>
    /B and G series panels need the automation code/.test(
      ctx.gladys.fake.connectionStatus?.message?.en ?? '',
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.panel.sockets.length, 1);
  assert.equal(ctx.panel.logins.length, 0, 'no code sent to the wrong family');
  const busy = await setup(t, { panel: { maxConnections: true } });
  await until(() =>
    /no free automation connection/.test(busy.gladys.fake.connectionStatus?.message?.en ?? ''),
  );
  assert.match(busy.gladys.fake.connectionStatus.message.en, /Next try in 60 s/);
  assert.equal(busy.store.data, null, 'not a refused code');
});

test('a panel without subscription is polled', async (t) => {
  const ctx = await setup(t, { panel: { subscription: false } });
  await up(ctx);
  assert.equal(ctx.panel.sent(0x5f).length, 0);
  ctx.panel.points.get(7).status = 0x02;
  await until(() => ctx.state(ctx.point(7).feature('opening')) === 0, 6_000);
});

test('Gladys restarted: status and devices sent again, codes stop kept', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const fake = ctx.gladys.fake;
  const discoveries = fake.bodies('POST', '/discovered_device').length;
  const statuses = fake.connectionStatuses.length;
  await ctx.app.connected(await ctx.gladys.getConfig());
  assert.equal(fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  assert.equal(fake.connectionStatuses.length, statuses + 1);
  assert.equal(fake.connectionStatus.connected, true);
});

test('the connection lost: only the link state; then back', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.drop();
  await until(() => !ctx.app.online);
  await ctx.app.chain;
  assert.equal(ctx.state(ctx.panelIds.feature('online')), 0);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.ok(ctx.gladys.fake.transports.some((e) => e.transport === 'unreachable'));
});

test('a press of another value, or of a read-only feature, is refused', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  assert.equal((await ctx.press(ctx.area(1), 'arm-away', 0)).success, false);
  assert.equal((await ctx.press(ctx.area(1), 'mode', 1)).success, false);
  const scene = await ctx.gladys.fake.sceneAction('arm', { area: '9', mode: 'armed_away' });
  assert.equal(scene.success, false);
  assert.match(scene.error, /Area 9 is not on the panel/);
  assert.equal(ctx.panel.sent(0x27).length, 0);
});
