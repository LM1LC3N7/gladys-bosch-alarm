// The approval round of review 1 (R1 to R5, scenarios s9 and s10), as tests.
// The waits are shortened here (this file runs in its own process).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BoschApp } from '../src/app.js';
import { BoschClient } from '../src/bosch/client.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore, memoryStore } from '../src/store.js';
import { FakePanel, quietLogger, settle, until } from './helpers/fakeBosch.js';

const SAVED = { ...TIMINGS, backoff: [...TIMINGS.backoff] };
TIMINGS.sessionGap = 0;
TIMINGS.backoff = [30, 60, 90, 120, 150];
TIMINGS.fastReconnect = 100;
test.after(() => Object.assign(TIMINGS, SAVED));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = { host: '192.0.2.30', automation_code: 'Gladys2026', language: 'en' };

async function setup(t, { config = {}, store, early } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config } });
  const panel = new FakePanel();
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new BoschApp({ gladys, logger, connect: panel.connect, store: memory, settleMs: 0 });
  registerHandlers(gladys, app, logger);
  const before = early ? app.configUpdated({ ...BASE, ...config }) : undefined;
  await gladys.connect();
  await before;
  t.after(() => app.stop({ final: true }));
  return { gladys, panel, app, logger, store: memory };
}

const status = (ctx) => ctx.gladys.fake.connectionStatus?.message?.en ?? '';

test('R1 (s9): a stale refusal, told after the code was fixed, never sets the stop again', async (t) => {
  const ctx = await setup(t);
  await until(() => ctx.app.online);
  await ctx.app.chain;
  const publish = ctx.gladys.publishSceneEvent.bind(ctx.gladys);
  ctx.gladys.publishSceneEvent = async (...args) => {
    await sleep(1_000);
    return publish(...args);
  };
  ctx.panel.setArea(1, 0x01); // the 'armed' event holds the chain
  await sleep(50);
  await ctx.gladys.fake.configUpdated({ ...BASE, automation_code: 'Wrong999' });
  await until(() => ctx.app.codeStopped(), 2_000);
  await ctx.gladys.fake.configUpdated({ ...BASE });
  await until(() => ctx.app.client.connected, 2_000);
  await sleep(1_500); // the stale 'down' of the refusal runs now
  await ctx.app.chain;
  assert.equal(ctx.app.codeStopped(), false);
  assert.equal(ctx.store.data?.codeStop ?? null, null);
  assert.doesNotMatch(status(ctx), /refused the code/);
});

test('R2 (s10): a config_updated before the first start never lifts a persisted stop', async (t) => {
  const store = memoryStore({ codeStop: { at: 1 } });
  const ctx = await setup(t, { config: { automation_code: 'Wrong999' }, store, early: true });
  await sleep(300);
  await settle();
  assert.equal(ctx.panel.logins.length, 0);
  assert.ok(ctx.store.data.codeStop, 'still stopped');
});

test('R3: an unreadable answer to a command brings the session back fast', async (t) => {
  const panel = new FakePanel();
  const respond = panel.respond.bind(panel);
  panel.respond = (socket, cmd, body) => (cmd === 0x27 ? [0x42] : respond(socket, cmd, body));
  const client = new BoschClient({ connect: panel.connect });
  client.configure({ host: 'h', port: 7700, automationCode: panel.automationCode });
  const downs = [];
  client.on('down', (info) => downs.push(info));
  t.after(() => client.stop());
  client.start();
  await until(() => client.connected);
  await assert.rejects(client.arm(1, 0x03), (err) => err.kind === 'unexpected' && err.sent);
  assert.equal(downs[0].retryIn, TIMINGS.fastReconnect);
});

test('R4: a stop during a login leaves no login pending', async (t) => {
  const panel = new FakePanel();
  panel.hold = (cmd) => cmd === 0x06;
  const client = new BoschClient({ connect: panel.connect });
  client.configure({ host: 'h', port: 7700, automationCode: panel.automationCode });
  t.after(() => client.stop());
  client.start();
  await until(() => panel.logins.length === 1);
  assert.equal(client.loginPending, true);
  client.stop();
  assert.equal(client.loginPending, false);
  assert.equal(client.loginDoubts, 0, 'a stop is no doubt on the code');
});

test('R5: an unreadable state file is told as such, not as a refused code', async (t) => {
  const dir = new URL(`../data/test-r5-${process.pid}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = new URL('state.json', dir);
  await writeFile(path, '{garbage');
  const ctx = await setup(t, { store: fileStore(path) });
  await until(() => /cannot be read/.test(status(ctx)));
  assert.doesNotMatch(status(ctx), /refused the code at login/);
  assert.equal(ctx.panel.logins.length, 0);
});
