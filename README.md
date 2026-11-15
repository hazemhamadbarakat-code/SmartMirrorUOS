# Assistive Smart Mirror

Low-cost assistive smart mirror for people with memory or mild cognitive difficulties.
Raspberry Pi 4 runs **MagicMirror²** (open source, MIT) plus one custom module, **MMM-AssistCare**.
An Arduino Uno handles the sensors and physical alerts over USB serial.

```
PIR ─┐                        USB serial                 ┌─ HDMI monitor (behind two-way mirror)
HC-SR04 ─┤  Arduino Uno  ◄──────────────────►  Raspberry Pi 4 ─┤
HELP button ─┤  (assist_mirror.ino)   MOTION/HAND/HELP ►   MagicMirror² ├─ USB speaker (espeak-ng / Piper)
LEDs + buzzer ◄┘                      ◄ LED/BUZZ           + MMM-AssistCare
```

## What is where

| Path | What it is |
| --- | --- |
| `arduino/assist_mirror/assist_mirror.ino` | Uno sketch: PIR, hand detection (short `HAND` / long `HANDHOLD`), debounced HELP, LEDs, buzzer |
| `docs/PROTOCOL.md` | Serial message format, LED meanings, **pin map and wiring** |
| `MagicMirror/modules/MMM-AssistCare/` | Custom module (copied into `~/MagicMirror/modules/`) |
| `…/node_helper.js` | Backend: serial link + auto-reconnect, reminder scheduler, checklist state, TTS queue, screen sleep |
| `…/MMM-AssistCare.js` / `.css` | Dashboard and full-screen reminder / HELP overlays |
| `…/data/schedule.json` | **Medicines, exercises, checklist — edit this file** (reloads automatically within 5 s) |
| `…/data/appointments.ics` | Sample appointments read by the built-in calendar module |
| `…/data/state.json` | Created at runtime: today's ticks / "taken at" times. Resets at midnight. |
| `MagicMirror/config/config.js` | MagicMirror² config (clock, calendar, alert, MMM-AssistCare) |
| `MagicMirror/css/custom.css` | High-contrast overrides for the built-in modules |
| `scripts/setup-pi.sh` | One-shot Pi install |

## Feature coverage (the 12 selected features)

| # | Feature | How |
| --- | --- | --- |
| 1 | Automatic wake-up | `MOTION` → screen on (`wlr-randr`), greeting. Screen off after `screenTimeoutSec` of no motion — never while a reminder, HELP or timer is active. |
| 2 | Contactless hand control | `HAND` (≥ 0.3 s, then removed) and `HANDHOLD` (≥ 1.5 s). 1 s cooldown + must remove hand before the next gesture. |
| 4 | Medication reminders | `schedule.json` → full-screen prompt + speech + amber LED + beep. Repeats every 5 min, up to 3 times, then shown as "Not taken". Hand = "taken at 08:03". |
| 5 | Daily checklist | `HAND` ticks the next task (spoken: "Brush teeth, done. Next: …"). Saved across reboots, resets daily. Also clickable with a mouse. |
| 6 | HELP button | Red flashing screen, spoken message, red LED blinking, buzzer pulsing for 30 s. Carer cancels with a 1.5 s hand hold (or `C` key). Local only. |
| 7 | Audio reader | espeak-ng (works out of the box) or Piper (natural voice, offline). Queue so messages never overlap. |
| 8 | High contrast | Large bold white-on-black, status shown with words and symbols, not colour alone. |
| 10 | Visual alerts | LEDs: green = all fine, amber blink = waiting for confirmation, red blink = HELP. Full-screen overlays. |
| 11 | Appointments | Built-in `calendar` module (ICS file or Google Calendar iCal link) → spoken 60 and 15 min before. |
| 12 | Personalised welcome | `userName` greeting by time of day, plus spoken time, tasks left and next medicine. Max once per 30 min. |
| 14 | Touch-free timer | When no reminder is showing, `HANDHOLD` starts a 5-min timer / cancels it. Large countdown, spoken + full-screen when done. |
| 18 | Exercise prompts | `schedule.json` exercises with steps, read aloud, acknowledged by hand. Not medical monitoring. |

**What a hand gesture does** (in priority order): HELP active → long hold cancels it · a reminder is showing → confirms it · otherwise short = tick next task, long = start/stop timer.

## Setup

1. Flash **Raspberry Pi OS (64-bit, Desktop)** with Raspberry Pi Imager. Set user, Wi-Fi, time zone.
2. Put this folder on the Pi (`git clone` your repo), then:
   ```bash
   bash scripts/setup-pi.sh
   ```
   Add `--piper` for the nicer voice. Log out and in once afterwards (serial permission).
3. Upload `arduino/assist_mirror/assist_mirror.ino` to the Uno with the Arduino IDE, plug the Uno into the Pi.
4. `pm2 logs mm` should show `serial open on /dev/ttyACM0`.

## Bench testing order (matches Notion phase 3–5)

1. **Arduino alone** — Arduino IDE Serial Monitor at 115200, line ending "Newline". You should see `READY`, the LED/beep self-test, then `MOTION`/`NOMOTION`, `HAND`, `HANDHOLD`, `HELP`. Type `LED:A:BLINK`, `BUZZ:BEEP`, `DEBUG:ON` (shows `DIST:` to tune `HAND_CM`).
2. **Pi alone** — no Arduino needed. In the mirror window press **M** motion · **H** hand · **J** hand-hold · **E** HELP · **C** cancel HELP · **R** test reminder. To test a real reminder now, set a medicine's `time` to two minutes from now in `schedule.json`.
3. **Together** — unplug the Uno while running: the dashboard shows "Sensors disconnected", reminders keep speaking, and it reconnects by itself when plugged back in.

## Demo script

approach (PIR) → screen wakes, "Good morning, Sara…" → reminder fires (set a time 1 min ahead) → spoken + amber LED → hand near sensor → "marked as taken at …", green LED → short hand = tick a task → long hand = timer → press HELP → red screen + buzzer → carer holds hand 2 s → cancelled.

## Things still to decide / verify on the real hardware

- `HAND_CM` (12 cm) and the PIR pots depend on where the sensors sit in the frame — tune with `DEBUG:ON`.
- Screen on/off uses `wlr-randr`; `setup-pi.sh` detects the output name. If your monitor doesn't wake from a DPMS off, set `screen.offCommand` to `""` and the screen will just stay on.
- `npm run start:wayland` is the MagicMirror² Wayland start script; if your MagicMirror² version names it differently, check `~/MagicMirror/package.json` and run `pm2 delete mm` + start again.
- The Piper download URLs in `setup-pi.sh` point to the 2023.11.14-2 release and the alba voice; check they still resolve.
- Remote HELP notification is intentionally not included (local alert is the agreed baseline).
