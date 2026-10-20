// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ALLOW_CODE_RETRY: 'allow_code_retry',
};

export const SCENE_ACTIONS = {
  ARM: 'arm',
  DISARM: 'disarm',
};

export const SCENE_TRIGGERS = {
  ALARM_TRIGGERED: 'alarm_triggered',
  ARMED: 'armed',
  DISARMED: 'disarmed',
};

/** Arming modes of a scene action or of an `armed` event (frozen: scenes compare them). */
export const ARM_MODES = ['armed_away', 'armed_stay'];

/**
 * Every mode an area can show: `arming` (exit delay running), `pending`
 * (entry delay running: still armed, someone came in).
 */
export const MODES = ['disarmed', 'arming', 'pending', 'armed_away', 'armed_stay'];

/** How a point shows in Gladys (frozen: stored in the configuration). */
export const POINT_KINDS = ['opening', 'motion', 'smoke', 'leak'];

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** The Mode 2 (automation) port of the Bosch panels. */
export const DEFAULT_PORT = 7700;

export const LIMITS = {
  /** B9512G: 32 areas. */
  maxAreas: 32,
  /** B9512G: 599 points. */
  maxPoints: 600,
  /** B9512G: 599 outputs (the output command carries one byte: 1 to 255). */
  maxOutputs: 600,
  maxCommandOutput: 255,
  /** Characters of an automation passcode (B and G series: 6 to 24). */
  maxAutomationCode: 32,
  /** Digits of a Solution user code or an AMAX installer code. */
  maxUserCode: 8,
  /** Characters kept of a name read from the panel. */
  maxName: 40,
  /** Payload bytes of one frame (16-bit length): anything longer is not ours. */
  maxFrame: 65_535,
  /** Pages of an alarm memory detail (0xFFFF sentinel) before giving up. */
  maxAlarmPages: 20,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the panel and area states may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300); alarm_triggered is never dropped. */
  eventsPerMinute: 120,
  /** Tries of an alarm_triggered event refused by Gladys or the network. */
  alarmEventTries: 3,
  /** Bytes waiting in the socket write buffer before the session is cut (a flood). */
  maxPendingWrite: 64 * 1024,
  /** Areas listed in the connection status before "…". */
  statusAreas: 8,
};

export const TIMINGS = {
  /** TCP + TLS connection to the panel. */
  connectTimeout: 15_000,
  /** One request (the reference waits up to 30 s for the connection only). */
  requestTimeout: 5_000,
  /** A keep-alive (0x01) after this long without a request. */
  keepAlive: 60_000,
  /** Nothing received for this long while connected: the link is dead. */
  watchdog: 150_000,
  /** Waits before reconnecting, in a row (the last one repeats). */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** "Max connections" or an unsupported model: never sooner than this. */
  busyRetry: 60_000,
  unsupportedRetry: 300_000,
  /** Never a new connection sooner than this after the last one closed. */
  sessionGap: 5_000,
  /** Panels without subscriptions are read this often (the reference: every second). */
  poll: 2_000,
  /** The faults are read this often (the event log, which would announce them, is not followed). */
  faultPoll: 60_000,
  /** Everything is read again this often, in case an update was missed. */
  resync: 10 * 60_000,
  /**
   * Gladys waits 5 s for a set_value ack. A command's fresh state must be
   * read by readBy, the command sent by sendBy after it was asked (else
   * refused, nothing sent), and the answer is awaited until answerBy (then
   * "sent, not confirmed").
   */
  readBy: 2_800,
  sendBy: 3_500,
  answerBy: 4_500,
  /** The area or output is read again this long after a command. */
  readBack: 2_000,
  /** A transition seen this long after a Gladys command is credited to it. */
  commandMemory: 5 * 60_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** Waits between two tries of an alarm_triggered event. */
  alarmEventRetry: [5_000, 20_000],
  /** "Test the connection" waits this long for the session (the manifest allows 30 s). */
  testWait: 25_000,
};
