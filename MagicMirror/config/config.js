/* Assistive Smart Mirror — MagicMirror² configuration
 * Copy to ~/MagicMirror/config/config.js
 * Edit reminders/checklist in modules/MMM-AssistCare/data/schedule.json (reloaded automatically).
 * Edit appointments in modules/MMM-AssistCare/data/appointments.ics, or replace the url with a Google Calendar
 * "secret address in iCal format".
 */
let config = {
	address: "localhost",
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],

	language: "en",
	locale: "en-GB",
	timeFormat: 24,
	units: "metric",

	modules: [
		{
			module: "alert"
		},
		{
			module: "clock",
			position: "top_left",
			config: {
				displaySeconds: false,
				showPeriod: false,
				showWeek: false,
				dateFormat: "dddd, D MMMM YYYY"
			}
		},
		{
			module: "calendar",
			header: "Appointments",
			position: "top_right",
			config: {
				maximumEntries: 4,
				maximumNumberOfDays: 14,
				fade: false,
				showLocation: true,
				timeFormat: "absolute",
				dateFormat: "ddd D MMM, HH:mm",
				fullDayEventDateFormat: "ddd D MMM",
				getRelative: 0,
				urgency: 0,
				broadcastEvents: true,          // MMM-AssistCare listens to these for spoken reminders
				calendars: [
					{
						symbol: "calendar-check",
						url: "http://localhost:8080/modules/MMM-AssistCare/data/appointments.ics"
					}
				]
			}
		},
		{
			module: "MMM-AssistCare",
			position: "middle_center",
			config: {
				userName: "Sara",               // shown and spoken in the welcome — change to the user's name
				timeFormat: 12,                 // spoken times: "8 AM" is easier to follow than "08:00"
				repeatMinutes: 5,
				maxRepeats: 3,
				appointmentLeadMinutes: [60, 15],
				timerMinutes: 5,
				screenTimeoutSec: 300,
				keyboardSimulation: true,       // M/H/J/E/C/R keys — turn off for the final demo if a keyboard is attached
				tts: {
					engine: "espeak"            // switch to "piper" after installing it (scripts/setup-pi.sh --piper)
				}
			}
		}
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
