# Operating the mirror

Everything the mirror can do, and how to make it do it. Written against the
build of 20 November 2026.

---

## 1. Physical controls

These are the only controls the end user ever needs.

| Do this | What happens |
| --- | --- |
| **Walk up to the mirror** | PIR fires, the screen wakes, and the mirror greets the user by name. The greeting repeats at most every 30 min (`welcomeCooldownMinutes`). If a reminder is already waiting, approaching replays it. |
| **Hand near the mirror** (within 20 cm) | If a reminder is on screen, it is acknowledged. Otherwise the next unticked checklist task is ticked off. One wave counts once, not many times. |
| **Hold a hand close** (under 8 cm for 1 s) | If a reminder is on screen, it is acknowledged. If a HELP alert is up, it is cancelled. Otherwise the **timer** starts or stops. |
| **Press HELP** | Full-screen red alert, spoken reassurance, red LED blinking. |
| **Press HELP again**, 10 s or more later | Cancels the alert. Presses before 10 s are ignored on purpose, so a confused user cannot clear their own alert. |
| **Walk away** | After 5 min with no motion (`screenTimeoutSec`) the screen sleeps — never while a reminder, a timer or a HELP alert is active. |

### The LEDs

| Red | Amber | Green | Meaning |
| --- | --- | --- | --- |
| off | off | **on** | Normal, nothing pending |
| off | **blink** | off | A reminder is waiting to be acknowledged |
| **blink** | off | off | HELP is active |
| off | off | off | Screen asleep |

---

## 2. Keyboard and mouse

Needs a keyboard or mouse attached, and the mirror window focused. Useful for
testing and demos; not part of normal use.

| Key | Effect |
| --- | --- |
| `M` | Fake a motion event |
| `H` | Fake a hand event (tick the next task / acknowledge) |
| `J` | Fake a hand hold (timer / cancel HELP) |
| `E` | HELP (and, after 10 s, cancel) |
| `C` | Cancel HELP immediately |
| `R` | Raise a test reminder |
| `A` | Open or close the diagnostics panel |
| `Esc` | Close the diagnostics panel |

**Mouse:** clicking a checklist row toggles it — this is the only way to
**untick** something. Triple-clicking the clock within 1.2 s opens diagnostics.

Turn the keys off for the final demo with `keyboardSimulation: false` in
`config.js`.

---

## 3. The timer

A plain countdown, meant for things like "sit for five minutes" or steeping tea.

- **Start it:** hold a hand close to the mirror when no reminder is on screen
  and no HELP alert is active. The mirror says "Timer started for 5 minutes".
- **Cancel it:** hold a hand close again while it runs. The mirror says
  "Timer cancelled".
- **While running:** a live countdown appears under the two cards, and the
  screen will not sleep.
- **When it finishes:** a full-screen "Timer finished" alert with speech.
  Acknowledge it like any reminder — a hand near the mirror.

**Changing the length.** Edit `timerMinutes` in
`MagicMirror/config/config.js`, then restart: `pm2 restart mm`. Config changes
need a restart; only `schedule.json` reloads by itself.

```js
{
    module: "MMM-AssistCare",
    config: {
        timerMinutes: 10,     // was 5
    }
}
```

There is only one timer and one duration. A second hold stops it rather than
starting a second one.

---

## 4. The medication list

Medicines live in
`MagicMirror/modules/MMM-AssistCare/data/schedule.json`, under `medications`.
**The file reloads by itself within 5 seconds — no restart.**

```json
{
  "medications": [
    { "id": "morning-bp", "time": "08:00", "name": "Blood pressure tablet", "dose": "1 tablet with a glass of water" },
    { "id": "lunch-vitd", "time": "13:00", "name": "Vitamin D",             "dose": "1 capsule with food" },
    { "id": "evening-bp", "time": "20:00", "name": "Evening tablet",        "dose": "1 tablet after dinner", "days": ["mon","wed","fri"] }
  ]
}
```

| Field | Rules |
| --- | --- |
| `id` | Required, unique, and **never change it** — it is the key used to record "taken". Changing it loses that medicine's history for the day. |
| `time` | 24-hour `HH:MM`. |
| `name` | Shown large and spoken aloud. |
| `dose` | Optional second line, also spoken. |
| `days` | Optional. Omit for every day, or list `["mon","wed","fri"]`. |

### To add a medicine

```bash
ssh embeddedproject@smartmirror
nano ~/MagicMirror/modules/MMM-AssistCare/data/schedule.json
```

Copy an existing line, change all four fields, keep the JSON valid (commas
between entries, none after the last). Save. Within 5 seconds the mirror shows
it. **If the file has a syntax error the mirror keeps the previous schedule and
logs the problem** — check with `pm2 logs mm`.

### What the statuses mean

| On screen | Meaning |
| --- | --- |
| no badge | Upcoming, later today |
| `Due now` | Its time has passed and it has not been taken |
| `✓ 08:15` | Acknowledged at that time |
| `Not taken` | Missed — either ignored through three repeats, or its time passed more than an hour before the Pi booted |

### How a dose gets marked taken

At the set time a full-screen reminder appears, the mirror speaks the name and
dose, and the amber LED blinks. **Acknowledge it with a hand near the mirror.**
Medicine rows are not clickable, by design — only the reminder can mark a dose
taken, so a stray tap cannot falsify the record.

If nobody acknowledges it, the reminder repeats every 5 minutes
(`repeatMinutes`), three times (`maxRepeats`), then the dose is recorded as
`Not taken` and the mirror moves on.

### Exercises and the checklist

Same file, same reload behaviour.

```json
"exercises": [
  { "id": "shoulder-rolls", "time": "10:30", "title": "Gentle shoulder rolls",
    "steps": ["Sit up straight in a chair", "Roll your shoulders back 5 times"] }
],
"checklist": [
  { "id": "teeth", "label": "Brush teeth" }
]
```

Exercises behave like medicines but show their `steps` as a numbered list.
Checklist items have no time — they are simply ticked off through the day and
reset at midnight.

---

## 5. Appointments

Read from `MagicMirror/modules/MMM-AssistCare/data/appointments.ics`, shown top
right, and announced 60 and 15 minutes ahead (`appointmentLeadMinutes`).

To use a real calendar instead, put a Google Calendar **private iCal address**
in the `calendar` module's `url` in `config.js`, then `pm2 restart mm`. The
calendar refetches hourly, so an edit to the `.ics` file is not immediate.

---

## 6. Diagnostics panel

**Triple-click the clock, or press `A`.** Closes with `Esc`, the Close button,
or by itself after 60 s with nothing pressed.

Shows: serial link state and port, the board's own uptime, live ultrasonic
distance (polled 4× a second, only while open), PIR state, counters for motion,
hand, hand-hold and HELP events, and the last eight lines received from the
board verbatim.

Buttons: each LED on or blinking, all off, buzzer, speaker test, test reminder,
ping the board, and trigger or cancel HELP.

Two things to know: while the panel is open the LEDs stay where you put them
(the mirror's own LED logic stands down until you close it), and the screen will
not sleep.

---

## 7. Running and maintaining it

```bash
pm2 start mm            # start the mirror
pm2 stop mm             # stop it
pm2 restart mm          # after any config.js or module change
pm2 logs mm             # live log
pm2 logs mm --lines 50 --nostream    # last 50 lines and exit
```

**Clear the day's progress** (before a demo):

```bash
rm ~/MagicMirror/modules/MMM-AssistCare/data/state.json
pm2 restart mm
```

**Deploy a changed module file** from the repo:

```bash
scp MagicMirror/modules/MMM-AssistCare/node_helper.js \
    embeddedproject@smartmirror:MagicMirror/modules/MMM-AssistCare/
ssh embeddedproject@smartmirror "pm2 restart mm"
```

**Upload firmware** — board **Arduino Mega or Mega 2560**, processor
**ATmega2560**. The sketch is `arduino/smartmirror_node/smartmirror_node.ino`.
Unplug the board from the Pi first; only one machine can hold the port.

---

## 8. What needs a restart, and what does not

| Change | Restart needed? |
| --- | --- |
| `data/schedule.json` — medicines, exercises, checklist | **No**, reloads in 5 s |
| `data/appointments.ics` | Within the hour, or restart to force it |
| `config.js` — any setting | **Yes** |
| Module `.js` or `.css` | **Yes** |
| Firmware | Re-upload to the board |

---

## 9. When something looks wrong

| Symptom | Cause |
| --- | --- |
| "Sensors disconnected" on screen | The board is unplugged or the cable is charge-only. Check `ls /dev/ttyACM*` on the Pi. |
| Nothing responds to the hand | Open diagnostics and watch the distance readout. No numbers means no link; numbers that never change means the sensor is blocked or mis-wired. |
| A medicine shows `Not taken` straight after boot | Its time passed more than `catchUpMinutes` (60) before the Pi started. Expected. |
| The checklist ticks several items at once | The hand cooldown is too short for your sensor. Raise `handCooldownMs`. |
| PIR never goes idle | Its on-board time-delay pot is turned up. Turn it anticlockwise; the Pi handles the hold. |
| No speech | `espeak-ng` missing, or no audio device. Use the Speaker button in diagnostics to test. |
| Screen never sleeps | The output name in `config.js` (`HDMI-A-2`) must match `wlr-randr` on the Pi. |
