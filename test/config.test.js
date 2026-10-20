import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  codesKey,
  normalizeConfig,
  parseHost,
  parsePointKinds,
  placeKey,
  sessionKey,
} from '../src/config.js';

test('defaults: disarm and outputs off, port 7700', () => {
  const config = normalizeConfig({});
  assert.equal(config.port, 7700);
  assert.equal(config.allowDisarm, false);
  assert.equal(config.allowOutputs, false);
  assert.equal(config.language, 'fr');
  assert.equal(DEFAULTS.allow_disarm, false);
  // Only a real boolean switches an option on.
  assert.equal(normalizeConfig({ allow_disarm: 'true' }).allowDisarm, false);
  assert.equal(normalizeConfig({ allow_outputs: 1 }).allowOutputs, false);
});

test('the address, with or without a port', () => {
  assert.deepEqual(parseHost('192.168.1.40'), { host: '192.168.1.40', port: undefined });
  assert.deepEqual(parseHost('tls://panel.lan:7701/'), { host: 'panel.lan', port: 7701 });
  assert.deepEqual(parseHost('[fe80::1]:7700'), { host: 'fe80::1', port: 7700 });
  assert.equal(parseHost('a b').host, '');
  assert.equal(normalizeConfig({ host: 'p:7800', port: 7700 }).port, 7800);
});

test('codes: format checked, never guessed', () => {
  assert.equal(normalizeConfig({ automation_code: ' Ab-12_x ' }).automationCode, 'Ab-12_x');
  const spaced = normalizeConfig({ automation_code: 'a b' });
  assert.equal(spaced.automationCode, '');
  assert.equal(spaced.automationCodeInvalid, true);
  assert.equal(normalizeConfig({ automation_code: 'x'.repeat(33) }).automationCodeInvalid, true);
  assert.equal(normalizeConfig({ user_code: '12345678' }).userCode, '12345678');
  assert.equal(normalizeConfig({ user_code: '123456789' }).userCodeInvalid, true);
  assert.equal(normalizeConfig({ user_code: '12a4' }).userCodeInvalid, true);
  assert.equal(normalizeConfig({}).userCodeInvalid, false);
});

test('point kinds: ranges, separators, errors reported', () => {
  const { kinds, errors } = parsePointKinds('7:motion; 9-10 = smoke\n12:LEAK, 3, 4:fire, 0:motion');
  assert.deepEqual(
    [...kinds],
    [
      [7, 'motion'],
      [9, 'smoke'],
      [10, 'smoke'],
      [12, 'leak'],
    ],
  );
  assert.deepEqual(errors, ['3', '4:fire', '0:motion']);
  // No prototype pollution through a key.
  assert.equal(parsePointKinds('__proto__:motion').kinds.size, 0);
});

test('keys: the codes reconnect, the address is the place', () => {
  const a = normalizeConfig({ host: 'p', automation_code: 'one' });
  const b = normalizeConfig({ host: 'p', automation_code: 'two' });
  assert.notEqual(sessionKey(a), sessionKey(b));
  assert.notEqual(codesKey(a), codesKey(b));
  assert.equal(placeKey(a), placeKey(b));
  assert.doesNotMatch(placeKey(a), /one/);
  assert.equal(
    sessionKey(normalizeConfig({ host: 'p', allow_disarm: true })),
    sessionKey(normalizeConfig({ host: 'p' })),
    'an option applies without reconnecting',
  );
});
