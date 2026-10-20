// The scenarios of the first review (s1 to s8) and its minor points, as
// tests: a refused or doubtful code is never sent again without a click,
// arming is never blocked, the publication and the reader stay bounded.
// The waits are shortened here (this file runs in its own process).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BoschApp } from '../src/app.js';
import { BoschClient } from '../src/bosch/client.js';
import { FrameReader } from '../src/bosch/frame.js';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore, memoryStore, normalizeMemory } from '../src/store.js';
import { FakePanel, quietLogger, settle, until } from './helpers/fakeBosch.js';

const SAVED = { ...TIMINGS, backoff: [...TIMINGS.backoff] };
TIMINGS.sessionGap = 0;
TIMINGS.backoff = [30, 60, 90, 120, 150];
TIMINGS.fastReconnect = 100;
TIMINGS.loginTimeout = 100;
test.after(() => Object.assign(TIMINGS, SAVED));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = { host: '192.0.2.30', automation_code: 'Gladys2026', language: 'en' };

async function setup(t, { config = {}, panel: options = {}, store, prepare, settleMs = 0 } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config } });
  const panel = new FakePanel(options);
  prepare?.(panel, gladys);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new BoschApp({ gladys, logger, connect: panel.connect, store: memory, settleMs });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  const device = (id) => gladys.fake.discoveredDevices.find((d) => d.external_id === id);
  const area = (n = 1) => gladys.externalIds('area', String(n));
  const press = (ids, key) => {
    const d = device(ids.device);
    return gladys.fake.setValue(
      d,
      d.features.find((f) => f.external_id === ids.feature(key)),
      1,
    );
  };
  return { gladys, panel, app, logger, store: memory, area, press };
}

const up = async (ctx) => {
  await until(() => ctx.app.online);
  await ctx.app.chain;
  await settle();
};

const status = (ctx) => ctx.gladys.fake.connectionStatus?.message?.en ?? '';

test('s1: a refused code is never sent again by "Test the connection", even with a slow Gladys', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  // Gladys is slow: the 'armed' scene event holds the app's event chain.
  const publish = ctx.gladys.publishSceneEvent.bind(ctx.gladys);
  ctx.gladys.publishSceneEvent = async (...args) => {
    await sleep(1_500);
    return publish(...args);
  };
  ctx.panel.setArea(1, 0x01);
  await sleep(50);
  ctx.panel.automationCode = 'NewOnPanel1';
  await ctx.gladys.fake.configUpdated({ ...BASE, automation_code: 'Wrong999' });
  const wrong = () =>
    ctx.panel.logins.filter(
      (l) => l.cmd === 0x06 && l.data.subarray(1, -1).toString('latin1') === 'Wrong999',
    ).length;
  await until(() => wrong() === 1);
  await sleep(20);
  assert.ok(ctx.app.codeStopped(), 'the stop is set at once, not behind the slow chain');
  const result = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(result.success, false);
  await sleep(1_800);
  assert.equal(wrong(), 1, 'the refused code went once');
  assert.ok(ctx.store.data?.codeStop, 'persisted');
  // Another address does not send it either.
  await ctx.gladys.fake.configUpdated({ ...BASE, host: '192.0.2.31', automation_code: 'Wrong999' });
  await sleep(100);
  assert.equal(wrong(), 1);
});

for (const variant of ['close', 'silence', 'unreadable']) {
  test(`s2: a login answered by ${variant} stops after ${LIMITS.loginDoubts} tries, persisted`, async (t) => {
    const ctx = await setup(t, {
      config: { automation_code: 'Wrong999' },
      prepare: (panel) => {
        const respond = panel.respond.bind(panel);
        panel.respond = (socket, cmd, body) => {
          if (cmd !== 0x06) return respond(socket, cmd, body);
          if (variant === 'close') queueMicrotask(() => socket.destroy());
          if (variant === 'unreadable') return [0x42];
          return undefined;
        };
      },
    });
    await until(() => ctx.store.data?.codeStop);
    await ctx.app.chain;
    await sleep(400);
    assert.equal(ctx.panel.logins.length, LIMITS.loginDoubts);
    assert.equal(ctx.store.data.codeStop.doubtful, true);
    assert.match(status(ctx), /never answered the login clearly/);
    // One click: one more try only.
    await ctx.gladys.fake.action('allow_code_retry', {});
    await until(() => ctx.store.data?.codeStop);
    await sleep(400);
    assert.equal(ctx.panel.logins.length, LIMITS.loginDoubts + 1);
  });
}

test('s3: an arming asked during a disarm in progress withdraws it; the area stays armed', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true } });
  await up(ctx);
  ctx.panel.setArea(1, 0x01);
  await sleep(50);
  let holdRead = true;
  ctx.panel.hold = (cmd, body) => (cmd === 0x26 && holdRead) || (cmd === 0x27 && body[0] === 0x01);
  const disarm = ctx.press(ctx.area(1), 'disarm');
  await sleep(500);
  const arm = ctx.press(ctx.area(1), 'arm-away');
  await sleep(2_000);
  holdRead = false;
  ctx.panel.current.answer([0xfe, 0, 1, 0x01]);
  const [d, a] = await Promise.all([disarm, arm]);
  assert.equal(d.success, false);
  assert.match(d.error, /arming of this area was asked/);
  assert.equal(a.success, true, a.error);
  assert.deepEqual(
    ctx.panel.sent(0x27).filter((e) => e.data[0] === 0x01),
    [],
    'no disarm written',
  );
  assert.equal(ctx.panel.areas.get(1).status, 0x01);
});

test('s3 bis: an arming goes before the disarms and outputs waiting', async (t) => {
  const ctx = await setup(t, { config: { allow_disarm: true, allow_outputs: true } });
  await up(ctx);
  ctx.panel.setArea(2, 0x01);
  await sleep(50);
  const order = [];
  const first = ctx.app.disarm(2).then(() => order.push('disarm 2'));
  const output = ctx.app.output(3, true).then(() => order.push('output'));
  const arm = ctx.app.arm(1, 'armed_away').then(() => order.push('arm 1'));
  await Promise.all([first, output, arm]);
  assert.deepEqual(order, ['disarm 2', 'arm 1', 'output']);
});

test('s4: the frame reader is linear on tiny chunks; frames over 8 KB are refused', () => {
  const run = (size, chunk) => {
    let frames = 0;
    const errors = [];
    const reader = new FrameReader({
      onAnswer: () => {},
      onStatus: () => {
        frames += 1;
      },
      onError: (why) => errors.push(why),
    });
    const frame = Buffer.alloc(3 + size);
    frame[0] = 0x02;
    frame.writeUInt16BE(size, 1);
    const start = process.hrtime.bigint();
    for (let i = 0; i < frame.length; i += chunk) reader.push(frame.subarray(i, i + chunk));
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, frames, errors };
  };
  const bytes = run(LIMITS.maxFrame, 1);
  assert.equal(bytes.frames, 1);
  assert.ok(bytes.ms < 500, `${bytes.ms} ms for ${LIMITS.maxFrame} one-byte chunks`);
  assert.deepEqual(run(0xffff, 1).errors, ['frame too long']);
});

test('s5: a flood of alarm priorities never blocks an arming', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const receive = ctx.panel.receive.bind(ctx.panel);
  ctx.panel.receive = (socket, cmd, body) => setTimeout(() => receive(socket, cmd, body), 20);
  const records = [];
  for (let p = 1; p <= 255; p += 1) records.push(p, 0x00, 0x01);
  ctx.panel.push([0x01, 255, ...records]);
  await sleep(5);
  assert.ok(ctx.app.client.queue.length <= 2, `${ctx.app.client.queue.length} reads queued`);
  const ack = await ctx.press(ctx.area(1), 'arm-away');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.panel.sent(0x27).length, 1);
  const priorities = new Set(ctx.panel.sent(0x23).map((e) => e.data[0]));
  assert.ok([...priorities].every((p) => p >= 1 && p <= 10));
});

test('s6: a command without an answer: the connection comes back and the state is read again', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.panel.hold = (cmd) => cmd === 0x27;
  const ack = await ctx.press(ctx.area(1), 'arm-away');
  assert.equal(ack.success, false);
  assert.match(ack.error, /read again as soon as it is back/);
  const reads = ctx.panel.sent(0x26).length;
  ctx.panel.hold = () => false;
  await until(() => ctx.app.client.connected && ctx.panel.sent(0x26).length > reads, 2_000);
  const down = ctx.gladys.fake.connectionStatuses.find((s) => s.connected === false);
  assert.ok(down, 'the reset was told');
});

test('s7: the codes never appear in logs, statuses, acks, events or /data', async (t) => {
  const CODES = ['Zq7!Secret', '73915'];
  const seen = [];
  const collect = (ctx) => {
    seen.push(...ctx.logger.lines);
    seen.push(JSON.stringify(ctx.gladys.fake.connectionStatuses));
    seen.push(JSON.stringify(ctx.gladys.fake.sceneEvents));
    seen.push(JSON.stringify(ctx.store.data ?? null));
  };
  const b = await setup(t, {
    config: { automation_code: CODES[0] },
    panel: { automationCode: CODES[0] },
  });
  await up(b);
  b.panel.rejectCode = 0x06;
  seen.push(JSON.stringify(await b.press(b.area(1), 'arm-away')));
  b.panel.rejectCode = undefined;
  seen.push(JSON.stringify(await b.gladys.fake.action('test_connection', {})));
  collect(b);
  const s = await setup(t, {
    config: { automation_code: '', user_code: CODES[1] },
    panel: { model: 0x20, userCode: '1111' },
  });
  await until(() => s.store.data?.codeStop);
  await s.app.chain;
  seen.push(JSON.stringify(await s.gladys.fake.action('test_connection', {})));
  seen.push(JSON.stringify(await s.gladys.fake.action('allow_code_retry', {})));
  await sleep(100);
  const respond = s.panel.respond.bind(s.panel);
  s.panel.respond = (socket, cmd, body) => (cmd === 0x3e ? [0x77] : respond(socket, cmd, body));
  seen.push(JSON.stringify(await s.gladys.fake.action('allow_code_retry', {})));
  await sleep(200);
  collect(s);
  for (const code of CODES) {
    assert.ok(!seen.some((text) => text.includes(code)), `${code} leaked`);
  }
});

test('s8: a flapping point never holds back the states and alarm_triggered', async (t) => {
  const ctx = await setup(t, { settleMs: 250 });
  await up(ctx);
  await sleep(400);
  let open = false;
  const flapper = setInterval(() => {
    open = !open;
    ctx.panel.setPoint(7, open ? 0x02 : 0x03);
  }, 150);
  t.after(() => clearInterval(flapper));
  ctx.panel.setArea(1, 0x01);
  await sleep(400);
  ctx.panel.setArea(1, 0x05);
  ctx.panel.setAlarm(7, [{ area: 1, point: 1 }]);
  await until(() => ctx.gladys.fake.sceneEvents.some((e) => e.key === 'alarm_triggered'), 2_000);
  clearInterval(flapper);
});

test('minor 2: an unreadable or oversized stop file counts as a stop; a failed save is told', async (t) => {
  const dir = new URL(`../data/test-store-${process.pid}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = (name) => new URL(name, dir);
  assert.equal(await fileStore(path('none.json')).load(), null);
  await writeFile(path('garbage.json'), '{not json');
  assert.ok(normalizeMemory(await fileStore(path('garbage.json')).load()).codeStop);
  await writeFile(path('big.json'), ' '.repeat(5000));
  assert.ok(normalizeMemory(await fileStore(path('big.json')).load()).codeStop);
  const broken = {
    load: async () => null,
    save: async () => {
      throw new Error('read-only file system');
    },
  };
  const ctx = await setup(t, { config: { automation_code: 'Wrong999' }, store: broken });
  await until(() => /could not be written to \/data/.test(status(ctx)));
  assert.equal(ctx.panel.logins.length, 1);
});

test('minor 3: "Test the connection" never jumps the wait of a planned new try', async (t) => {
  const ctx = await setup(t, { panel: { maxConnections: true } });
  await until(() => /no free automation connection/.test(status(ctx)));
  const sockets = ctx.panel.sockets.length;
  const result = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(result.success, false);
  assert.match(result.error, /no free automation connection/);
  assert.equal(ctx.panel.sockets.length, sockets);
});

test('minor 4: a request is never written after its sendBy, even if its timer is late', async (t) => {
  const panel = new FakePanel();
  let offset = 0;
  const client = new BoschClient({ connect: panel.connect, now: () => Date.now() + offset });
  client.configure({ host: 'h', port: 7700, automationCode: panel.automationCode });
  t.after(() => client.stop());
  client.start();
  await until(() => client.connected);
  const reads = panel.sent(0x26).length;
  panel.hold = (cmd) => cmd === 0x01;
  const blocker = client.request(0x01, [], { timeout: 60_000 }).catch(() => undefined);
  const late = client.request(0x26, [0, 1], { sendBy: Date.now() + 1_000 });
  offset = 5_000; // the clock jumped, the deadline timer did not fire yet
  panel.current.answer([0xfc]);
  await assert.rejects(late, (err) => err.kind === 'late');
  await blocker;
  assert.equal(panel.sent(0x26).length, reads);
});

test('minor 6: a session that drops right after it came up counts as a failure', async (t) => {
  const panel = new FakePanel();
  const client = new BoschClient({ connect: panel.connect });
  client.configure({ host: 'h', port: 7700, automationCode: panel.automationCode });
  const downs = [];
  client.on('down', (info) => downs.push(info));
  t.after(() => client.stop());
  client.on('up', () => queueMicrotask(() => panel.drop()));
  client.start();
  await until(() => downs.length >= 3);
  client.stop();
  assert.deepEqual(
    downs.slice(0, 3).map((d) => d.retryIn),
    [30, 60, 90],
    'the waits grow',
  );
});
