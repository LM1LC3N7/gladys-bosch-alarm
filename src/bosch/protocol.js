// -----------------------------------------------------------------------------
// The Bosch "Mode 2" automation protocol: commands, answers, panel models,
// area, point and output states, alarm priorities, faults. Ported from
// bosch-alarm-mode2 0.4.11 (`const.py`, parts of `panel.py`, MIT, see
// THIRD_PARTY_NOTICES.md).
// -----------------------------------------------------------------------------

export const CMD = {
  // Unauthenticated
  WHAT_ARE_YOU: 0x01,
  AUTHENTICATE: 0x06,
  LOGIN_REMOTE_USER: 0x3e,
  REQUEST_PANEL_SYSTEM_STATUS: 0x20,
  // Alarm memory
  ALARM_MEMORY_SUMMARY: 0x08,
  ALARM_MEMORY_DETAIL: 0x23,
  // Areas
  REQUEST_CONFIGURED_AREAS: 0x24,
  AREA_STATUS: 0x26,
  AREA_ARM: 0x27,
  AREA_TEXT: 0x29,
  // Outputs
  REQUEST_CONFIGURED_OUTPUTS: 0x30,
  OUTPUT_STATUS: 0x31,
  SET_OUTPUT_STATE: 0x32,
  OUTPUT_TEXT: 0x33,
  // Points
  REQUEST_CONFIGURED_POINTS: 0x35,
  POINT_STATUS: 0x38,
  POINT_TEXT: 0x3c,
  // System
  SET_SUBSCRIPTION: 0x5f,
  PRODUCT_SERIAL: 0x4a,
};

/** Some commands take a limited number of ids per request. */
export const REQUEST_MAX = { [CMD.AREA_STATUS]: 50, [CMD.POINT_STATUS]: 66 };

/** First byte of a frame. */
export const FRAME = { BASIC: 0x01, STATUS: 0x02, EXTENDED: 0x04 };

/** First byte of an answer. */
export const ANSWER = { ACK: 0xfc, NACK: 0xfd, DATA: 0xfe };

export const USER_TYPE = { INSTALLER_APP: 0x00, AUTOMATION: 0x01 };

/** Result of AUTHENTICATE (0x06). */
export const AUTH_RESULT = { NOT_AUTHORIZED: 0x00, AUTHORIZED: 0x01, MAX_CONNECTIONS: 0x02 };

export const FAMILY = {
  SOLUTION: 'solution',
  AMAX: 'amax',
  GV4: 'gv4',
  B_SERIES: 'b-series',
  G_SERIES: 'g-series',
};

/** Model byte of WHAT_ARE_YOU -> [name, family]. */
export const MODELS = new Map([
  [0x20, ['Solution 2000', FAMILY.SOLUTION]],
  [0x21, ['Solution 3000', FAMILY.SOLUTION]],
  [0x22, ['AMAX 2100', FAMILY.AMAX]],
  [0x23, ['AMAX 3000', FAMILY.AMAX]],
  [0x24, ['AMAX 4000', FAMILY.AMAX]],
  [0x26, ['Solution 2100', FAMILY.SOLUTION]],
  [0x27, ['Solution 3100', FAMILY.SOLUTION]],
  [0x28, ['Solution 4000', FAMILY.SOLUTION]],
  [0x29, ['Solution 4100', FAMILY.SOLUTION]],
  [0x79, ['D7412GV4', FAMILY.GV4]],
  [0x84, ['D9412GV4', FAMILY.GV4]],
  [0xa0, ['B4512', FAMILY.B_SERIES]],
  [0xa4, ['B5512', FAMILY.B_SERIES]],
  [0xa6, ['B8512G', FAMILY.G_SERIES]],
  [0xa7, ['B9512G', FAMILY.G_SERIES]],
  [0xa8, ['B3512', FAMILY.B_SERIES]],
  [0xa9, ['B6512', FAMILY.B_SERIES]],
]);

/** NACK error codes (0xFD) -> text, for the logs and messages. */
const ERRORS = new Map([
  [0x00, 'non-specific error'],
  [0x01, 'checksum failure'],
  [0x02, 'invalid size / length'],
  [0x03, 'invalid command'],
  [0x04, 'invalid interface state'],
  [0x05, 'data out of range'],
  [0x06, 'no authority'],
  [0x07, 'unsupported command'],
  [0x08, 'cannot arm panel'],
  [0x09, 'invalid remote id'],
  [0x0a, 'invalid licence'],
  [0x0b, 'invalid magic number'],
  [0x0c, 'expired licence'],
  [0x0d, 'expired magic number'],
  [0x0e, 'unsupported format version'],
  [0x11, 'firmware update in progress'],
  [0x12, 'incompatible firmware version'],
  [0x13, 'all points not configured'],
  [0x20, 'execution function no errors'],
  [0x21, 'execution function invalid area'],
  [0x22, 'execution function invalid command'],
  [0x23, 'execution function not authenticated'],
  [0x24, 'execution function invalid user'],
  [0x40, 'execution function parameter incorrect'],
  [0x41, 'execution function sequence wrong'],
  [0x42, 'execution function invalid configuration request'],
  [0x43, 'execution function invalid size'],
  [0x44, 'execution function time out'],
]);

export const NACK = { NO_AUTHORITY: 0x06, CANNOT_ARM: 0x08 };

export const errorName = (code) =>
  ERRORS.get(code) ??
  `error 0x${Number(code ?? 0)
    .toString(16)
    .padStart(2, '0')}`;

/** Area status byte -> mode (undefined: unknown). */
const AREA_MODES = new Map([
  [0x01, 'armed_away'],
  [0x02, 'armed_stay'],
  [0x03, 'armed_stay'],
  [0x04, 'disarmed'],
  [0x05, 'pending'],
  [0x06, 'pending'],
  [0x07, 'arming'],
  [0x08, 'arming'],
  [0x09, 'armed_away'],
  // "Stay 1 On" and "Stay 2 On" of Solution / AMAX panels: armed (not counted
  // as armed by the reference, which only lists 0x02 and 0x03).
  [0x0a, 'armed_stay'],
  [0x0b, 'armed_stay'],
  [0x0c, 'armed_away'],
  [0x0d, 'arming'],
  [0x0e, 'pending'],
]);

export const areaMode = (status) => AREA_MODES.get(status);

/** Armed modes, entry delay included (the area is still armed). */
export const isArmed = (mode) =>
  mode === 'armed_away' || mode === 'armed_stay' || mode === 'pending';

/** Arming types of AREA_ARM (0x27). */
export const ARM_TYPE = {
  DISARM: 0x01,
  MASTER_INSTANT: 0x02,
  MASTER_DELAY: 0x03,
  PERIMETER_INSTANT: 0x04,
  PERIMETER_DELAY: 0x05,
  STAY1: 0x0a,
  STAY2: 0x0b,
  AWAY: 0x0c,
};

/**
 * The arming type of a mode, by family, always with the delays (exit and
 * entry delays as set by the installer): Solution and AMAX use away / stay 1,
 * B, G and GV4 master / perimeter.
 */
export function armType(family, mode) {
  const solutionLike = family === FAMILY.SOLUTION || family === FAMILY.AMAX;
  if (mode === 'armed_away') return solutionLike ? ARM_TYPE.AWAY : ARM_TYPE.MASTER_DELAY;
  if (mode === 'armed_stay') return solutionLike ? ARM_TYPE.STAY1 : ARM_TYPE.PERIMETER_DELAY;
  throw new Error(`Unknown arming mode ${mode}`);
}

/** Point status byte -> open (true), normal (false), anything else unknown. */
export function pointOpen(status) {
  if (status === 0x01 || status === 0x02) return true;
  if (status === 0x03) return false;
  return undefined;
}

export const READY = { NOT: 0x00, PART: 0x01, ALL: 0x02 };

/** Alarm memory priorities (1 to 10). */
export const PRIORITY = {
  BURGLARY_TROUBLE: 0x01,
  BURGLARY_SUPERVISORY: 0x02,
  GAS_TROUBLE: 0x03,
  GAS_SUPERVISORY: 0x04,
  FIRE_TROUBLE: 0x05,
  FIRE_SUPERVISORY: 0x06,
  BURGLARY_ALARM: 0x07,
  PERSONAL_EMERGENCY: 0x08,
  GAS_ALARM: 0x09,
  FIRE_ALARM: 0x0a,
};
export const PRIORITIES = Object.values(PRIORITY);
/** The priorities that make an armed area "triggered" (the reference's is_triggered). */
export const ALARM_PRIORITIES = [PRIORITY.BURGLARY_ALARM, PRIORITY.GAS_ALARM, PRIORITY.FIRE_ALARM];

/** Fault bits of REQUEST_PANEL_SYSTEM_STATUS (0x20). */
export const FAULT = {
  PHONE_LINE: 1 << 1,
  PARAMETER_CRC: 1 << 2,
  BATTERY_LOW: 1 << 3,
  BATTERY_MISSING: 1 << 4,
  AC_FAIL: 1 << 5,
  COMMUNICATION: 1 << 7,
  SDI: 1 << 8,
  USER_CODE_TAMPER: 1 << 9,
  FAIL_TO_CALL_RPS: 1 << 10,
  POINT_BUS: 1 << 13,
  LOG_OVERFLOW: 1 << 14,
  LOG_THRESHOLD: 1 << 15,
};

const supported = (value, masks) => {
  for (const [mask, format] of masks) if (value & mask) return format;
  return 0;
};

/**
 * WHAT_ARE_YOU (0x01) answer -> the model and what the panel supports
 * (section 13.2 of the protocol: the bitmask from byte 23).
 */
export function parseWhatAreYou(data) {
  if (!data || data.length < 7) throw new Error('short answer to "what are you"');
  const code = data[0];
  const known = MODELS.get(code);
  const bits = Buffer.alloc(33);
  data.subarray(23, 23 + 33).copy(bits);
  return {
    code,
    model: known?.[0],
    family: known?.[1],
    protocol: `v${data[5]}.${data[6]}`,
    busy: data.length > 13 ? data[13] : 0,
    caps: {
      serial: Boolean(bits[13] & 0x04),
      status: Boolean(bits[5] & 0x08),
      areaText: supported(bits[7], [
        [0x08, 3],
        [0x20, 1],
      ]),
      outputText: supported(bits[9], [
        [0x10, 3],
        [0x40, 1],
      ]),
      pointText: supported(bits[11], [
        [0x20, 3],
        [0x80, 1],
      ]),
      alarmSummary: supported(bits[2], [
        [0x10, 2],
        [0x20, 1],
      ]),
      subscription: Math.max(supported(bits[24], [[0x40, 2]]), supported(bits[16], [[0x20, 1]])),
    },
  };
}

/** Which codes a family needs, and how the automation user logs in. */
export function credentialsFor(family, { automationCode, userCode }) {
  if (family === FAMILY.SOLUTION) {
    // Solution panels take the user code only.
    if (!userCode) return { problem: 'needUserCode' };
    return { user: userCode };
  }
  if (family === FAMILY.AMAX) {
    // AMAX: the automation code as an "installer app" user, then the installer code.
    if (!userCode || !automationCode) return { problem: 'needBothCodes' };
    return { automation: automationCode, userType: USER_TYPE.INSTALLER_APP, user: userCode };
  }
  // B, G and GV4: the automation code only.
  if (!automationCode) return { problem: 'needAutomationCode' };
  return { automation: automationCode, userType: USER_TYPE.AUTOMATION };
}
