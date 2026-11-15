/* global Module, Log */
/* MMM-AssistCare — frontend. Renders the state sent by node_helper.js. */

Module.register("MMM-AssistCare", {
	configDeepMerge: true, // so overriding e.g. tts.engine keeps the other tts defaults

	defaults: {
		userName: "",
		timeFormat: 24,                 // 12 or 24 (spoken times)
		scheduleFile: "data/schedule.json",
		stateFile: "data/state.json",
		serialPort: "",                 // "" = auto-detect, or e.g. "/dev/ttyACM0"

		catchUpMinutes: 60,             // after a reboot, still remind if the dose was this recent
		repeatMinutes: 5,               // repeat an unacknowledged reminder every N minutes
		maxRepeats: 3,                  // then mark medication as missed and move on
		appointmentLeadMinutes: [60, 15],
		timerMinutes: 5,

		screenTimeoutSec: 300,          // screen off after no motion for this long (never during alerts)
		welcomeCooldownMinutes: 30,
		speakWelcome: true,
		speakHowToAcknowledge: true,

		helpSpeech: "Help has been requested. Please stay calm, someone is coming.",
		helpBuzzSeconds: 30,
		helpCancelByHandHold: true,     // a 1.5 s hand hold cancels HELP (for the carer)

		keyboardSimulation: true,       // M motion, H hand, J hand-hold, E help, C cancel help, R test reminder

		tts: {
			enabled: true,
			engine: "espeak",           // "espeak" or "piper"
			voice: "en-gb",
			rate: 140,                  // espeak words per minute (slower = clearer)
			volume: 150,                // espeak amplitude 0–200
			piperBin: "/home/pi/piper/piper",
			piperModel: "/home/pi/piper/en_GB-alba-medium.onnx"
		},

		screen: {
			onCommand: "wlr-randr --output HDMI-A-1 --on",
			offCommand: "wlr-randr --output HDMI-A-1 --off",
			env: { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000" }
		}
	},

	getStyles () {
		return ["MMM-AssistCare.css"];
	},

	start () {
		this.acState = null;
		this.sendSocketNotification("AC_INIT", this.config);
		// Live countdown for the timer; everything else changes only when the helper says so.
		setInterval(() => {
			if (this.acState && this.acState.timer.running) this.updateTimerText();
		}, 1000);
		if (this.config.keyboardSimulation) this.bindKeys();
	},

	notificationReceived (notification, payload) {
		if (notification === "CALENDAR_EVENTS") {
			this.sendSocketNotification("AC_CALENDAR", payload);
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "AC_STATE") {
			this.acState = payload;
			this.updateDom(0);
		}
	},

	bindKeys () {
		const map = { m: "MOTION", h: "HAND", j: "HANDHOLD", e: "HELP", c: "CANCELHELP" };
		document.addEventListener("keydown", (e) => {
			const k = e.key.toLowerCase();
			if (map[k]) this.sendSocketNotification("AC_INPUT", { event: map[k] });
			else if (k === "r") this.sendSocketNotification("AC_TEST_REMINDER");
		});
	},

	// ------------------------------------------------------------------ rendering
	el (tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	},

	getDom () {
		const root = this.el("div", "ac-root");
		const s = this.acState;
		if (!s) {
			root.appendChild(this.el("div", "ac-muted", "Starting…"));
			return root;
		}

		if (s.welcome) root.appendChild(this.el("div", "ac-welcome", s.welcome));

		const grid = this.el("div", "ac-grid");
		grid.appendChild(this.renderMeds(s.meds));
		grid.appendChild(this.renderChecklist(s.checklist));
		root.appendChild(grid);

		if (s.timer.running) {
			const t = this.el("div", "ac-timer");
			t.appendChild(this.el("span", "ac-timer-label", "Timer"));
			this.timerEl = this.el("span", "ac-timer-value", "");
			t.appendChild(this.timerEl);
			root.appendChild(t);
			this.updateTimerText();
		}

		root.appendChild(this.renderHint(s));

		if (!s.sensors.connected) {
			root.appendChild(this.el("div", "ac-status", s.sensors.available ? "Sensors disconnected — reconnecting…" : "Sensors not installed"));
		}

		if (s.help.active) root.appendChild(this.renderHelp(s.help));
		else if (s.alert) root.appendChild(this.renderAlert(s.alert, s.queued));

		return root;
	},

	renderMeds (meds) {
		const box = this.el("section", "ac-card");
		box.appendChild(this.el("h2", "ac-h", "Medicines today"));
		if (!meds.length) box.appendChild(this.el("div", "ac-muted", "None scheduled"));
		const labels = { upcoming: "", due: "Due now", taken: "Taken", missed: "Not taken" };
		for (const m of meds) {
			const row = this.el("div", `ac-row ac-med-${m.status}`);
			row.appendChild(this.el("span", "ac-time", m.time));
			const name = this.el("span", "ac-name", m.name);
			if (m.dose) name.appendChild(this.el("span", "ac-sub", m.dose));
			row.appendChild(name);
			row.appendChild(this.el("span", "ac-badge", m.status === "taken" ? `✓ ${m.takenAt}` : labels[m.status]));
			box.appendChild(row);
		}
		return box;
	},

	renderChecklist (tasks) {
		const box = this.el("section", "ac-card");
		const done = tasks.filter((t) => t.doneAt).length;
		box.appendChild(this.el("h2", "ac-h", `Today's list  ${done}/${tasks.length}`));
		let nextMarked = false;
		for (const t of tasks) {
			const isNext = !t.doneAt && !nextMarked;
			if (isNext) nextMarked = true;
			const row = this.el("div", `ac-row ac-task${t.doneAt ? " ac-done" : ""}${isNext ? " ac-next" : ""}`);
			row.appendChild(this.el("span", "ac-check", t.doneAt ? "✓" : "○"));
			row.appendChild(this.el("span", "ac-name", t.label));
			if (t.doneAt) row.appendChild(this.el("span", "ac-badge", t.doneAt));
			row.addEventListener("click", () => this.sendSocketNotification("AC_TOGGLE_TASK", { id: t.id }));
			box.appendChild(row);
		}
		return box;
	},

	renderHint (s) {
		let text;
		if (s.alert) text = "Hold your hand near the mirror to confirm";
		else if (s.checklist.some((t) => !t.doneAt)) text = "Hand near the mirror: tick next task  ·  Hold: start/stop timer";
		else text = "Hold your hand near the mirror to start a timer";
		return this.el("div", "ac-hint", text);
	},

	renderAlert (a, queued) {
		const ov = this.el("div", `ac-overlay ac-overlay-${a.kind}`);
		const card = this.el("div", "ac-alert");
		const icons = { medication: "💊", exercise: "🧘", appointment: "📅", timer: "⏰" };
		card.appendChild(this.el("div", "ac-alert-icon", icons[a.kind] || "🔔"));
		card.appendChild(this.el("div", "ac-alert-title", a.title));
		if (a.detail) card.appendChild(this.el("div", "ac-alert-detail", a.detail));
		if (a.steps && a.steps.length) {
			const ol = this.el("ol", "ac-steps");
			a.steps.forEach((st) => ol.appendChild(this.el("li", "", st)));
			card.appendChild(ol);
		}
		card.appendChild(this.el("div", "ac-alert-ack", "Hold your hand near the mirror when done"));
		if (queued) card.appendChild(this.el("div", "ac-muted", `${queued} more reminder${queued > 1 ? "s" : ""} waiting`));
		ov.appendChild(card);
		return ov;
	},

	renderHelp (help) {
		const ov = this.el("div", "ac-overlay ac-overlay-help");
		const card = this.el("div", "ac-alert");
		card.appendChild(this.el("div", "ac-help-title", "HELP REQUESTED"));
		const t = new Date(help.since);
		card.appendChild(this.el("div", "ac-alert-detail", `Pressed at ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`));
		card.appendChild(this.el("div", "ac-alert-detail", "Someone is coming. Stay where you are."));
		if (this.config.helpCancelByHandHold) card.appendChild(this.el("div", "ac-muted", "Carer: hold a hand near the mirror for 2 seconds to cancel"));
		ov.appendChild(card);
		return ov;
	},

	updateTimerText () {
		if (!this.timerEl || !this.acState || !this.acState.timer.running) return;
		const left = Math.max(0, Math.round((this.acState.timer.endsAt - Date.now()) / 1000));
		this.timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
	}
});
