// -----------------------------------------------------------------------------
// The panel model -> Gladys devices and states (pure).
//
// Ids that do not depend on the panel address (a new DHCP lease keeps the
// devices) and that the panel itself numbers; one panel per integration:
// - `ext:<selector>:panel:bosch`: link, trouble, AC failure, battery;
// - `ext:<selector>:area:<n>`: state (read-only text), armed, ready to arm,
//   alarm in progress, fire alarm memory, and the arm away / arm stay /
//   disarm BUTTONS;
// - `ext:<selector>:point:<n>`: one state feature keyed by the point kind
//   (`:opening`, `:motion`, `:smoke` or `:leak`);
// - `ext:<selector>:output:<n>`: on (read-only), and the turn on / turn off
//   BUTTONS.
//
// No command is a switch or a binary: a "turn everything off" (voice
// assistants, HomeKit, scenes on switches) must never reach the alarm or an
// output (a siren, a gate, a lock). The states are read-only, the commands
// are push buttons.
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that the panel no longer gives are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { OPENING_SENSOR_STATE } from './constants.js';
import {
  ALARM_PRIORITIES,
  FAULT,
  PRIORITY,
  READY,
  areaMode,
  isArmed,
  pointOpen,
} from './bosch/protocol.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

const binary = (category, type) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const PANEL_FEATURES = {
  online: binary(C.INPUT, T.INPUT.BINARY),
  trouble: binary(C.INPUT, T.INPUT.BINARY),
  'ac-failure': binary(C.INPUT, T.INPUT.BINARY),
  'battery-low': binary(C.INPUT, T.INPUT.BINARY),
};

export const AREA_FEATURES = {
  mode: {
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    // A text history is not charted; the armed / disarmed events are the history.
    keep_history: false,
  },
  armed: binary(C.INPUT, T.INPUT.BINARY),
  ready: binary(C.INPUT, T.INPUT.BINARY),
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  'fire-alarm': binary(C.SIREN, T.SIREN.BINARY),
  'arm-away': button,
  'arm-stay': button,
  disarm: button,
};

/** The state feature of a point, by kind (the kind is also its feature key). */
export const POINT_STATE = {
  opening: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
  motion: binary(C.MOTION_SENSOR, T.SENSOR.BINARY),
  smoke: binary(C.SMOKE_SENSOR, T.SENSOR.BINARY),
  leak: binary(C.LEAK_SENSOR, T.SENSOR.BINARY),
};

export const OUTPUT_FEATURES = {
  state: binary(C.INPUT, T.INPUT.BINARY),
  'turn-on': button,
  'turn-off': button,
};

export const ids = {
  panel: (gladys) => gladys.externalIds('panel', 'bosch'),
  area: (gladys, n) => gladys.externalIds('area', String(n)),
  point: (gladys, n) => gladys.externalIds('point', String(n)),
  output: (gladys, n) => gladys.externalIds('output', String(n)),
};

/** `ext:sel:area:2:arm-away` -> { kind: 'area', number: 2, key: 'arm-away' }. */
export function parseFeatureId(externalId) {
  const match = /:(panel|area|point|output):([a-z0-9]+):([a-z-]+)$/.exec(String(externalId ?? ''));
  if (!match) return undefined;
  return {
    kind: match[1],
    number: match[1] === 'panel' ? undefined : Number(match[2]),
    key: match[3],
  };
}

const feature = (deviceIds, key, name, definition) => ({
  name,
  external_id: deviceIds.feature(key),
  ...definition,
});

/** The kind of a point: the configured one, else an opening. */
export const pointKind = (config, n) => config.pointKinds.get(n) ?? 'opening';

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const panel = model.panel ?? {};
  const params = [
    panel.model && { name: 'model', value: panel.model },
    panel.firmware && { name: 'firmware', value: panel.firmware },
    panel.serial && { name: 'serial', value: panel.serial },
  ].filter(Boolean);
  const panelIds = ids.panel(gladys);
  const devices = [
    {
      name: word(DEVICE_NAMES.panel, language),
      external_id: panelIds.device,
      ...(panel.model ? { model: panel.model } : {}),
      should_poll: false,
      params,
      features: Object.entries(PANEL_FEATURES).map(([key, definition]) =>
        feature(panelIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    },
  ];
  for (const [n, area] of model.areas) {
    const areaIds = ids.area(gladys, n);
    devices.push({
      name: area.name || word(DEVICE_NAMES.area, language)(n),
      external_id: areaIds.device,
      should_poll: false,
      params: [{ name: 'area', value: String(n) }],
      features: Object.entries(AREA_FEATURES).map(([key, definition]) =>
        feature(areaIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    });
  }
  for (const [n, point] of model.points) {
    const pointIds = ids.point(gladys, n);
    const kind = pointKind(config, n);
    devices.push({
      name: point.name || word(DEVICE_NAMES.point, language)(n),
      external_id: pointIds.device,
      should_poll: false,
      params: [
        { name: 'point', value: String(n) },
        { name: 'kind', value: kind },
      ],
      features: [
        feature(pointIds, kind, word(FEATURE_NAMES.kind[kind], language), POINT_STATE[kind]),
      ],
    });
  }
  for (const [n, output] of model.outputs) {
    const outputIds = ids.output(gladys, n);
    devices.push({
      name: output.name || word(DEVICE_NAMES.output, language)(n),
      external_id: outputIds.device,
      should_poll: false,
      params: [{ name: 'output', value: String(n) }],
      features: Object.entries(OUTPUT_FEATURES).map(([key, definition]) =>
        feature(outputIds, key, word(FEATURE_NAMES[key], language), definition),
      ),
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

/** The priorities of the alarm memory that list this area. */
const priorities = (model, n) => {
  const found = new Set();
  for (const [priority, records] of model.alarms ?? new Map()) {
    if (records.some((r) => r.area === n)) found.add(priority);
  }
  return found;
};

/**
 * What the alarm side of an area says: `mode` (undefined: unknown),
 * `alarm` (armed or in entry delay, with a burglary, gas or fire alarm in
 * memory: the reference's "triggered"), `fire` (a fire alarm in memory,
 * armed or not), `point` (the first point of that alarm, if the panel said).
 */
export function areaStatus(model, n) {
  const area = model.areas.get(n);
  const mode = areaMode(area?.status);
  const found = priorities(model, n);
  const alarm = mode !== undefined && isArmed(mode) && ALARM_PRIORITIES.some((p) => found.has(p));
  const fire = found.has(PRIORITY.FIRE_ALARM);
  let point;
  for (const priority of [PRIORITY.FIRE_ALARM, PRIORITY.GAS_ALARM, PRIORITY.BURGLARY_ALARM]) {
    const record = model.alarms?.get(priority)?.find((r) => r.area === n && r.point > 0);
    if (record) {
      point = record.point;
      break;
    }
  }
  return { known: mode !== undefined, mode, alarm, fire, point };
}

/** Every known state: `[{ device_feature_external_id, state | text }]`. */
export function buildStates(gladys, config, model, { online }) {
  const states = [];
  const push = (deviceIds, key, value) => {
    if (value === undefined) return;
    states.push({
      device_feature_external_id: deviceIds.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  const panel = ids.panel(gladys);
  push(panel, 'online', flag(online));
  // Offline, the model is the last one seen, not the panel's: only the link is told.
  if (!online) return states;
  if (model.faults !== undefined) {
    push(panel, 'trouble', flag(model.faults !== 0));
    push(panel, 'ac-failure', flag(model.faults & FAULT.AC_FAIL));
    push(panel, 'battery-low', flag(model.faults & (FAULT.BATTERY_LOW | FAULT.BATTERY_MISSING)));
  }
  for (const [n, area] of model.areas) {
    const status = areaStatus(model, n);
    if (!status.known) continue;
    const areaIds = ids.area(gladys, n);
    push(areaIds, 'mode', word(MODE_NAMES[status.mode], config.language));
    push(areaIds, 'armed', flag(isArmed(status.mode)));
    if (area.ready !== undefined) push(areaIds, 'ready', flag(area.ready === READY.ALL));
    if (model.alarms.size > 0) {
      push(areaIds, 'alarm', flag(status.alarm));
      push(areaIds, 'fire-alarm', flag(status.fire));
    }
  }
  for (const [n, point] of model.points) {
    const open = pointOpen(point.status);
    if (open === undefined) continue;
    const kind = pointKind(config, n);
    const pointIds = ids.point(gladys, n);
    if (kind === 'opening') {
      push(pointIds, kind, open ? OPENING_SENSOR_STATE.OPEN : OPENING_SENSOR_STATE.CLOSE);
    } else {
      push(pointIds, kind, flag(open));
    }
  }
  for (const [n, output] of model.outputs) {
    if (output.active !== undefined) push(ids.output(gladys, n), 'state', flag(output.active));
  }
  return states;
}
