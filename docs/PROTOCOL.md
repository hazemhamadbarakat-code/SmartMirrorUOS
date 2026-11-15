# Pi ⇄ Arduino serial protocol and pin map

## Link

- USB-A → USB-B data cable, Uno appears on the Pi as `/dev/ttyACM0` (genuine Uno) or `/dev/ttyUSB0` (CH340 clone).
- 115200 baud, 8N1, ASCII lines terminated with `\n`. Case-sensitive. Unknown lines are ignored.
- The Pi auto-detects the port (Arduino / CH340 USB vendor IDs) unless `serialPort` is set in `config.js`.

## Arduino → Pi (events)

| Line | Meaning |
| --- | --- |
| `READY` | Sketch has booted (also sent after every USB reconnect, because opening the port resets the Uno). |
| `MOTION` | PIR output went HIGH (person approaching). |
| `NOMOTION` | PIR output went LOW (HC-SR501 hold time expired). |
| `HAND` | A hand stayed within `HAND_CM` for ≥ 300 ms and was then removed before 1.5 s. Short, deliberate gesture. |
| `HANDHOLD` | A hand stayed within `HAND_CM` for ≥ 1.5 s. Sent once while held; no `HAND` follows. |
| `HELP` | HELP button pressed (debounced, 2 s lock-out between presses). |
| `PONG` | Reply to `PING`. |
| `DIST:<cm>` | Only when debug is on (`DEBUG:ON`), ~4 lines/s. For calibrating the hand distance. |

After any `HAND`/`HANDHOLD` the sketch waits until the hand is gone **and** 1 s has passed before it can fire again (cooldown, prevents repeat triggers).

## Pi → Arduino (commands)

| Line | Effect |
| --- | --- |
| `LED:<R\|A\|G>:<ON\|OFF\|BLINK>` | Red / amber / green LED. BLINK = 2 Hz. |
| `BUZZ:<ON\|OFF\|PULSE\|BEEP>` | ON = continuous, PULSE = 250 ms on/off, BEEP = one 150 ms beep. |
| `ALL:OFF` | All LEDs and buzzer off. |
| `PING` | Arduino answers `PONG`. The Pi sends this every 5 s; no reply for 15 s = connection treated as lost. |
| `DEBUG:<ON\|OFF>` | Stream `DIST:` readings. |

### LED / buzzer meaning (set by the Pi)

| State | Red | Amber | Green | Buzzer |
| --- | --- | --- | --- | --- |
| All fine, nothing pending | off | off | ON | off |
| Reminder / exercise / timer waiting for acknowledgement | off | BLINK | off | BEEP once |
| HELP active | BLINK | off | off | PULSE for `helpBuzzSeconds`, then off (LED keeps blinking) |
| Screen asleep, nothing pending | off | off | off | off |

## Arduino Uno pin map (proposed — copy into the Notion "System and wiring" table)

| Component | Uno pin(s) | Notes |
| --- | --- | --- |
| PIR HC-SR501 OUT | D2 | VCC → 5V, GND → GND. Set the board jumper to **H** (repeat trigger); turn the time pot fully anticlockwise (~3 s) — the Pi handles screen timeout. |
| HC-SR04 TRIG | D7 | VCC → 5V, GND → GND |
| HC-SR04 ECHO | D8 | 5 V output is fine on the Uno (never on the Pi). |
| HELP button | D3 | Other leg → GND. Uses internal pull-up (pressed = LOW). No resistor needed. |
| Red LED | D9 | Through 220 Ω to anode; cathode → GND |
| Amber LED | D10 | Through 220 Ω |
| Green LED | D11 | Through 220 Ω |
| Buzzer driver | D6 | D6 → 1 kΩ → base of NPN (2N2222 / BC547). Emitter → GND. Buzzer + → 5V, buzzer − → collector. Add a 1N4148 diode across the buzzer (cathode to 5V) if it is a magnetic (not piezo) buzzer. Use an **active** buzzer (it beeps on DC). |
| USB to Pi | USB-B | Powers the Uno and carries serial. Nothing connects to Pi GPIO. |

All grounds are common through the Uno. Total current (PIR ~65 µA, HC-SR04 ~15 mA, 3 LEDs ~45 mA, buzzer ~30 mA) is well within what the Pi's USB port supplies.
