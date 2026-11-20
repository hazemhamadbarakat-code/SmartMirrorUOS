# Smart Mirror – Arduino + Raspberry Pi Setup

Arduino Mega 2560 handles the sensors, LEDs and buzzer. The Raspberry Pi runs the mirror and talks to the Mega over **USB serial only**.

> **Never connect Mega pins to the Pi's GPIO header.** The Mega is 5 V logic, the Pi's GPIO is 3.3 V only. The USB cable is the only link.

---

## 1. Files

| File | Runs on | Purpose |
|---|---|---|
| `smartmirror_node.ino` | Arduino Mega | Final sketch: sensors + serial protocol (currently uploaded) |
| `smartmirror_demo.ino` | Arduino Mega | Standalone demo, human-readable output (no Pi needed) |
| `pin_check.ino` | Arduino Mega | Basic wiring check |
| `mirror_serial_test.py` | Raspberry Pi | Link test: reads events, sends LED/buzzer commands |

---

## 2. Pin map

| Part | Mega pin | Notes |
|---|---|---|
| PIR (HC-SR501) OUT | **D2** | VCC → 5 V, GND → GND (middle pin = OUT) |
| HC-SR04 Trig | **D3** | VCC → 5 V, Gnd → GND |
| HC-SR04 Echo | **D4** | |
| HELP button | **D5** | Other leg → GND, diagonal legs, no resistor (`INPUT_PULLUP`) |
| Green LED | **D8** | Long leg (anode) to pin, cathode → 220–330 Ω → GND |
| Amber LED | **D9** | Same as green |
| Red LED | **D10** | Same as green |
| Buzzer module S | **D11** | + → 5 V, − → GND |
| Power | 5V / GND | Bottom breadboard rails: **+ = 5 V, − = GND** |

**Mega power header** (from the Vin end): `Vin – GND – GND – 5V – 3.3V – RESET – IOREF – (unused)`

---

## 3. Breadboard layout (bottom half, rows f–j)

| Columns | Part | Placement |
|---|---|---|
| 6–11 | Green LED | Resistor h6–h10, LED cathode g10 / anode g11, j6 → − rail, pin 8 → col 11 |
| 16–21 | Amber LED | Resistor h16–h20, LED g20/g21, j16 → − rail, pin 9 → col 21 |
| 26–31 | Red LED | Resistor h26–h30, LED g30/g31, j26 → − rail, pin 10 → col 31 |
| 40–42 | HELP button | Straddles gap e40/e42/f40/f42, a40 → pin 5, j42 → − rail |
| 44–51 | Buzzer driver (optional, if not using module) | 1 kΩ h44–h48, NPN g47–g49, diode i47–i51 (stripe → 5 V) |
| 56–60 | PIR | OUT → pin 2 |
| 20–23 (top, row a) | HC-SR04 | a20 VCC, a21 Trig, a22 Echo, a23 Gnd; e20 → + rail, e21 → pin 3, e22 → pin 4, e23 → − rail |

---

## 4. Serial protocol (115200 baud, newline-terminated)

### Arduino → Pi
| Message | Meaning |
|---|---|
| `RDY:UNO:1` | Boot, and reply to `PING` |
| `EVT:MOTION:1` / `EVT:MOTION:0` | Person present / gone (5 s hold) |
| `EVT:HAND:1` / `EVT:HAND:0` | Hand in front (< 20 cm) / gone (> 25 cm) |
| `EVT:GESTURE:SELECT` | Hand held < 8 cm for 1 s |
| `EVT:HELP` | HELP pressed (2 s repeat lock) |
| `DIST:<cm>` | Reply to `DIST?` (`-1` = no echo) |
| `HB:<millis>` | Heartbeat every 10 s |
| `ERR:<text>` | Unknown command |

### Pi → Arduino
| Command | Effect |
|---|---|
| `LED:<RED\|AMBER\|GREEN\|ALL>:<ON\|OFF\|BLINK>` | Control LEDs |
| `BUZZ:<1–5000>` | Beep for N ms |
| `PING` | Liveness check |
| `DIST?` | Request current distance |

---

## 5. Raspberry Pi setup

1. Close Arduino IDE on the laptop, unplug the Mega, plug its USB cable into the Pi.
2. Copy `mirror_serial_test.py` to the Pi (USB stick or `scp mirror_serial_test.py pi@<pi-ip>:~/`).
3. One-time setup:
   ```bash
   sudo apt update
   sudo apt install python3-serial
   sudo usermod -a -G dialout $USER
   sudo reboot
   ```
4. Check the Mega is detected, then run:
   ```bash
   ls /dev/ttyACM*
   python3 mirror_serial_test.py
   ```

---

## 6. Test checklist

| Action | Pi terminal | Board |
|---|---|---|
| Start script | `RDY:UNO:1` → `[OK] Link up` | Green on |
| Walk in front of PIR | `EVT:MOTION:1` | Green blinks |
| Leave 5+ s | `EVT:MOTION:0` | Green steady |
| Hand < 20 cm | `EVT:HAND:1` + distance | Amber on |
| Hand < 8 cm for 1 s | `EVT:GESTURE:SELECT` | Short beep, amber blinks |
| Remove hand | `EVT:HAND:0` | Amber off |
| Press HELP | `EVT:HELP` | Red blinks, 0.5 s beep |
| Wait | `HB:...` every 10 s | — |

Ctrl+C stops the script and turns all LEDs off.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| "No Arduino found" | Try another USB port/cable (some cables are charge-only) |
| "Permission denied" on `/dev/ttyACM0` | You skipped the reboot after `usermod` |
| Garbled characters | Baud mismatch — both sides must be 115200 |
| Nothing for ~3 s at start | Normal: opening the port resets the Mega |
| PIR always on | Check OUT is on pin 2; face dome away; both pots fully anticlockwise; wait 60 s warm-up |
| PIR slow to turn off | Turn the time-delay pot anticlockwise (~3 s); ~2.5 s block time after each trigger is normal |
| Buzzer beeps nonstop | Set `BUZZER_ACTIVE_LOW = true` in the sketch and re-upload |
| HC-SR04 reads 0 / no echo | Trig and Echo swapped, or VCC not on 5 V |
| Button never triggers | Ground wire must be in the − rail; use diagonal legs |

---

## 8. Next steps

- Mirror display on the Pi: full-screen page that reacts to these events.
- Mount the PIR facing the room, the HC-SR04 at hand height below the mirror.
- Move from breadboard to perfboard once everything passes.
