/*
 * Assistive Smart Mirror — Arduino Uno sensor/output controller
 *
 * Reads: PIR (approach), HC-SR04 (near-hand input), HELP button.
 * Drives: red/amber/green LEDs and an active buzzer (via NPN transistor).
 * Talks to the Raspberry Pi over USB serial, 115200 baud, newline-terminated.
 * Protocol and wiring: see docs/PROTOCOL.md
 *
 * Everything is non-blocking except the ultrasonic echo read, which is
 * capped at ECHO_TIMEOUT_US (~6 ms).
 */

// ---------------- Pins ----------------
const uint8_t PIN_PIR    = 2;
const uint8_t PIN_HELP   = 3;
const uint8_t PIN_BUZZER = 6;
const uint8_t PIN_TRIG   = 7;
const uint8_t PIN_ECHO   = 8;
const uint8_t PIN_LED_R  = 9;
const uint8_t PIN_LED_A  = 10;
const uint8_t PIN_LED_G  = 11;

// ---------------- Tuning ----------------
const uint16_t HAND_CM            = 12;    // hand counts as "near" below this distance
const uint16_t HAND_MIN_MS        = 300;   // must stay near this long to count
const uint16_t HAND_HOLD_MS       = 1500;  // held this long -> HANDHOLD
const uint16_t HAND_COOLDOWN_MS   = 1000;  // after a gesture, wait this long (and for hand removal)
const uint8_t  HAND_RELEASE_READS = 2;     // consecutive "far" reads before the hand is considered gone
const uint16_t SONAR_INTERVAL_MS  = 60;    // HC-SR04 needs >= 60 ms between pings
const unsigned long ECHO_TIMEOUT_US = 6000; // ~1 m max range; we only care about close hands
const uint16_t HELP_DEBOUNCE_MS   = 30;
const uint16_t HELP_LOCKOUT_MS    = 2000;  // ignore repeat presses for this long
const uint16_t PIR_STABLE_MS      = 50;    // ignore PIR glitches shorter than this
const uint16_t BLINK_HALF_MS      = 250;   // 2 Hz blink
const uint16_t PULSE_HALF_MS      = 250;
const uint16_t BEEP_MS            = 150;

// ---------------- Output state ----------------
enum OutMode : uint8_t { OUT_OFF, OUT_ON, OUT_BLINK, OUT_BEEP };
OutMode ledMode[3] = { OUT_OFF, OUT_OFF, OUT_OFF };   // R, A, G
const uint8_t ledPins[3] = { PIN_LED_R, PIN_LED_A, PIN_LED_G };
OutMode buzzMode = OUT_OFF;   // OUT_BLINK is used as "PULSE"
unsigned long beepUntil = 0;

// ---------------- Input state ----------------
bool pirState = false, pirRaw = false;
unsigned long pirChangedAt = 0;

bool helpRaw = false, helpStable = false;
unsigned long helpChangedAt = 0, helpLastFired = 0;

enum HandState : uint8_t { H_IDLE, H_NEAR, H_HELD, H_COOLDOWN };
HandState handState = H_IDLE;
unsigned long handNearSince = 0, handGestureAt = 0, lastSonarAt = 0;
uint8_t farReads = 0;

bool debugDist = false;
unsigned long lastDebugAt = 0;

char rxBuf[32];
uint8_t rxLen = 0;

// ---------------------------------------------------------------------------
void setup() {
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_HELP, INPUT_PULLUP);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  for (uint8_t i = 0; i < 3; i++) pinMode(ledPins[i], OUTPUT);
  digitalWrite(PIN_TRIG, LOW);

  Serial.begin(115200);

  // Power-on self test: each LED + short beep, so a wiring fault is visible.
  for (uint8_t i = 0; i < 3; i++) { digitalWrite(ledPins[i], HIGH); delay(150); digitalWrite(ledPins[i], LOW); }
  digitalWrite(PIN_BUZZER, HIGH); delay(80); digitalWrite(PIN_BUZZER, LOW);

  pirRaw = pirState = digitalRead(PIN_PIR);
  helpRaw = helpStable = (digitalRead(PIN_HELP) == LOW);
  Serial.println(F("READY"));
}

void loop() {
  unsigned long now = millis();
  readSerial();
  updatePir(now);
  updateHelp(now);
  if (now - lastSonarAt >= SONAR_INTERVAL_MS) {
    lastSonarAt = now;
    updateHand(now, readDistanceCm());
  }
  updateOutputs(now);
}

// ---------------- Serial commands ----------------
void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      rxBuf[rxLen] = '\0';
      if (rxLen > 0) handleCommand(rxBuf);
      rxLen = 0;
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = c;
    } else {
      rxLen = 0;   // overlong line: drop it
    }
  }
}

OutMode parseMode(const char *s) {
  if (!strcmp(s, "ON")) return OUT_ON;
  if (!strcmp(s, "BLINK") || !strcmp(s, "PULSE")) return OUT_BLINK;
  if (!strcmp(s, "BEEP")) return OUT_BEEP;
  return OUT_OFF;
}

void handleCommand(char *cmd) {
  if (!strcmp(cmd, "PING")) { Serial.println(F("PONG")); return; }
  if (!strcmp(cmd, "ALL:OFF")) {
    for (uint8_t i = 0; i < 3; i++) ledMode[i] = OUT_OFF;
    buzzMode = OUT_OFF;
    return;
  }
  if (!strcmp(cmd, "DEBUG:ON"))  { debugDist = true;  return; }
  if (!strcmp(cmd, "DEBUG:OFF")) { debugDist = false; return; }

  // LED:R:ON  (len >= 6, cmd[3]==':' and cmd[5]==':')
  if (!strncmp(cmd, "LED:", 4) && strlen(cmd) >= 7 && cmd[5] == ':') {
    int8_t idx = cmd[4] == 'R' ? 0 : cmd[4] == 'A' ? 1 : cmd[4] == 'G' ? 2 : -1;
    if (idx >= 0) ledMode[idx] = parseMode(cmd + 6);
    return;
  }
  if (!strncmp(cmd, "BUZZ:", 5)) {
    OutMode m = parseMode(cmd + 5);
    if (m == OUT_BEEP) { beepUntil = millis() + BEEP_MS; }
    else buzzMode = m;
  }
}

// ---------------- PIR ----------------
void updatePir(unsigned long now) {
  bool raw = digitalRead(PIN_PIR) == HIGH;
  if (raw != pirRaw) { pirRaw = raw; pirChangedAt = now; }
  if (pirRaw != pirState && now - pirChangedAt >= PIR_STABLE_MS) {
    pirState = pirRaw;
    Serial.println(pirState ? F("MOTION") : F("NOMOTION"));
  }
}

// ---------------- HELP button ----------------
void updateHelp(unsigned long now) {
  bool raw = digitalRead(PIN_HELP) == LOW;   // pressed = LOW (pull-up)
  if (raw != helpRaw) { helpRaw = raw; helpChangedAt = now; }
  if (helpRaw != helpStable && now - helpChangedAt >= HELP_DEBOUNCE_MS) {
    helpStable = helpRaw;
    if (helpStable && (helpLastFired == 0 || now - helpLastFired >= HELP_LOCKOUT_MS)) {
      helpLastFired = now;
      Serial.println(F("HELP"));
      beepUntil = now + BEEP_MS;   // immediate local feedback even before the Pi reacts
    }
  }
}

// ---------------- HC-SR04 hand input ----------------
// Returns distance in cm, or 0 if nothing within range / no echo.
uint16_t readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  return us == 0 ? 0 : (uint16_t)(us / 58);
}

void updateHand(unsigned long now, uint16_t cm) {
  if (debugDist && now - lastDebugAt >= 250) {
    lastDebugAt = now;
    Serial.print(F("DIST:")); Serial.println(cm);
  }

  bool near = (cm > 1 && cm < HAND_CM);   // <=1 cm readings are usually noise
  if (near) farReads = 0; else if (farReads < 255) farReads++;
  bool gone = farReads >= HAND_RELEASE_READS;

  switch (handState) {
    case H_IDLE:
      if (near) { handState = H_NEAR; handNearSince = now; }
      break;

    case H_NEAR:
      if (gone) {
        // Released: was it held long enough to be deliberate?
        if (now - handNearSince >= HAND_MIN_MS) {
          Serial.println(F("HAND"));
          handGestureAt = now;
          handState = H_COOLDOWN;
        } else {
          handState = H_IDLE;   // too brief: ignore (passing arm, noise)
        }
      } else if (now - handNearSince >= HAND_HOLD_MS) {
        Serial.println(F("HANDHOLD"));
        handGestureAt = now;
        handState = H_HELD;
      }
      break;

    case H_HELD:
      if (gone) handState = H_COOLDOWN;
      break;

    case H_COOLDOWN:
      if (gone && now - handGestureAt >= HAND_COOLDOWN_MS) handState = H_IDLE;
      break;
  }
}

// ---------------- LEDs / buzzer ----------------
void updateOutputs(unsigned long now) {
  bool blinkPhase = (now / BLINK_HALF_MS) % 2 == 0;
  for (uint8_t i = 0; i < 3; i++) {
    bool on = ledMode[i] == OUT_ON || (ledMode[i] == OUT_BLINK && blinkPhase);
    digitalWrite(ledPins[i], on ? HIGH : LOW);
  }

  bool pulsePhase = (now / PULSE_HALF_MS) % 2 == 0;
  bool buzz = buzzMode == OUT_ON
           || (buzzMode == OUT_BLINK && pulsePhase)
           || (long)(beepUntil - now) > 0;
  digitalWrite(PIN_BUZZER, buzz ? HIGH : LOW);
}
