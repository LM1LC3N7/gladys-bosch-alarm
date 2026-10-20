# Bosch Alarm (Mode 2) for Gladys

This integration links a **Bosch** alarm panel to Gladys Assistant,
**locally** over your network, with Bosch's **"Mode 2"** automation
protocol: Solution 2000, 3000, 4000 (and 2100, 3100, 4100), AMAX 2100, 3000,
4000, B Series (B3512, B4512, B5512, B6512), G Series (B8512G, B9512G) and
D7412GV4 / D9412GV4.

> **Never tested with a real device.** The protocol comes from the
> [bosch-alarm-mode2](https://github.com/mag1024/bosch-alarm-mode2) 0.4.11
> library (the one of the Home Assistant Bosch Alarm integration), ported to
> JavaScript and checked against a simulated panel only. Make your first
> tries on site, with the panel disarmed, and report what goes wrong.
>
> Unofficial integration, not affiliated with Bosch.

## Before you start

- The panel on your network (built-in network module, or the B426 / B450 /
  IP module of the panel), reachable from Gladys: give it a fixed address in
  your router.
- **Automation (Mode 2) enabled** on the panel by your installer (A-Link
  Plus, RPS or Installer Services), with its port (7700 by default) and:
  - B, G Series and GV4: an **automation code**;
  - AMAX: an **automation code** and the **installer code**;
  - Solution: the **code of a user** (no automation code).
- The panel takes a limited number of automation connections: if another
  software holds them all (Home Assistant, another Gladys…), the integration
  says so and tries again one minute later at the earliest.

## What you get

The areas, points and outputs are the ones the panel declares, with their
names.

- **Bosch panel**: connected or not, trouble, AC power failure, battery low
  or missing (model, firmware and serial number as parameters).
- **One device per area**:
  - **State**, read-only: disarmed, arming (exit delay), entry delay, armed
    (away), armed (stay);
  - **Armed**, **Ready to arm** (panels with a subscription), **Alarm in
    progress** (an armed area with a burglary, gas or fire alarm in memory),
    **Fire alarm memory** (until it is cleared at a keypad);
  - three **buttons**: arm away, arm stay, disarm.
- **One device per point**: open or closed (opening, motion, smoke or leak,
  as chosen).
- **One device per output**: on or off, and two **buttons**: turn on, turn
  off.
- **Scene triggers**: alarm triggered (with the point when the panel gives
  it, and whether it is a fire), area armed (mode, asked by Gladys or not),
  area disarmed.
- **Scene actions**: arm (away or stay), disarm.

No command is a switch: a "turn everything off" of a voice assistant, of
HomeKit or of a scene can neither disarm the alarm nor drive an output. The
states are read-only, the commands are buttons.

## Configuration

1. **Address of the panel**: the IP address of its network module.
2. **Automation port**: 7700, unless your installer changed it.
3. **Automation code**: B, G Series, GV4 and AMAX (not used by Solution).
4. **User code (Solution) or installer code (AMAX)**: 8 digits at most. Not
   used by B and G Series. For Solution, create a dedicated user with only
   the rights Gladys needs.
5. **Kind of the points** (optional): e.g. `7:motion, 9-10:smoke, 12:leak`.
   Kinds: `opening` (default), `motion`, `smoke`, `leak`. Changing the kind
   of a point already created in Gladys adds a new feature and keeps the old
   one (and its history): delete the old one by hand if you do not want it.
6. **Safety**: see below.
7. **Language of the names**: French or English.

The codes are secret fields: kept by Gladys in its database, never shown
again in the interface, sent only to the panel. They never appear in the
logs nor in `/data`.

The **Test the connection** button connects at once when no connection is
open (else it waits for the one in progress) and tells the model, the state
of the areas and the number of points and outputs.

The **Allow a new try of the code** button lifts the stop set after a
refused code (see "Safety"): the integration logs in once more with the
codes of the configuration.

## What travels on the network

- The link with the panel goes through **TLS, without a check of the panel's
  certificate** (as Home Assistant does: the panel has a self-signed
  certificate). A device that only listens to your network cannot read the
  exchanges; a device able to pose as the panel on your local network could
  receive the codes.
- The codes are sent at each login to the panel.
- Protect your network (a separate guest Wi-Fi for the devices you are not
  sure of) and give Gladys a code with limited rights.

## Safety

- **Arming** is always allowed, without an option: it is a protective
  command. Arming while someone is inside (a badly set scene, a mistake) may
  raise a false alarm, the sirens and a call of your alarm monitoring
  company.
- **Disarming is off by default.** Once the option is checked, **every
  Gladys user, every scene and the Gladys mobile app can disarm without
  typing any code**. Allow it only if your Gladys is well protected
  (accounts, remote access). Going from armed away to armed stay lowers the
  protection: it needs this option too.
- **The outputs are off by default**, behind their own option: an output may
  drive a siren, a gate or a lock. Check what each one does first.
- The options are read again right before each send: an option unchecked
  while a command waits its turn blocks that command.
- Before each command, the integration **reads the state from the panel
  again** and decides on that state, never on what it has in memory
  (already in the asked state: nothing is sent; entry delay running: arming
  refused). The commands go one at a time, in order. A command whose time
  ran out while it waited its turn is refused, nothing is sent. An arming
  withdraws a disarm of the same area still waiting its turn.
- A command that cannot leave in time (slow panel, unreadable state) is
  refused with "nothing was sent". A command that left without a clear
  answer (no answer, a cut) is reported "sent, without confirmation" and
  the state is read again two seconds later: it is never reported "not
  sent". Only a refusal of the panel is reported "refused" (no right,
  cannot arm…).
- **If the panel refuses a code at login, the integration stops and never
  sends it again by itself**, even after a restart (a panel may count wrong
  codes and report a code tamper). Change a code in the configuration, or
  click "Allow a new try of the code" (one try per click). The file
  `/data/bosch-alarm-state.json` only keeps the date of the stop, never a
  code; the stop holds even if the address of the panel changes.
- Every command, sent or refused, is written in the integration logs; the
  codes never are.

## Connection

- One connection at a time, never two: at least 5 seconds between two
  connections.
- After a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then
  every 5 minutes; at least one minute when the panel has no free
  connection, five minutes for an unknown model.
- The panels that can send each change themselves do (subscription); the
  others are read every 2 seconds. Everything is read again every 10
  minutes, the faults every minute.
- A request after 60 seconds of silence checks that the panel still
  answers; with nothing received for 150 s, or no answer to a request, the
  integration reconnects.

## Known limits

- Never tested with a real device (see above).
- No event log, no doors (access control of the B and G Series), no instant
  arming, no clock setting in this version.
- "Ready to arm" only exists on the panels that send their changes
  (subscription).
- Outputs over 255 are shown but cannot be controlled (the protocol command
  takes one byte).
- An alarm already in progress when the integration starts does not trigger
  a scene (only the changes seen do).

## Privacy

Everything stays on your network: the integration talks to the panel only.

## Licence

Apache-2.0. Protocol logic ported from bosch-alarm-mode2 0.4.11 (MIT,
Michael Grigoriev): see `THIRD_PARTY_NOTICES.md`.
