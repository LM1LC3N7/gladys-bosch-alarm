# TODO - Bosch Alarm (Mode 2) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the main
  session posts one recap per wave in /t/10385.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-20): own TLS client on `node:tls`
      ported from bosch-alarm-mode2 0.4.11 (frames, "what are you", login
      by family, configured lists and names, status, alarm memory, faults,
      subscription or polling); panel / area / point / output devices;
      read-only states and push buttons; arming always allowed, disarming
      and outputs opt-in (separate options); fresh read before every
      command, serialized, deadlines inside Gladys' 5 s; refused code stop
      persisted in `/data`; scene triggers `alarm_triggered`, `armed`,
      `disarmed`; scene actions `arm`, `disarm`; "Test the connection",
      "Allow a new try of the code"; fr/en. Tested against an in-memory
      panel only.
- [x] **Review 1 fixes** (2026-10-20, xhigh review of 50a7fea: 7 important,
      6 minor): see "Decisions after review 1" below; one test per scenario
      in `test/review1.test.js`.
- [ ] **Approval** of the review fixes.
- [ ] **Milestone 2 - real panel**: run against a real B Series, a Solution
      and an AMAX; capture real frames (anonymised) as fixtures; fix what
      differs (see below).
- [ ] **Milestone 3 - more**: doors of the B and G Series (unlock behind its
      own option, lock / secure always allowed), the event log (history
      events as scene triggers), instant arming, alarm memory detail per
      point as point features, the panel clock.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real panel

- The TLS handshake of older panels with Node's defaults (`ciphers:
'DEFAULT'`, TLS 1.2 minimum, as Python 3.10+ in Home Assistant).
- What a wrong automation code gives: AUTHENTICATE answering 0x00 (assumed),
  or a NACK, or a closed socket; whether repeated wrong codes raise a "user
  code tamper" fault or lock anything.
- A Solution user code refused: a NACK of LOGIN_REMOTE_USER (assumed).
- Going from armed stay to armed away (and back) in one AREA_ARM command, on
  each family (the panel decides; a NACK is reported as such).
- The status bytes 0x0A / 0x0B ("Stay 1 / 2 On") on Solution and AMAX:
  counted as armed stay here, not by the reference.
- Whether a fire alarm memory shows for a disarmed area on every family.
- That the heartbeat updates keep coming with the subscription (else the
  keep-alive covers it).

## Decisions

- **Own client, no dependency**: no maintained Mode 2 client on npm;
  bosch-alarm-mode2 (MIT, the library of the Home Assistant core
  integration) is ported and credited in `THIRD_PARTY_NOTICES.md` (copied
  into the image with `LICENSE`). Runtime dependency: the SDK only; TLS from
  `node:tls`.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release (`test/manifest.test.js` checks they
  agree). Every later version comes from Actions -> Release (the first patch
  release gives 0.1.1).
- **TLS without a certificate check**, as the reference and Home
  Assistant: the panels have a self-signed certificate. The docs and the
  code field say it plainly (an active attacker on the LAN could get the
  codes). The user texts say "TLS" only, never a word for a ciphered
  secret, so that the test against it keeps guarding the secret fields.
- **Codes by family**, as the reference: Solution: the user code only
  (LOGIN_REMOTE_USER, digits padded with F); AMAX: the automation code as
  an "installer app" user, then the installer code; B, G and GV4: the
  automation code only. A code missing for the family found: the client
  parks with a clear status, sends no code, and waits for a configuration
  change (no loop). Formats checked before any connection: automation code
  1 to 32 printable characters without space, user / installer code 1 to 8
  digits.
- **Refused code**: AUTHENTICATE answering anything but "authorized" (but
  "max connections"), or a NACK of a login, stops the integration: saved in
  `/data/bosch-alarm-state.json` with its date only (never a code nor a
  hash: a short code is brute-forced from any hash); no reconnection, even
  after a restart; lifted by a change of a code in the configuration, or by
  the "Allow a new try of the code" action, which logs in once (refused
  again: stopped again). "Test the connection" never lifts it. "Max
  connections" is not a refusal: a new try after 60 s at least.
- **One request in flight** on every panel (the reference allows 100 on B
  and G). The protocol has no request id: the answers come in order. A
  request without an answer within 5 s (or its absolute deadline), an
  unreadable answer or an answer nobody asked for resets the connection
  instead of guessing (the reference checks for a "command skew" every
  minute). Hence no "ambiguous" answer as in gladys-satel-integra.
- **Connection**: one at a time, 5 s at least between two, 10 s to 5 min
  between tries, 60 s at least after "max connections", 5 min for an unknown
  model; keep-alive ("what are you", the model must match) after 60 s
  without a request; watchdog 150 s.
- **States**: the subscription (format 1 or 2) when the panel has it: area
  on/off, area ready, points, outputs (read again: the ids of these updates
  do not match on Solution, as the reference notes), alarm memory summary,
  panel status (format 2). Without it, everything is read every 2 s (the
  reference: every second). Everything again every 10 min; the faults every
  minute (the event log, which would announce them, is not followed). An
  unknown update type stops the reading of its frame and reads everything
  again (at most every 10 s). Unknown statuses are not published (unknown,
  not "off"); offline, only the link state is published.
- **Area state**: the status byte gives disarmed, arming (exit delay),
  pending (entry delay: still armed), armed away, armed stay; 0x0A / 0x0B
  counted as armed stay (see above). "Alarm in progress" is the reference's
  `is_triggered` (armed or pending, with a burglary, gas or fire alarm in
  memory); "fire alarm memory" is a fire alarm in memory, armed or not (it
  stays until cleared at a keypad: named "memory"). Text state in the
  configured language, no history; the scene triggers carry the frozen codes
  (`armed_away`, `armed_stay`).
- **Transitions**: only settled modes are remembered (an exit or entry
  delay fires nothing); `armed` once per arming; `disarmed` only from an
  armed mode (an exit delay cancelled is not a disarm); `alarm_triggered`
  when "alarm in progress" or the fire memory rises, with the first point of
  the alarm (fire, gas, burglary) when the panel gives one, else `null` (the
  SDK refuses `undefined`: every undefined event value is sent as `null`).
  No event for the first status after a start. Updates gathered for 250 ms.
- **Commands**: buttons (`button`/`push`, value 1 only, strictly), never a
  switch or a binary. Each command reads its state from the panel first
  (AREA_STATUS of the area, OUTPUT_STATUS) and decides on that read only:
  already in the state (an exit delay towards it included): nothing sent;
  entry delay running: arming refused. Reads by 2.8 s, sent by 3.5 s or
  withdrawn ("nothing was sent"), answer awaited until 4.5 s; no answer or
  a lost session: "sent, without confirmation", the session comes back in
  about 5 s and is read again (I5 below). A NACK:
  "refused by the panel", with its meaning (no authority, cannot arm…).
  Arming types with delays only: B/G/GV4 master / perimeter delay,
  Solution/AMAX away / stay 1.
- **Options**: no option for arming (the brief: protective commands are
  never blocked); `allow_disarm` (off) for disarming and for armed away ->
  armed stay (a lower protection); `allow_outputs` (off). Checked when
  asked, again inside the queue after the fresh read, and once more by the
  client right before the socket write. An arming withdraws a disarm of the
  same area until its write and goes first (I3 below). One command at a
  time; one whose own readBy passed while it waited is refused ("other
  commands took all the time").
- **Objects**: the areas, points and outputs the panel declares (configured
  id sets), with their names (CF03 pages, CF01 one by one, else defaults),
  read once per list and address; bounded (32 areas, 600 points, 600
  outputs); CF03 pages stop without progress; alarm detail pages at most 20. Outputs over 255 shown, not controllable (one-byte command).
- **Ids**: `panel:bosch`, `area:<n>`, `point:<n>`, `output:<n>`: one panel
  per integration, numbered by the panel; a new IP keeps them. The point
  state feature is keyed by its kind; a device published again keeps the
  features of the created device it no longer has.
- **Rate limits**: the publisher of gladys-satel-integra (same author):
  only changed values, a heartbeat every 30 min plus a per-feature offset,
  240 states/min of which 60 kept for the panel and areas (points and
  outputs share the rest), 120 events/min, `alarm_triggered` never dropped
  and tried 3 times.
- **Units and categories**: only core ones (`input`, `text`, `siren`,
  `button`, `opening-sensor`, `motion-sensor`, `smoke-sensor`,
  `leak-sensor`), no unit at all.
- **Not ported in v1**: doors (unlock would be a sensitive command), the
  event log / history, instant arming, the panel clock, the extended
  protocol (disabled by the reference too).
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; the store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from the
  agent session; never run against a real panel.

## Decisions after review 1 (2026-10-20)

- **I1 - stop at once**: the client's `down` with a refused code sets
  `memory.codeStop` synchronously in the event listener (outside the guard
  chain, so a slow Gladys can no longer delay it) and writes it to /data
  right away. `startClient()` checks the stop again right before
  `client.start()`. The client itself locks after a refusal: `start()`
  opens nothing until the codes change (`configure`) or the user clicks
  "Allow a new try of the code" (`start({ retryCode: true })`).
- **I2 - doubtful logins**: a session that ends after a login frame was
  written, without a clear answer (closed, no answer within 15 s, an
  unreadable answer), counts as a doubt; 2 in a row stop exactly as a
  refusal (persisted, `doubtful: true`, its own status message). The count
  goes back to 0 only after an accepted login; a retry click allows one
  more try.
- **I3 - arming first**: the command queue puts an arming before the
  disarms and outputs waiting; an arming withdraws a disarm of the same
  area, waiting or being handled, until its write (checked after its fresh
  read, before `send`, and by the client right before the socket write).
- **I4 - bounded publication**: the updates of a burst are published once
  they stop for settleMs, at most 4 x settleMs after the first one.
- **I5 - unconfirmed commands**: a command without an answer (timeout, or
  a session lost after its write) brings the session back after 5 s
  (`fastReconnect`, no backoff); the session reads everything again. The
  message says "the state read again as soon as it is back (about 5 s)".
- **I6 - linear reader**: the reader keeps the chunks as received and
  joins them only once the announced frame is complete; frames over 8 KB
  are refused (an answer holds 255 bytes, a status frame of 600 points
  1.8 KB).
- **I7 - flood of alarm updates**: priorities outside 1-10 are ignored;
  one grouped `loadAlarms` read at a time, whatever the number of updates;
  the commands and their fresh reads are queued before every background
  read (`priority`).
- **Minor 1**: the user code field says it travels over TLS without a
  certificate check, and is never sent again by itself after a refusal.
- **Minor 2**: an unreadable, oversized or non-JSON state file counts as a
  stop (no file: no stop); a stop that could not be written is told in the
  connection status.
- **Minor 3**: "Test the connection" never starts a connection while a new
  try is planned (backoff, "max connections"): it tells the current status.
- **Minor 4**: `pump()` refuses a request whose `sendBy` passed even if its
  deadline timer did not fire yet.
- **Minor 5**: documented: re-arming an area whose alarm memory was not
  cleared at a keypad triggers `alarm_triggered` again (as Home Assistant).
- **Minor 6**: a session that drops less than 60 s after it came up counts
  as a failure: the waits grow instead of a reconnection every 10 s.
