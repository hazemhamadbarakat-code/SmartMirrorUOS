# Pi ⇄ Arduino serial protocol and pin map

This describes the mirror **as built and tested on 20 November 2026**, with an
Arduino Mega 2560 running `arduino/smartmirror_node/smartmirror_node.ino`.

## Link

- USB-A → USB-B data cable. The board appears on the Pi as `/dev/ttyACM0`
  (vendor/product `2341:0042`, genuine Mega 2560 R3).
- 115200 baud, 8N1, ASCII lines terminated with `\n`. Case-sensitive.
- The Pi auto-detects the port by USB vendor ID unless `serialPort` is set in
  `config.js`, and reconnects on its own about three seconds after a replug.
- The account running MagicMirror must be in the `dialout` group.
- Some USB-B cables carry power only. The board's green `ON` LED lights from
  the power pins alone, so a lit board is **not** proof of a data connection.

## Arduino → Pi (events)

| Line | Meaning |
| --- | --- |
| `RDY:UNO:1` | Boot, and the reply to `PING`. The token is fixed by the protocol and does not change with the board. |
| `EVT:MOTION:1` | PIR triggered: someone is in front of the mirror. |
| `EVT:MOTION:0` | No motion for 5 s. Presence, not occupancy — a still person stops producing pulses. |
| `EVT:HAND:1` | Hand within about 20 cm of the HC-SR04. |
| `EVT:HAND:0` | Hand withdrawn. |
| `EVT:GESTURE:SELECT` | Hand held under 8 cm for 1 s. |
| `EVT:HELP` | HELP button pressed, debounced, with a 2 s repeat lock. |
| `DIST:<cm>` | Reply to `DIST?`. `-1` means no echo came back. |
| `HB:<millis>` | Heartbeat every 10 s; the Pi uses it to notice a dead link. |
| `ERR:<text>` | The board did not understand a command. |

One hand pass in front of the sensor produces a **burst** of `EVT:HAND:1` /
`EVT:HAND:0` pairs — roughly 35 in 20 seconds of waving. The Pi acts on the
first and ignores the rest for `handCooldownMs` (2 s by default); without that
cooldown a single wave ticks the whole checklist at once.

## Pi → Arduino (commands)

| Line | Effect |
| --- | --- |
| `LED:<RED\|AMBER\|GREEN\|ALL>:<ON\|OFF\|BLINK>` | Set an indicator. Full colour words, not single letters. |
| `BUZZ:<1-5000>` | Beep for that many milliseconds. |
| `PING` | The board answers `RDY:UNO:1`. |
| `DIST?` | Request the current distance. |

The Pi currently runs with `buzzer: false`, so it never sends `BUZZ`. Set it to
true in the module config if you want the buzzer used.

### Translation layer

The helper's internal event names are not these wire strings. Everything
crossing the link is converted in `translateIncoming()` in `node_helper.js`
(`EVT:MOTION:1` → `MOTION`, `RDY:` → `READY`, and so on), and LED letters are
mapped back to colour words on the way out. Change the firmware's vocabulary
and that one function is all that needs to follow.

Note that the firmware answers `PING` with the same `RDY:` line it sends at
boot. The helper only treats `RDY:` as a real reboot if more than 20 seconds
have passed since the last one; otherwise every heartbeat would resend all the
LED states and restart any blink mid-flash.

### LED meaning (set by the Pi)

| State | Red | Amber | Green |
| --- | --- | --- | --- |
| All fine, nothing pending | off | off | ON |
| Reminder / exercise / timer waiting for acknowledgement | off | BLINK | off |
| HELP active | BLINK | off | off |
| Screen asleep, nothing pending | off | off | off |

## Arduino Mega 2560 pin map (as built)

| Component | Mega pin | Notes |
| --- | --- | --- |
| PIR OUT | D2 | VCC → 5 V, GND → GND. Allow a full minute after power-up: the output is unreliable while the sensor self-calibrates. Turn the time-delay pot anticlockwise so the Pi, not the module, decides the hold time. |
| HC-SR04 TRIG | D3 | VCC → 5 V, GND → GND |
| HC-SR04 ECHO | D4 | 5 V output is fine on the Mega. **Never** on the Pi. |
| HELP button | D5 | Other leg → GND, diagonally opposite pins on a 4-pin tactile switch. Internal pull-up, pressed reads LOW, no resistor. |
| Green LED | D8 | Anode to the pin, cathode through 330 Ω to GND |
| Amber LED | D9 | Same |
| Red LED | D10 | Same |
| Buzzer | D11 | Through an NPN driver, not straight off the pin. Base through 1 kΩ, emitter to GND, buzzer + to 5 V and − to the collector, flyback diode across a magnetic buzzer. |
| USB to Pi | USB-B | Powers the board and carries the serial link. Nothing connects to the Pi's GPIO header. |

All grounds are common through the board. The Mega is 5 V logic throughout and
the Pi's GPIO is 3.3 V only — the USB cable is the sole connection between them.

## Diagnostics panel

The mirror has a hidden maintenance screen: **triple-click the clock**, or press
**A** with the mirror window focused. **Esc** or the Close button dismisses it,
and it closes itself after `adminTimeoutSec` (60 s) with no button pressed.

It shows the serial link state and port, the board's own uptime from `HB:`,
live ultrasonic distance, PIR state, and counters for motion, hand, hand-hold
and HELP events since the Pi started. The last eight lines received are printed
verbatim, which is the quickest way to see whether the board is talking at all.

Buttons drive each LED, the buzzer, a spoken test phrase, a test reminder and a
`PING`. Two behaviours worth knowing:

- While the panel is open, `updateOutputs()` stands down, so an LED set by hand
  stays as the tester left it. Closing the panel restores the mirror's own LED
  state.
- `DIST?` is polled four times a second **only while the panel is open**. The
  link is otherwise event-driven and quiet.

The distance, PIR state and the counters are all derived on the Pi from events
the board already sends. Counting button presses on the board itself would need
a new firmware command; nothing in the sketch had to change for this panel.

## Cancelling a HELP alert

A HELP alert blocks screen sleep and stays on screen until something clears it.
There are three ways out, in the order a carer would reach for them:

1. **Hold a hand close to the mirror** for a second. The firmware sends
   `EVT:GESTURE:SELECT` when the distance stays under `SELECT_CM` (8 cm) for
   `SELECT_HOLD_MS`, and the helper maps that to its `HANDHOLD` event.
2. **Press HELP again**, at least `helpCancelAfterSec` (10 s) after it was
   raised. Earlier presses are logged and ignored, so a confused user pressing
   twice cannot clear their own alert.
3. **The diagnostics panel**, which shows a Cancel HELP button while an alert
   is up, and a Trigger HELP button when there is none.

The hand cooldown that stops one wave ticking the whole checklist does **not**
apply to `HANDHOLD`. A hold always arrives about a second after the `EVT:HAND:1`
that begins it, so rate-limiting it would have swallowed the cancel gesture
every time.
