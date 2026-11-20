// =============================================================
// Smart Mirror - Arduino node (Mega 2560 / Uno)
// PIR, HC-SR04 hand sensor, HELP button, 3 LEDs, buzzer
// Talks to the Raspberry Pi over USB serial, 115200 baud
// =============================================================
//
// Arduino -> Pi
//   RDY:UNO:1            boot, and reply to PING
//   EVT:MOTION:1 / 0     person present / gone (5 s hold)
//   EVT:HAND:1 / 0       hand in front of mirror (< 20 cm) / gone
//   EVT:GESTURE:SELECT   hand held < 8 cm for 1 s
//   EVT:HELP             HELP pressed (2 s repeat lock)
//   DIST:<cm>            reply to DIST? (-1 = no echo)
//   HB:<millis>          heartbeat every 10 s
//   ERR:<text>           unknown command
//
// Pi -> Arduino
//   LED:<RED|AMBER|GREEN|ALL>:<ON|OFF|BLINK>
//   BUZZ:<1-5000>        beep in ms
//   PING
//   DIST?
// -------------------------------------------------------------

// ---------- Pins ----------
const int PIR_PIN   = 2;
const int TRIG_PIN  = 3;
const int ECHO_PIN  = 4;
const int HELP_PIN  = 5;
const int GREEN_PIN = 8;
const int AMBER_PIN = 9;
const int RED_PIN   = 10;
const int BUZZ_PIN  = 11;

// ---------- Settings ----------
const bool BUZZER_ACTIVE_LOW = false;  // true if your buzzer beeps nonstop

const unsigned long MOTION_HOLD_MS = 5000;
const unsigned long HELP_LOCK_MS   = 2000;
const unsigned long DEBOUNCE_MS    = 30;
const unsigned long HEARTBEAT_MS   = 10000;
const unsigned long BLINK_MS       = 400;
const unsigned long HELP_BLINK_MS  = 5000;
const unsigned long HELP_CHIRP_MS  = 150;
const unsigned long LINE_IDLE_MS   = 50;

const unsigned long PING_EVERY_MS  = 100;
const int  HAND_CM          = 20;
const int  HAND_RELEASE_CM  = 25;   // hysteresis so HAND doesn't flicker
const int  SELECT_CM        = 8;
const unsigned long SELECT_HOLD_MS = 1000;

// ---------- LEDs ----------
enum LedMode { MODE_OFF, MODE_ON, MODE_BLINK };
const int LED_PINS[3] = { RED_PIN, AMBER_PIN, GREEN_PIN };
LedMode ledMode[3]    = { MODE_OFF, MODE_OFF, MODE_ON };
unsigned long redBlinkUntil = 0;
bool blinkPhase = false;
unsigned long lastBlink = 0;

// ---------- Buzzer ----------
unsigned long buzzUntil = 0;
bool buzzing = false;

// ---------- Inputs ----------
bool presence = false;
unsigned long lastMotionHigh = 0;

int  btnStable = HIGH;
int  btnLastRead = HIGH;
unsigned long btnChangedAt = 0;
unsigned long lastHelpAt = 0;
bool helpEverSent = false;

float distanceCm = -1;
bool handNear = false;
unsigned long closeSince = 0;
bool selectSent = false;
unsigned long lastPingAt = 0;

unsigned long lastHeartbeat = 0;

// ---------- Serial ----------
String line = "";
unsigned long lastCharAt = 0;

// =============================================================
void buzzerWrite(bool on) {
  digitalWrite(BUZZ_PIN, (on != BUZZER_ACTIVE_LOW) ? HIGH : LOW);
  buzzing = on;
}

void startBuzz(unsigned long ms) {
  buzzerWrite(true);
  buzzUntil = millis() + ms;
}

void sendReady() { Serial.println("RDY:UNO:1"); }

float readDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 25000);
  if (us == 0) return -1;
  return us / 58.0;
}

// ---------- Commands ----------
int ledIndex(const String &n) {
  if (n == "RED")   return 0;
  if (n == "AMBER") return 1;
  if (n == "GREEN") return 2;
  if (n == "ALL")   return 3;
  return -1;
}

bool parseMode(const String &v, LedMode &out) {
  if (v == "ON")    { out = MODE_ON;    return true; }
  if (v == "OFF")   { out = MODE_OFF;   return true; }
  if (v == "BLINK") { out = MODE_BLINK; return true; }
  return false;
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if (cmd.length() == 0) return;

  if (cmd == "PING") { sendReady(); return; }

  if (cmd == "DIST?") {
    Serial.print("DIST:");
    Serial.println(distanceCm < 0 ? -1 : (int)(distanceCm + 0.5));
    return;
  }

  if (cmd.startsWith("BUZZ:")) {
    long ms = cmd.substring(5).toInt();
    if (ms < 1 || ms > 5000) { Serial.println("ERR:BUZZ range 1-5000"); return; }
    startBuzz(ms);
    return;
  }

  if (cmd.startsWith("LED:")) {
    int sep = cmd.indexOf(':', 4);
    if (sep < 0) { Serial.println("ERR:" + cmd); return; }
    int idx = ledIndex(cmd.substring(4, sep));
    LedMode m;
    if (idx < 0 || !parseMode(cmd.substring(sep + 1), m)) {
      Serial.println("ERR:" + cmd);
      return;
    }
    if (idx == 3) { for (int i = 0; i < 3; i++) ledMode[i] = m; }
    else          { ledMode[idx] = m; }
    if (idx == 0 || idx == 3) redBlinkUntil = 0;
    return;
  }

  Serial.println("ERR:" + cmd);
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    lastCharAt = millis();
    if (c == '\n' || c == '\r') {
      handleCommand(line);
      line = "";
    } else if (line.length() < 40) {
      line += c;
    }
  }
  if (line.length() > 0 && millis() - lastCharAt > LINE_IDLE_MS) {
    handleCommand(line);
    line = "";
  }
}

// ---------- Inputs ----------
void updatePir(unsigned long now) {
  if (digitalRead(PIR_PIN) == HIGH) {
    lastMotionHigh = now;
    if (!presence) {
      presence = true;
      Serial.println("EVT:MOTION:1");
    }
  } else if (presence && now - lastMotionHigh >= MOTION_HOLD_MS) {
    presence = false;
    Serial.println("EVT:MOTION:0");
  }
}

void updateButton(unsigned long now) {
  int r = digitalRead(HELP_PIN);
  if (r != btnLastRead) { btnLastRead = r; btnChangedAt = now; }
  if (now - btnChangedAt < DEBOUNCE_MS || r == btnStable) return;

  btnStable = r;
  if (btnStable == LOW) {
    if (!helpEverSent || now - lastHelpAt >= HELP_LOCK_MS) {
      helpEverSent = true;
      lastHelpAt = now;
      Serial.println("EVT:HELP");
      redBlinkUntil = now + HELP_BLINK_MS;
      startBuzz(HELP_CHIRP_MS);
    }
  }
}

void updateHand(unsigned long now) {
  if (now - lastPingAt < PING_EVERY_MS) return;
  lastPingAt = now;
  distanceCm = readDistance();

  bool valid = distanceCm > 0;
  if (!handNear && valid && distanceCm < HAND_CM) {
    handNear = true;
    Serial.println("EVT:HAND:1");
  } else if (handNear && (!valid || distanceCm > HAND_RELEASE_CM)) {
    handNear = false;
    Serial.println("EVT:HAND:0");
  }

  if (valid && distanceCm < SELECT_CM) {
    if (closeSince == 0) closeSince = now;
    if (!selectSent && now - closeSince >= SELECT_HOLD_MS) {
      selectSent = true;
      Serial.println("EVT:GESTURE:SELECT");
    }
  } else {
    closeSince = 0;
    selectSent = false;
  }
}

// ---------- Outputs ----------
void updateLeds(unsigned long now) {
  if (now - lastBlink >= BLINK_MS) {
    lastBlink = now;
    blinkPhase = !blinkPhase;
  }
  if (redBlinkUntil != 0 && now >= redBlinkUntil) redBlinkUntil = 0;

  for (int i = 0; i < 3; i++) {
    LedMode m = ledMode[i];
    if (i == 0 && redBlinkUntil != 0) m = MODE_BLINK;
    bool on = (m == MODE_ON) || (m == MODE_BLINK && blinkPhase);
    digitalWrite(LED_PINS[i], on ? HIGH : LOW);
  }
}

void updateBuzzer(unsigned long now) {
  if (buzzing && (long)(now - buzzUntil) >= 0) buzzerWrite(false);
}

// =============================================================
void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(HELP_PIN, INPUT_PULLUP);
  for (int i = 0; i < 3; i++) pinMode(LED_PINS[i], OUTPUT);
  pinMode(BUZZ_PIN, OUTPUT);
  buzzerWrite(false);

  sendReady();
  lastHeartbeat = millis();
}

void loop() {
  unsigned long now = millis();

  readSerial();
  updatePir(now);
  updateButton(now);
  updateHand(now);
  updateLeds(now);
  updateBuzzer(now);

  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    Serial.print("HB:");
    Serial.println(now);
  }
}
