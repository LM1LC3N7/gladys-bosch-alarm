# Bosch Alarm (Mode 2) for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Bosch** alarm panels (Solution 2000/3000/4000, AMAX 2100/3000/4000, B
Series, G Series, GV4), **locally** over Bosch's "Mode 2" automation
protocol (TLS, port 7700).

> **Never tested with a real device.** Unofficial, not affiliated with Bosch.

- Areas (as declared by the panel, with their names): state (disarmed,
  arming, entry delay, armed away, armed stay), armed, ready to arm, alarm in
  progress, fire alarm memory; arm away, arm stay and disarm **buttons**.
- Points: open or closed (opening, motion, smoke, leak).
- Outputs: on / off state; turn on and turn off **buttons**.
- Panel: link, trouble, AC power failure, battery.
- Scene triggers: alarm triggered, area armed, area disarmed. Scene actions:
  arm, disarm.
- Safety: arming always allowed; **disarming and outputs off by default**,
  each behind its own option (away to stay needs the disarm option); every
  command decided on the state read from the panel right before it, one at a
  time; the codes are secret fields, never logged; a code refused at login
  stops the integration and is never sent again by itself, even across
  restarts; one connection only, spaced reconnections.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory panel
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run cover          # cover.png, plain Node
npx github:GladysAssistant/integration-store .
```

Layout: `src/bosch/` (frames, protocol tables, TLS client), `src/app.js`
(devices, states, scene events, commands), `src/devices.js`,
`src/publisher.js` (rate limits), `test/helpers/fakeBosch.js` (the simulated
panel). See `CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[bosch-alarm-mode2](https://github.com/mag1024/bosch-alarm-mode2) 0.4.11 by
Michael Grigoriev and contributors (MIT): see `THIRD_PARTY_NOTICES.md`.
