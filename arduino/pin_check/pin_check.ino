// Smart Mirror - Step 1 wiring check (Tinkercad / real Uno)
// Pins follow the bench guide: PIR D2, HELP D5, LEDs D8/D9/D10, buzzer NPN D11

const int PIR_PIN   = 2;
const int HELP_PIN  = 5;
const int GREEN_LED = 8;
const int AMBER_LED = 9;
const int RED_LED   = 10;
const int BUZZ_PIN  = 11;

int lastPir = -1;
int lastBtn = -1;

void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(HELP_PIN, INPUT_PULLUP);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(AMBER_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZ_PIN, OUTPUT);

  // Test 1: each LED lights alone for 1 s, in order green, amber, red
  Serial.println("TEST: GREEN");  digitalWrite(GREEN_LED, HIGH); delay(1000); digitalWrite(GREEN_LED, LOW);
  Serial.println("TEST: AMBER");  digitalWrite(AMBER_LED, HIGH); delay(1000); digitalWrite(AMBER_LED, LOW);
  Serial.println("TEST: RED");    digitalWrite(RED_LED, HIGH);   delay(1000); digitalWrite(RED_LED, LOW);

  // Test 2: buzzer beeps for 0.5 s
  Serial.println("TEST: BUZZER");
  digitalWrite(BUZZ_PIN, HIGH); delay(500); digitalWrite(BUZZ_PIN, LOW);

  Serial.println("READY: press button / trigger PIR");
  digitalWrite(GREEN_LED, HIGH);
}

void loop() {
  // Test 3: button (pressed = LOW because of INPUT_PULLUP)
  int btn = digitalRead(HELP_PIN);
  if (btn != lastBtn) {
    Serial.println(btn == LOW ? "BUTTON: PRESSED" : "BUTTON: released");
    digitalWrite(RED_LED, btn == LOW ? HIGH : LOW);
    lastBtn = btn;
    delay(30); // simple debounce
  }

  // Test 4: PIR
  int pir = digitalRead(PIR_PIN);
  if (pir != lastPir) {
    Serial.println(pir == HIGH ? "PIR: MOTION" : "PIR: no motion");
    digitalWrite(AMBER_LED, pir);
    lastPir = pir;
  }
}
