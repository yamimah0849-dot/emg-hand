// Demon's Dark Hand Mark II: three-sensor EMG sender for the Arduino Uno.
//
// Reads three EMG sensor boards and sends all three readings to the computer
// on one line, separated by commas, 200 times a second:
//
//     38,41,35        <- relaxed: all three low
//     40,612,188      <- sensor 2 flexing hard (and a little crosstalk on sensor 3)
//
//   Sensor 1 (thumb)              -> A0
//   Sensor 2 (index + middle)     -> A1
//   Sensor 3 (ring + pinky)       -> A2
//   All three sensor GND pins     -> Arduino GND
//
// Each reading is a number from 0 (0 V) to 1023 (5 V).
// Open the EMG Hand app, set "Sensor setup" to Mark II, and click Connect.
// The app's baud rate must be 115200 to match Serial.begin() below.

const uint8_t SENSOR_PINS[] = {A0, A1, A2};
const uint8_t SENSOR_COUNT = sizeof(SENSOR_PINS) / sizeof(SENSOR_PINS[0]);

// 5000 microseconds between readings = 200 readings per second.
// One line is at most 16 characters ("1023,1023,1023" plus the line ending),
// so 200 lines a second uses about a quarter of what 115200 baud can carry.
const unsigned long SAMPLE_INTERVAL_US = 5000;

unsigned long nextSampleAt;

void setup() {
  Serial.begin(115200);
  nextSampleAt = micros();
}

void loop() {
  // Wait until it's time for the next reading. Using micros() instead of delay()
  // keeps the timing steady even though printing takes a little time.
  if ((long)(micros() - nextSampleAt) < 0) return;
  nextSampleAt += SAMPLE_INTERVAL_US;

  for (uint8_t i = 0; i < SENSOR_COUNT; i++) {
    // The Uno has only one analog-to-digital converter, shared by all its analog pins.
    // Right after it switches to a new pin, the first reading can still carry a bit of
    // the previous pin's voltage, which would look like crosstalk between sensors.
    // Reading twice and keeping the second reading avoids that.
    analogRead(SENSOR_PINS[i]);
    int value = analogRead(SENSOR_PINS[i]);

    if (i > 0) Serial.print(',');
    Serial.print(value);
  }
  Serial.println();
}
