/* MMM-AssistCare — backend (runs in MagicMirror's Node process)
 *
 * Owns everything that must keep working even if the browser view reloads:
 *   - USB serial link to the Arduino (MOTION / HAND / HANDHOLD / HELP in, LED / BUZZ out)
 *   - medication, exercise and appointment reminder scheduling
 *   - daily checklist + "taken at" state, saved to data/state.json
 *   - text-to-speech queue (espeak-ng or Piper)
 *   - screen wake / sleep
 * The frontend only renders the state object this helper broadcasts.
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

let Log;
try { Log = require("logger"); } catch (e) { Log = console; }

// serialport is optional so the module still runs (with keyboard simulation) on a laptop.
let SerialPort = null, ReadlineParser = null;
try {
	({ SerialPort } = require("serialport"));
	({ ReadlineParser } = require("@serialport/parser-readline"));
} catch (e) {
	Log.warn("[AssistCare] serialport not installed — running without Arduino (keyboard simulation only).");
}

const ARDUINO_VENDOR_IDS = ["2341", "2a03", "1a86", "0403", "10c4"]; // Arduino, Arduino.org, CH340, FTDI, CP210x
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The sketch on the Mega (smartmirror_mega.ino) speaks its own wire protocol,
// which is not the set of internal event names used below. Everything crossing
// the serial link is translated here, so the rest of the helper keeps working
// unchanged with keyboard simulation and with any future firmware.
//
//   Mega -> Pi   RDY:UNO:1 | EVT:MOTION:1 | EVT:MOTION:0 | EVT:HELP | HB:<ms> | ERR:<text>
//   Pi -> Mega   LED:<RED|AMBER|GREEN|ALL>:<ON|OFF|BLINK> | PING
const LED_WIRE_NAMES = { R: "RED", A: "AMBER", G: "GREEN" };

module.exports = NodeHelper.create({
	start () {
		this.started = false;
	},

	// ------------------------------------------------------------------ setup
	socketNotificationReceived (notification, payload) {
		if (notification === "AC_INIT") {
			if (!this.started) {
				this.started = true;
				this.cfg = payload;
				this.setupAssist();
			}
			this.broadcast();
		} else if (!this.started) {
			return;
		} else if (notification === "AC_INPUT") {
			this.handleEvent(String(payload.event || ""), "keyboard");
		} else if (notification === "AC_TOGGLE_TASK") {
			this.toggleTask(payload.id);
		} else if (notification === "AC_CALENDAR") {
			this.calendarEvents = Array.isArray(payload) ? payload : [];
		} else if (notification === "AC_TEST_REMINDER") {
			this.pushAlert({ kind: "medication", refId: "test", title: "Test reminder", detail: "This is a test reminder." });
		} else if (notification === "AC_ADMIN_SET") {
			this.setAdmin(!!payload.open);
		} else if (notification === "AC_ADMIN_ACTION") {
			this.adminAction(String(payload.action || ""));
		}
	},

	// Not named init(): MagicMirror's NodeHelper calls its own init() on load, before any config exists.
	setupAssist () {
		this.scheduleFile = path.resolve(this.path, this.cfg.scheduleFile);
		this.stateFile = path.resolve(this.path, this.cfg.stateFile);

		this.schedule = { medications: [], exercises: [], checklist: [] };
		this.calendarEvents = [];
		this.alerts = [];               // queue; alerts[0] is on screen
		this.help = { active: false, since: null };
		this.timer = { running: false, endsAt: null, durationSec: 0 };
		this.welcome = { text: "", until: 0 };
		this.lastMotionAt = Date.now(); // treat boot as "someone is here"
		this.lastWelcomeAt = 0;
		this.screenOn = null;           // unknown until first set
		this.serial = { connected: false, port: null, lastRxAt: 0 };
		this.ledCache = {};
		this.speechQueue = [];
		this.speaking = false;
		this.helpBuzzTimer = null;

		// Diagnostics, shown in the admin panel. Counters run from boot; the
		// distance is only polled while the panel is open, so the serial link
		// stays quiet in normal use.
		this.admin = { open: false, openedAt: 0 };
		this.counts = { motion: 0, hand: 0, gesture: 0, help: 0 };
		this.distance = { cm: null, at: 0 };
		this.boardUptimeMs = null;      // from the board's own HB counter
		this.rawLines = [];             // last few lines straight off the wire

		this.loadSchedule();
		this.loadState();
		fs.watchFile(this.scheduleFile, { interval: 5000 }, () => {
			Log.info("[AssistCare] schedule.json changed — reloading");
			this.loadSchedule();
			this.broadcast();
		});

		this.setScreen(true);
		this.connectSerial();
		setInterval(() => this.tick(), 10 * 1000);
		setInterval(() => this.serialHeartbeat(), 5 * 1000);
		this.tick();
		Log.info("[AssistCare] started");
	},

	// ------------------------------------------------------------------ files
	loadSchedule () {
		try {
			const raw = JSON.parse(fs.readFileSync(this.scheduleFile, "utf8"));
			this.schedule = {
				medications: Array.isArray(raw.medications) ? raw.medications : [],
				exercises: Array.isArray(raw.exercises) ? raw.exercises : [],
				checklist: Array.isArray(raw.checklist) ? raw.checklist : []
			};
		} catch (e) {
			Log.error(`[AssistCare] cannot read ${this.scheduleFile}: ${e.message} — keeping previous schedule`);
		}
	},

	emptyState () {
		return { date: this.todayKey(), checklistDone: {}, medsTaken: {}, medsMissed: {}, exercisesDone: {}, fired: {} };
	},

	loadState () {
		try {
			this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
		} catch (e) {
			this.state = this.emptyState();
		}
		const fresh = this.emptyState();
		this.state = { ...fresh, ...this.state };
		if (this.state.date !== this.todayKey()) this.state = fresh;
	},

	saveState () {
		const tmp = `${this.stateFile}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
			fs.renameSync(tmp, this.stateFile); // atomic: no half-written file after a power cut
		} catch (e) {
			Log.error(`[AssistCare] cannot save state: ${e.message}`);
		}
	},

	// ------------------------------------------------------------------ time helpers
	todayKey (d = new Date()) {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	},

	minutesOfDay (hhmm) {
		const [h, m] = String(hhmm).split(":").map(Number);
		return h * 60 + (m || 0);
	},

	appliesToday (item, now) {
		if (!Array.isArray(item.days) || item.days.length === 0) return true;
		return item.days.map((d) => String(d).toLowerCase().slice(0, 3)).includes(DAY_KEYS[now.getDay()]);
	},

	spokenTime (d) {
		let h = d.getHours();
		const m = d.getMinutes();
		if (this.cfg.timeFormat === 12) {
			const ampm = h < 12 ? "AM" : "PM";
			h = h % 12 || 12;
			return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, "0")} ${ampm}`;
		}
		return `${h}:${String(m).padStart(2, "0")}`;
	},

	shownTime (d) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	},

	greeting (d) {
		const h = d.getHours();
		const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
		return this.cfg.userName ? `${part}, ${this.cfg.userName}` : part;
	},

	// ------------------------------------------------------------------ scheduler
	tick () {
		const now = new Date();
		const nowMs = now.getTime();

		if (this.state.date !== this.todayKey(now)) {
			Log.info("[AssistCare] new day — resetting checklist and reminders");
			this.state = this.emptyState();
			this.alerts = this.alerts.filter((a) => a.kind === "timer");
			this.saveState();
		}

		const nowMin = now.getHours() * 60 + now.getMinutes();
		const catchUp = this.cfg.catchUpMinutes;

		// Medications + exercises: fire once per day at their time (or late after a reboot, within catchUpMinutes).
		const scheduled = [
			...this.schedule.medications.map((m) => ({ ...m, kind: "medication" })),
			...this.schedule.exercises.map((x) => ({ ...x, kind: "exercise" }))
		];
		for (const item of scheduled) {
			if (!item.id || !item.time || !this.appliesToday(item, now)) continue;
			const key = `${item.kind}:${item.id}`;
			if (this.state.fired[key]) continue;
			const due = this.minutesOfDay(item.time);
			if (nowMin >= due && nowMin - due <= catchUp) {
				this.state.fired[key] = true;
				this.saveState();
				if (item.kind === "medication") {
					this.pushAlert({
						kind: "medication", refId: item.id, title: item.name,
						detail: item.dose || "",
						speech: `It is time to take ${item.name}. ${item.dose || ""}`
					});
				} else {
					this.pushAlert({
						kind: "exercise", refId: item.id, title: item.title,
						steps: item.steps || [],
						speech: `Time for a short exercise: ${item.title}. ${(item.steps || []).join(". ")}`
					});
				}
			} else if (item.kind === "medication" && nowMin - due > catchUp && !this.state.medsTaken[item.id] && !this.state.medsMissed[item.id]) {
				// Booted long after the dose time: record as missed rather than surprising the user hours later.
				this.state.fired[key] = true;
				this.state.medsMissed[item.id] = true;
				this.saveState();
			}
		}

		// Appointments from the built-in calendar module.
		for (const ev of this.calendarEvents) {
			const start = Number(ev.startDate);
			if (!start || ev.fullDayEvent) continue;
			for (const lead of this.cfg.appointmentLeadMinutes) {
				const key = `appt:${ev.title}:${start}:${lead}`;
				if (this.state.fired[key]) continue;
				const minsLeft = (start - nowMs) / 60000;
				if (minsLeft <= lead && minsLeft > lead - 5) {
					this.state.fired[key] = true;
					this.saveState();
					const at = new Date(start);
					const when = lead >= 60 ? `in ${Math.round(lead / 60)} hour${lead >= 120 ? "s" : ""}` : `in ${lead} minutes`;
					this.pushAlert({
						kind: "appointment", refId: key, title: ev.title,
						detail: `at ${this.shownTime(at)}${ev.location ? ` — ${ev.location}` : ""}`,
						speech: `Reminder: ${ev.title} ${when}, at ${this.spokenTime(at)}.${ev.location ? ` Location: ${ev.location}.` : ""}`
					});
				}
			}
		}

		// Timer finished.
		if (this.timer.running && nowMs >= this.timer.endsAt) {
			this.timer = { running: false, endsAt: null, durationSec: 0 };
			this.pushAlert({ kind: "timer", refId: "timer", title: "Timer finished", speech: "Your timer has finished." });
		}

		// Repeat unacknowledged alerts; give up after maxRepeats.
		const top = this.alerts[0];
		if (top) {
			if (nowMs - top.lastSpokenAt >= this.cfg.repeatMinutes * 60000) {
				if (top.repeats >= this.cfg.maxRepeats) {
					if (top.kind === "medication" && top.refId !== "test") this.state.medsMissed[top.refId] = true;
					this.saveState();
					this.alerts.shift();
					if (this.alerts[0]) this.announce(this.alerts[0]);
				} else {
					top.repeats++;
					this.announce(top);
				}
			}
		}

		// The admin panel must never be left open in front of the user.
		if (this.admin.open && nowMs - this.admin.openedAt > this.cfg.adminTimeoutSec * 1000) {
			Log.info("[AssistCare] admin panel timed out");
			this.setAdmin(false);
		}

		// Screen sleep when nobody is around and nothing needs attention.
		const idleMs = nowMs - this.lastMotionAt;
		if (this.screenOn && idleMs > this.cfg.screenTimeoutSec * 1000 && !this.alerts.length && !this.help.active && !this.timer.running && !this.admin.open) {
			this.setScreen(false);
		}

		this.updateOutputs();
		this.broadcast();
	},

	pushAlert (alert) {
		const a = { id: `${alert.kind}-${alert.refId}-${Date.now()}`, createdAt: Date.now(), repeats: 0, lastSpokenAt: 0, steps: [], detail: "", ...alert };
		this.alerts.push(a);
		if (this.alerts.length === 1) this.announce(a);
		this.updateOutputs();
		this.broadcast();
	},

	announce (alert) {
		alert.lastSpokenAt = Date.now();
		this.setScreen(true);
		this.sendSerial("BUZZ:BEEP");
		this.speak(alert.speech || alert.title);
		if (alert.kind !== "timer" && this.cfg.speakHowToAcknowledge) {
			this.speak("Hold your hand near the mirror when done.");
		}
	},

	acknowledgeTop (source) {
		const a = this.alerts.shift();
		if (!a) return;
		const now = new Date();
		if (a.kind === "medication" && a.refId !== "test") {
			this.state.medsTaken[a.refId] = this.shownTime(now);
			delete this.state.medsMissed[a.refId];
			this.speak(`${a.title} marked as taken at ${this.spokenTime(now)}.`);
		} else if (a.kind === "exercise") {
			this.state.exercisesDone[a.refId] = this.shownTime(now);
			this.speak("Well done.");
		} else {
			this.speak("OK.");
		}
		this.saveState();
		Log.info(`[AssistCare] acknowledged ${a.kind} "${a.title}" via ${source}`);
		if (this.alerts[0]) setTimeout(() => this.alerts[0] && this.announce(this.alerts[0]), 2500);
	},

	// ------------------------------------------------------------------ inputs
	handleEvent (event, source) {
		const now = Date.now();

		// Distance replies are data for the admin panel, not an input event.
		if (event.startsWith("DIST:")) {
			const cm = Number(event.slice(5));
			this.distance = { cm: Number.isFinite(cm) ? cm : null, at: now };
			if (this.admin.open) this.broadcast();
			return;
		}
		if (event === "MOTION") this.counts.motion++;
		else if (event === "HAND") this.counts.hand++;
		else if (event === "HANDHOLD") this.counts.gesture++;
		else if (event === "HELP") this.counts.help++;

		switch (event) {
			case "READY":
				this.ledCache = {};       // Uno was reset: resend LED states
				this.updateOutputs();
				break;

			case "MOTION":
				this.lastMotionAt = now;
				this.setScreen(true);
				if (now - this.lastWelcomeAt > this.cfg.welcomeCooldownMinutes * 60000) {
					this.lastWelcomeAt = now;
					this.doWelcome();
				}
				// Someone walked up while a reminder is waiting: repeat it now instead of waiting for the next repeat.
				if (this.alerts[0] && now - this.alerts[0].lastSpokenAt > 60000) this.announce(this.alerts[0]);
				break;

			case "NOMOTION":
				this.lastMotionAt = now; // timeout counts from when they left
				break;

			case "HAND":
			case "HANDHOLD":
				this.lastMotionAt = now;
				this.setScreen(true);
				// One wave in front of the ultrasonic sensor produces a burst of
				// HAND events, which would tick the whole checklist in a second.
				// Act on the first and ignore the rest of the burst.
				//
				// A hand HOLD is exempt: it is deliberate, it always arrives about
				// a second after the HAND event that starts it, and it is how a
				// carer cancels a HELP alert. Rate-limiting it would swallow the
				// cancel gesture every time.
				if (event === "HAND") {
					if (now - (this.lastHandActionAt || 0) < this.cfg.handCooldownMs) break;
					this.lastHandActionAt = now;
				}
				if (this.help.active) {
					if (event === "HANDHOLD" && this.cfg.helpCancelByHandHold) this.cancelHelp(source);
				} else if (this.alerts.length) {
					this.acknowledgeTop(source);
				} else if (event === "HAND") {
					this.tickNextTask();
				} else {
					this.toggleTimer();
				}
				break;

			case "HELP":
				this.triggerHelp(source);
				break;

			case "CANCELHELP":
				this.cancelHelp(source);
				break;

			case "PONG":
				break;

			default:
				if (!event.startsWith("DIST:")) Log.warn(`[AssistCare] unknown event "${event}"`);
		}
		this.updateOutputs();
		this.broadcast();
	},

	doWelcome () {
		const now = new Date();
		const remaining = this.schedule.checklist.filter((t) => !this.state.checklistDone[t.id]).length;
		const nowMin = now.getHours() * 60 + now.getMinutes();
		const nextMed = this.schedule.medications
			.filter((m) => this.appliesToday(m, now) && !this.state.medsTaken[m.id] && this.minutesOfDay(m.time) > nowMin)
			.sort((a, b) => this.minutesOfDay(a.time) - this.minutesOfDay(b.time))[0];

		const text = `${this.greeting(now)}`;
		this.welcome = { text, until: Date.now() + 60 * 1000 };

		if (!this.alerts.length && this.cfg.speakWelcome) {
			let s = `${text}. It is ${this.spokenTime(now)}.`;
			if (remaining) s += ` You have ${remaining} task${remaining > 1 ? "s" : ""} left on your list today.`;
			if (nextMed) {
				const at = new Date(now);
				at.setHours(0, this.minutesOfDay(nextMed.time), 0, 0);
				s += ` Your next medicine, ${nextMed.name}, is at ${this.spokenTime(at)}.`;
			}
			this.speak(s);
		}
	},

	tickNextTask () {
		const next = this.schedule.checklist.find((t) => !this.state.checklistDone[t.id]);
		if (!next) {
			this.speak("Everything on today's list is done.");
			return;
		}
		this.state.checklistDone[next.id] = this.shownTime(new Date());
		this.saveState();
		const after = this.schedule.checklist.find((t) => !this.state.checklistDone[t.id]);
		this.speak(`${next.label}, done.${after ? ` Next: ${after.label}.` : " That was the last one. Well done."}`);
	},

	toggleTask (id) {
		if (!this.schedule.checklist.some((t) => t.id === id)) return;
		if (this.state.checklistDone[id]) delete this.state.checklistDone[id];
		else this.state.checklistDone[id] = this.shownTime(new Date());
		this.saveState();
		this.broadcast();
	},

	toggleTimer () {
		if (this.timer.running) {
			this.timer = { running: false, endsAt: null, durationSec: 0 };
			this.speak("Timer cancelled.");
		} else {
			const sec = this.cfg.timerMinutes * 60;
			this.timer = { running: true, endsAt: Date.now() + sec * 1000, durationSec: sec };
			this.speak(`Timer started for ${this.cfg.timerMinutes} minutes.`);
		}
	},

	triggerHelp (source) {
		if (this.help.active) {
			// Pressing HELP again is the fallback way out, for a mirror with no
			// keyboard and no working hand sensor. It is deliberately not instant:
			// a confused user pressing twice in a row must not clear their own
			// alert, so the second press only counts after helpCancelAfterSec.
			const heldFor = Date.now() - this.help.since;
			if (this.cfg.helpCancelBySecondPress && heldFor >= this.cfg.helpCancelAfterSec * 1000) {
				this.cancelHelp(`${source} (second press)`);
			} else {
				Log.info(`[AssistCare] HELP pressed again after ${Math.round(heldFor / 1000)} s — ignored, alert stays up`);
			}
			return;
		}
		this.help = { active: true, since: Date.now() };
		Log.warn(`[AssistCare] HELP triggered via ${source}`);
		this.setScreen(true);
		this.speechQueue = [];        // HELP message goes first
		this.speak(this.cfg.helpSpeech);
		this.sendSerial("BUZZ:PULSE");
		clearTimeout(this.helpBuzzTimer);
		this.helpBuzzTimer = setTimeout(() => this.sendSerial("BUZZ:OFF"), this.cfg.helpBuzzSeconds * 1000);
	},

	cancelHelp (source) {
		if (!this.help.active) return;
		this.help = { active: false, since: null };
		clearTimeout(this.helpBuzzTimer);
		this.sendSerial("BUZZ:OFF");
		Log.info(`[AssistCare] HELP cancelled via ${source}`);
		this.speak("Help alert cancelled.");
	},

	// ------------------------------------------------------------------ admin panel
	setAdmin (open) {
		if (this.admin.open === open) return;
		this.admin = { open, openedAt: open ? Date.now() : 0 };
		clearInterval(this.distTimer);
		this.distTimer = null;

		if (open) {
			Log.info("[AssistCare] admin panel opened");
			this.setScreen(true);
			// Ask for a distance four times a second, but only while the panel
			// is on screen. The rest of the time the link carries events only.
			this.distTimer = setInterval(() => this.sendSerial("DIST?"), 250);
		} else {
			Log.info("[AssistCare] admin panel closed");
			this.distance = { cm: null, at: 0 };
			this.ledCache = {};          // the panel may have left the LEDs anywhere
			this.updateOutputs();
		}
		this.broadcast();
	},

	adminAction (action) {
		if (!this.admin.open) return;
		this.admin.openedAt = Date.now();   // any button press restarts the idle timeout

		if (action.startsWith("led:")) {
			// Drive one LED directly. updateOutputs() stands down while the panel
			// is open, so what the tester sets is what stays lit.
			const [, led, mode] = action.split(":");
			this.sendSerial(`LED:${LED_WIRE_NAMES[led] || led}:${mode}`);
		} else if (action === "buzz") {
			this.sendSerial("BUZZ:300", true);   // explicit test: bypass the no-buzzer guard
		} else if (action === "speak") {
			this.speak("Speaker test. The smart mirror can hear itself.");
		} else if (action === "reminder") {
			this.pushAlert({ kind: "medication", refId: "test", title: "Test reminder", detail: "Triggered from the admin panel." });
		} else if (action === "ping") {
			this.sendSerial("PING");
		} else if (action === "help") {
			this.triggerHelp("admin panel");
		} else if (action === "cancelhelp") {
			this.cancelHelp("admin panel");
		} else {
			Log.warn(`[AssistCare] unknown admin action "${action}"`);
		}
		this.broadcast();
	},

	adminState () {
		const now = Date.now();
		return {
			open: this.admin.open,
			openedAt: this.admin.openedAt,
			counts: { ...this.counts },
			distanceCm: this.distance.cm,
			distanceAgeMs: this.distance.at ? now - this.distance.at : null,
			motionActive: now - this.lastMotionAt < this.cfg.screenTimeoutSec * 1000 && this.counts.motion > 0,
			lastMotionAgoMs: now - this.lastMotionAt,
			screenOn: !!this.screenOn,
			speaking: this.speaking,
			boardUptimeMs: this.boardUptimeMs,
			serial: { ...this.serial, lastRxAgoMs: this.serial.lastRxAt ? now - this.serial.lastRxAt : null },
			raw: this.rawLines.slice(-8)
		};
	},

	// ------------------------------------------------------------------ LEDs
	updateOutputs () {
		// While the admin panel is open the tester owns the LEDs.
		if (this.admin && this.admin.open) return;
		let r = "OFF", a = "OFF", g = "OFF";
		if (this.help.active) r = "BLINK";
		else if (this.alerts.length) a = "BLINK";
		else if (this.screenOn) g = "ON";
		this.setLed("R", r);
		this.setLed("A", a);
		this.setLed("G", g);
	},

	setLed (led, mode) {
		if (this.ledCache[led] === mode) return;
		// The firmware wants full colour names, not single letters.
		if (this.sendSerial(`LED:${LED_WIRE_NAMES[led] || led}:${mode}`)) this.ledCache[led] = mode;
	},

	// ------------------------------------------------------------------ serial
	async connectSerial () {
		if (!SerialPort) return;
		clearTimeout(this.reconnectTimer);
		try {
			let portPath = this.cfg.serialPort;
			if (!portPath) {
				const ports = await SerialPort.list();
				const hit = ports.find((p) => ARDUINO_VENDOR_IDS.includes(String(p.vendorId || "").toLowerCase()))
					|| ports.find((p) => /ttyACM|ttyUSB/.test(p.path));
				portPath = hit && hit.path;
			}
			if (!portPath) throw new Error("no Arduino found");

			const port = new SerialPort({ path: portPath, baudRate: 115200 });
			const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
			this.port = port;

			port.on("open", () => {
				Log.info(`[AssistCare] serial open on ${portPath}`);
				this.serial = { connected: true, port: portPath, lastRxAt: Date.now() };
				this.ledCache = {};
				this.broadcast();
			});
			parser.on("data", (line) => {
				this.serial.lastRxAt = Date.now();
				const raw = String(line).trim();
				if (raw) {
					// Keep the last few lines verbatim so the admin panel can show
					// what the board is really saying, not just the parsed result.
					this.rawLines.push({ at: Date.now(), line: raw });
					if (this.rawLines.length > 12) this.rawLines.shift();
				}
				const ev = this.translateIncoming(raw);
				if (ev) this.handleEvent(ev, "arduino");
			});
			const lost = (why) => {
				if (this.port !== port) return;
				Log.warn(`[AssistCare] serial lost (${why}) — retrying in 3 s`);
				this.port = null;
				this.serial = { connected: false, port: null, lastRxAt: 0 };
				this.broadcast();
				try { if (port.isOpen) port.close(); } catch (e) { /* ignore */ }
				this.reconnectTimer = setTimeout(() => this.connectSerial(), 3000);
			};
			port.on("close", () => lost("closed"));
			port.on("error", (e) => lost(e.message));
		} catch (e) {
			if (!this.loggedNoPort) Log.warn(`[AssistCare] serial: ${e.message} — retrying every 3 s`);
			this.loggedNoPort = true;
			this.reconnectTimer = setTimeout(() => this.connectSerial(), 3000);
		}
	},

	// One firmware line in, one internal event name out, or null to ignore it.
	// Anything unknown is logged once rather than silently dropped, so a firmware
	// change shows up in the pm2 log instead of looking like a dead sensor.
	translateIncoming (line) {
		if (!line) return null;
		if (line.startsWith("RDY:")) {
			// The firmware also answers PING with RDY, every 5 s. Treating each one as
			// a fresh boot would clear the LED cache and resend every LED, restarting
			// any blink phase mid-demo. Only a long gap means the board really reset.
			const now = Date.now();
			if (now - (this.lastReadyAt || 0) < 20000) { this.lastReadyAt = now; return null; }
			this.lastReadyAt = now;
			return "READY";
		}
		if (line === "EVT:MOTION:1") return "MOTION";
		if (line === "EVT:MOTION:0") return "NOMOTION";
		if (line === "EVT:HELP") return "HELP";
		if (line.startsWith("HB:")) {                     // heartbeat, proves the link is alive
			const ms = Number(line.slice(3));
			if (Number.isFinite(ms)) this.boardUptimeMs = ms;
			return "PONG";
		}
		// Reserved for step 2, when the HC-SR04 hand sensor is added to the sketch.
		if (line === "EVT:HAND:1") return "HAND";
		if (line === "EVT:HAND:0") return null;
		if (line === "EVT:GESTURE:SELECT") return "HANDHOLD";
		if (line.startsWith("DIST:")) return line;
		if (line.startsWith("ERR:")) {
			Log.warn(`[AssistCare] Arduino rejected a command: ${line}`);
			return null;
		}
		Log.warn(`[AssistCare] unrecognised serial line: ${line}`);
		return null;
	},

	serialHeartbeat () {
		if (!this.port || !this.serial.connected) return;
		if (Date.now() - this.serial.lastRxAt > 15000) {
			Log.warn("[AssistCare] no reply from Arduino for 15 s");
			try { this.port.close(); } catch (e) { /* close handler reconnects */ }
			return;
		}
		this.sendSerial("PING");
	},

	sendSerial (line, force) {
		// This build has no buzzer; the firmware would answer BUZZ with ERR:CMD.
		// Set buzzer: true in the module config if one is fitted and the sketch
		// regains its BUZZ handler. `force` is for the admin panel's own test.
		if (!force && !this.cfg.buzzer && line.startsWith("BUZZ")) return false;
		if (!this.port || !this.serial.connected) return false;
		try {
			this.port.write(`${line}\n`);
			return true;
		} catch (e) {
			return false;
		}
	},

	// ------------------------------------------------------------------ speech
	speak (text) {
		if (!text || !this.cfg.tts.enabled) return;
		this.speechQueue.push(String(text).replace(/\s+/g, " ").trim());
		this.nextSpeech();
	},

	nextSpeech () {
		if (this.speaking || !this.speechQueue.length) return;
		const text = this.speechQueue.shift();
		const t = this.cfg.tts;
		let child;
		this.speaking = true;
		try {
			if (t.engine === "piper") {
				// Text goes in via stdin, never through the shell command line.
				child = spawn("sh", ["-c", "\"$PIPER_BIN\" --model \"$PIPER_MODEL\" --output-raw 2>/dev/null | aplay -q -r 22050 -f S16_LE -t raw -"], {
					env: { ...process.env, PIPER_BIN: t.piperBin, PIPER_MODEL: t.piperModel }
				});
				child.stdin.end(`${text}\n`);
			} else {
				child = spawn("espeak-ng", ["-s", String(t.rate), "-v", t.voice, "-a", String(t.volume), text]);
			}
		} catch (e) {
			Log.error(`[AssistCare] TTS failed: ${e.message}`);
			this.speaking = false;
			return;
		}
		const done = () => {
			if (!this.speaking) return;
			this.speaking = false;
			setTimeout(() => this.nextSpeech(), 300);
		};
		child.on("error", (e) => { Log.error(`[AssistCare] TTS error: ${e.message}`); done(); });
		child.on("close", done);
		setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } done(); }, 30000); // never hang the queue
	},

	// ------------------------------------------------------------------ screen
	setScreen (on) {
		if (this.screenOn === on) return;
		this.screenOn = on;
		const cmd = on ? this.cfg.screen.onCommand : this.cfg.screen.offCommand;
		if (cmd) {
			exec(cmd, { env: { ...process.env, ...this.cfg.screen.env } }, (err) => {
				if (err) Log.warn(`[AssistCare] screen command failed: ${err.message}`);
			});
		}
		this.updateOutputs();
	},

	// ------------------------------------------------------------------ to frontend
	broadcast () {
		if (!this.cfg) return;
		const now = new Date();
		const nowMin = now.getHours() * 60 + now.getMinutes();
		const meds = this.schedule.medications
			.filter((m) => this.appliesToday(m, now))
			.sort((a, b) => this.minutesOfDay(a.time) - this.minutesOfDay(b.time))
			.map((m) => {
				let status = "upcoming";
				if (this.state.medsTaken[m.id]) status = "taken";
				else if (this.alerts.some((a) => a.kind === "medication" && a.refId === m.id)) status = "due";
				else if (this.state.medsMissed[m.id]) status = "missed";
				else if (this.minutesOfDay(m.time) <= nowMin) status = "due";
				return { id: m.id, time: m.time, name: m.name, dose: m.dose || "", status, takenAt: this.state.medsTaken[m.id] || null };
			});

		this.sendSocketNotification("AC_STATE", {
			meds,
			checklist: this.schedule.checklist.map((t) => ({ id: t.id, label: t.label, doneAt: this.state.checklistDone[t.id] || null })),
			alert: this.alerts[0] || null,
			queued: Math.max(0, this.alerts.length - 1),
			help: this.help,
			timer: this.timer,
			welcome: Date.now() < this.welcome.until ? this.welcome.text : "",
			sensors: { available: !!SerialPort, connected: this.serial.connected, port: this.serial.port },
			admin: this.adminState()
		});
	}
});
