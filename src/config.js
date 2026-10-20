// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, POINT_KINDS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  allow_disarm: false,
  allow_outputs: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.40`, `panel.lan:7700`, `tls://192.168.1.40` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** The automation passcode: printable ASCII without spaces, 1 to 32 characters. */
export const normalizeAutomationCode = (raw) => {
  const text = String(raw ?? '').trim();
  return new RegExp(`^[\\x21-\\x7e]{1,${LIMITS.maxAutomationCode}}$`).test(text) ? text : '';
};

/** A Solution user code or an AMAX installer code: 1 to 8 digits. */
export const normalizeUserCode = (raw) => {
  const text = String(raw ?? '').trim();
  return new RegExp(`^\\d{1,${LIMITS.maxUserCode}}$`).test(text) ? text : '';
};

/**
 * `7:motion, 9-10:smoke` -> Map(point -> kind). Entries are separated by
 * commas, semicolons or new lines; `=` works like `:`. Wrong entries are
 * reported, not fatal.
 */
export function parsePointKinds(raw) {
  const kinds = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*[:=]\s*([a-z]+)$/i.exec(text);
    const kind = match?.[3]?.toLowerCase();
    const from = Number(match?.[1]);
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || from < 1 || to > LIMITS.maxPoints || to < from || !POINT_KINDS.includes(kind)) {
      errors.push(text.slice(0, 40));
      continue;
    }
    for (let n = from; n <= to; n += 1) kinds.set(n, kind);
  }
  return { kinds, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const typedAutomation = String(raw?.automation_code ?? '').trim();
  const typedUser = String(raw?.user_code ?? '').trim();
  const points = parsePointKinds(raw?.point_kinds);
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    automationCode: normalizeAutomationCode(typedAutomation),
    automationCodeInvalid:
      typedAutomation !== '' && normalizeAutomationCode(typedAutomation) === '',
    userCode: normalizeUserCode(typedUser),
    userCodeInvalid: typedUser !== '' && normalizeUserCode(typedUser) === '',
    pointKinds: points.kinds,
    kindErrors: points.errors,
    allowDisarm: bool(raw?.allow_disarm, DEFAULTS.allow_disarm),
    allowOutputs: bool(raw?.allow_outputs, DEFAULTS.allow_outputs),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/**
 * What the session depends on: a change reconnects. It holds the codes (the
 * login uses them): kept in memory only, never logged nor written.
 */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.automationCode, config.userCode]);

/** The codes only: a change lifts the stop on a refused code. Memory only. */
export const codesKey = (config) => JSON.stringify([config.automationCode, config.userCode]);

/** Where the session goes, without any secret. */
export const placeKey = (config) => `${config.host}:${config.port}`;
