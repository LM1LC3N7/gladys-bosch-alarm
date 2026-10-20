# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local connection to Bosch Solution, AMAX, B Series, G Series and GV4 alarm
  panels over the Mode 2 automation protocol (TLS, port 7700), with the
  protocol of bosch-alarm-mode2 0.4.11: "what are you", the login of each
  family, the configured areas, points and outputs and their names, their
  status, the alarm memory, the faults, the subscription (or polling).
- One device per area: read-only state (disarmed, arming, entry delay, armed
  away, armed stay), armed, ready to arm, alarm in progress, fire alarm
  memory, and arm away / arm stay / disarm push buttons (never a switch).
- One device per point: open or closed, as an opening, motion, smoke or leak
  sensor (configurable kind).
- One device per output: state, and turn on / turn off push buttons.
- The panel: link, trouble, AC power failure, battery low or missing.
- Scene triggers `alarm_triggered` (point, fire), `armed`, `disarmed`; scene
  actions `arm` and `disarm`; "Test the connection" and "Allow a new try of
  the code" buttons.
- State and scene event budgets under the Gladys limits.
- French and English names, messages and guides.

### Security

- Arming is never blocked by an option; disarming and the outputs are off by
  default, each behind its own option; going from armed away to armed stay
  needs the disarm option. The options are read when the command is asked,
  again after the fresh read, and once more right before the write.
- Every command decided on the state read from the panel just before it,
  one at a time, sent within 3.5 s or not at all; a command that may have
  left is reported "sent, without confirmation" and read again; an arming
  withdraws a disarm of the same area still waiting.
- A code refused by the panel at login stops the integration, kept across
  restarts in `/data` (the date only, never a code); lifted by a new code or
  by "Allow a new try of the code" (one try per click). The codes are never
  logged.
- One connection only, at least 5 s between two, spaced reconnections (10 s
  to 5 min, at least 60 s when the panel has no free connection); one
  request in flight, any answer out of order resets the connection; bounded
  frames, names and pages, linear parsing.

### Fixed

- A refused code is stopped at once, even when Gladys answers slowly: "Test
  the connection" or a new address can no longer send it again.
- A login the panel never answers clearly (closed, silent, unreadable) twice
  in a row stops like a refused code, instead of trying again forever.
- An arming asked while a disarm of the same area is being handled
  withdraws it (until its write) and goes before the disarms and outputs
  waiting.
- The states and scene events of a burst of updates are published within
  1 s, even when a point keeps flapping.
- A command without an answer brings the connection back in about 5 s and
  the state is read again then (the message says so).
- The frame reader is linear on tiny chunks; frames over 8 KB are refused.
- A flood of alarm memory updates no longer delays the commands: unknown
  priorities ignored, one grouped read, commands before background reads.
- An unreadable state file in `/data` counts as a stop; a stop that cannot
  be written is told in the status. "Test the connection" no longer jumps
  a planned wait. A request is never written after its deadline. A session
  that drops right after it came up makes the waits grow.

### Changed

- The user code field says it travels over TLS without a certificate check.
- Docs: re-arming an area whose alarm memory was not cleared triggers the
  alarm event again.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bosch-alarm/commits/main
