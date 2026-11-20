// =============================================================
// Smart Mirror - Full demo (Arduino Mega 2560 / Uno)
// Tests: PIR, HC-SR04 hand sensor, HELP button, 3 LEDs, buzzer
// Serial Monitor: 115200 baud
// =============================================================
//
// What each part does in the demo:
//   GREEN  = someone is in the room (PIR)
//   AMBER  = hand in front of the mirror (< 20 cm), blinks faster when closer
//   RED    = HELP pressed (blinks 3 s) + buzzer alarm
//   Hold a hand under 8 cm for 1 s  -> "SELECT" gesture + short beep
//   Startup: each LED + buzzer tested once
// -------------------------------------------------------------

// ---------- Pins ----------
const int PIR_PIN   = 2;
const int TRIG_PIN  = 3;
const int ECHO_PIN  = 4;
const int HELP_PIN  = 5;
const int GREEN_LED = 8;
const int AMBER_LED = 9;
const int RED_LED   = 10;
const int BUZZ_PIN  = 11;

// ---------- Settings ----------
const bool BUZZER_ACTIVE_LOW = false;  // set true if the buzzer beeps nonstop
const int  HAND_CM           = 20;     // hand detected below this
const int  SELECT_CM         = 8;      // "select" gesture below this
const unsigned long SELECT_HOLD_MS = 1000;
const unsigned long HELP_BLINK_MS  = 3000;
const unsigned long STATUS_MS      = 1000;

// ---------- State ----------
bool presence = false;
bool handNear = false;
bool selectFired = false;
unsigned long handCloseSince = 0;
float distanceCm = -1;

int lastBtn = HIGH;
unsigned long helpUntil = 0;
unsigned long buzzUntil = 0;

unsigned long lastPing = 0;
unsigned long lastStatus = 0;
unsigned long lastAmberToggle = 0;
bool amberState = false;

// ---------- Helpers ----------
void buzzer(bool on) {
  digitalWrite(BUZZ_PIN, (on != BUZZER_ACTIVE_LOW) ? HIGH : LOW);
}

void beep(unsigned long ms) {
  buzzer(true);
  buzzUntil = millis() + ms;
}

void logEvent(const char *msg) {
  Serial.print("[");
  Serial.print(millis() / 1000.0, 1);
  Serial.print("s] ");
  Serial.println(msg);
}

float readDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 25000);  // ~4 m max
  if (us == 0) return -1;                    // no echo
  return us / 58.0;
}

// ---------- Startup self-test ----------
void selfTest() {
  logEvent("SELF-TEST start");
  int leds[3] = { GREEN_LED, AMBER_LED, RED_LED };
  const char *names[3] = { "GREEN", "AMBER", "RED" };
  for (int i = 0; i < 3; i++) {
    Serial.print("  LED ");
    Serial.println(names[i]);
    digitalWrite(leds[i], HIGH);
    delay(500);
    digitalWrite(leds[i], LOW);
  }
  Serial.println("  BUZZER");
  buzzer(true); delay(200); buzzer(false);

  float d = readDistance();
  Serial.print("  HC-SR04: ");
  if (d < 0) Serial.println("NO ECHO - check wiring");
  else { Serial.print(d); Serial.println(" cm"); }

  Serial.println("  PIR: warming up, give it ~60 s for stable readings");
  logEvent("SELF-TEST done - demo running");
}

// =============================================================
void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(HELP_PIN, INPUT_PULLUP);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(AMBER_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZ_PIN, OUTPUT);
  buzzer(false);

  selfTest();
}

void loop() {
  unsigned long now = millis();

  // ----- 1. PIR -> green LED -----
  bool pir = digitalRead(PIR_PIN) == HIGH;
  if (pir != presence) {
    presence = pir;
    logEvent(presence ? "PIR: person detected" : "PIR: no one");
  }
  digitalWrite(GREEN_LED, presence);

  // ----- 2. HC-SR04 every 100 ms -> amber LED + gesture -----
  if (now - lastPing >= 100) {
    lastPing = now;
    distanceCm = readDistance();

    bool near = (distanceCm > 0 && distanceCm < HAND_CM);
    if (near != handNear) {
      handNear = near;
      logEvent(handNear ? "HAND: in front of mirror" : "HAND: gone");
    }

    if (distanceCm > 0 && distanceCm < SELECT_CM) {
      if (handCloseSince == 0) handCloseSince = now;
      if (!selectFired && now - handCloseSince >= SELECT_HOLD_MS) {
        selectFired = true;
        logEvent("GESTURE: SELECT");
        beep(80);
      }
    } else {
      handCloseSince = 0;
      selectFired = false;
    }
  }

  // Amber blinks faster as the hand gets closer
  if (handNear) {
    unsigned long period = map(constrain((int)distanceCm, 2, HAND_CM), 2, HAND_CM, 60, 400);
    if (now - lastAmberToggle >= period) {
      lastAmberToggle = now;
      amberState = !amberState;
    }
  } else {
    amberState = false;
  }
  digitalWrite(AMBER_LED, amberState);

  // ----- 3. HELP button -> red blink + alarm -----
  int btn = digitalRead(HELP_PIN);
  if (btn != lastBtn) {
    delay(20);  // debounce
    btn = digitalRead(HELP_PIN);
    if (btn != lastBtn) {
      lastBtn = btn;
      if (btn == LOW) {
        logEvent("HELP: button pressed!");
        helpUntil = now + HELP_BLINK_MS;
        beep(600);
      }
    }
  }
  bool helpActive = now < helpUntil;
  digitalWrite(RED_LED, helpActive && ((now / 200) % 2 == 0));

  // ----- 4. Buzzer off when time is up -----
  if (buzzUntil != 0 && now >= buzzUntil) {
    buzzer(false);
    buzzUntil = 0;
  }

  // ----- 5. Status line every second -----
  if (now - lastStatus >= STATUS_MS) {
    lastStatus = now;
    Serial.print("STATUS | PIR=");
    Serial.print(presence ? "YES" : "no ");
    Serial.print(" | Distance=");
    if (distanceCm < 0) Serial.print("---");
    else Serial.print(distanceCm, 1);
    Serial.print(" cm | HELP=");
    Serial.println(helpActive ? "ACTIVE" : "off");
  }
}
