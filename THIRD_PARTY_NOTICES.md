# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## bosch-alarm-mode2

<https://github.com/mag1024/bosch-alarm-mode2> (package `bosch-alarm-mode2`,
version 0.4.11, tag `v0.4.11`, commit `bdb7ae0`), by Michael Grigoriev and its
contributors, the library of the Home Assistant Bosch Alarm integration. MIT
License (`LICENSE` of the repository). Its notice, as written there:

```
Copyright 2025 Michael Grigoriev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Ported from `bosch_alarm_mode2/`:

- `connection.py`, `utils.py`, in `src/bosch/frame.js` and
  `src/bosch/client.js`: the request frame (0x01, length, command, data), the
  answers (0x01 and 0x04 frames; 0xFC ack, 0xFD nack with its error, 0xFE
  data), the status frames (0x02), the big-endian integers, the TLS link
  without a certificate check.
- `const.py`, in `src/bosch/protocol.js`: the commands, the NACK error
  texts, the panel models and families, the area, point, output and ready
  states, the arming types, the alarm memory priorities, the fault bits, the
  user types, the request size limits.
- `panel.py`, in `src/bosch/protocol.js`, `src/bosch/frame.js` and
  `src/bosch/client.js`: "what are you" (CF03 then CF01) and its capability
  bits (section 13.2 of the protocol), the login by family (Solution: user
  code; AMAX: automation code as installer app, then installer code; B, G
  and GV4: automation code), the user code padded with F, the serial number
  and firmware, the configured id sets, the names (CF03 pages, CF01 one by
  one, default names), the area, point and output status, the alarm memory
  summary and detail with its 0xFFFF sentinel, the faults, the subscription
  frame, the status update records, the area mask of an arming, the arming
  types of each family, the output command.

The in-memory panel of the tests (`test/helpers/fakeBosch.js`) answers as the
panel described by the same files.

Changed: one request in flight at a time on every panel, answers matched in
order, and any request without an answer, unexpected answer or answer
nobody asked for resets the connection (the reference allows 100 requests in
flight on B and G series and checks for a "command skew" every minute); the
frames cut in one linear pass with a bounded length, the names, alarm pages
and id sets bounded; "Stay 1 On" and "Stay 2 On" (0x0A, 0x0B) counted as
armed stay; a code refused at login never retried by itself; reconnection
with growing waits (10 s to 5 min, at least 60 s after "max connections"),
never two connections at once and at least 5 s between two; a keep-alive
after 60 s without a request and a watchdog; the event log, the history,
the doors, the instant arming types and the panel date are not ported; the
faults read every minute instead of after each event; a command never
written after its deadline, its option read again right before the write.
