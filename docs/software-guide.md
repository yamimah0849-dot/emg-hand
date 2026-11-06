# EMG Hand: software guide

How to install, run, tune and troubleshoot the browser app. For the project overview, see the [main README](../README.md).

The app shows a realistic 3D hand that follows your EMG muscle sensors: relax and the hand opens; flex and it closes, smoothly and in proportion to how hard you squeeze. It supports two sensor setups, chosen under **Sensor setup**:

- **Mark I** (1 sensor on A0): one grip level closes the whole hand.
- **Mark II** (3 sensors on A0, A1, A2): sensor 1 moves the thumb, sensor 2 the index + middle fingers, sensor 3 the ring + pinky fingers. The [README's Mark II section](../README.md#mark-ii-demons-dark-hand) has the wiring and a beginner's step-by-step guide.

## What to install

Nothing extra on Windows 10/11. You need:

- **Microsoft Edge** (already on Windows) or **Google Chrome**. These browsers can read serial ports. Firefox and Safari can't.
- One of the Arduino sketches uploaded to the Uno:
  - Mark I: `arduino/emg_sender/`, one number per line at **9600** baud.
  - Mark II: `arduino/emg_sender_v2/`, three comma-separated numbers per line (`A0,A1,A2`, e.g. `38,612,188`) at **115200** baud, 200 lines per second.
- An internet connection the first time you run it, or see *Offline use* below.

## How to run

1. Plug in the Arduino. **Close the Arduino IDE Serial Monitor/Plotter**, because only one program can use the port at a time.
2. Double-click **`Start EMG Hand.bat`**. A small console window starts a local server, and EMG Hand opens in its own window. Keep the console open while you use the app; close it to quit.
3. Choose your **Sensor setup** (Mark I or Mark II). The baud rate switches to match that sketch.
4. Click **Connect**, pick your Arduino in the list (usually "USB-SERIAL CH340" or "Arduino Uno (COMx)"), and click *Connect* in that dialog.
5. **Mark I: calibration starts automatically** once data arrives:
   - *Step 1:* keep your arm relaxed for 3 seconds. This records your resting level.
   - *Step 2:* clench your fist firmly and hold for 3 seconds. This records your maximum.

   **Mark II:** check each sensor in the **Signals** view first (press **V**), then press **Calibrate all sensors** (**C**): relax for 3 seconds, then flex the thumb, the index + middle, and the ring + pinky for 3 seconds each. Once you have a saved calibration it's used automatically; **Redo** next to a sensor recalibrates just that one.
6. Now open and close your hand.

After the first time, the port appears in the drop-down, so you just click **Connect**. Calibrations are saved in the browser (Mark I and Mark II separately). In Mark I you can press **Use last calibration** at startup to skip it, or press **C** at any time to recalibrate.

**No hardware with you?** Tick **Demo mode**. In Mark I, hold **Space** to simulate a clench. In Mark II, hold **1**, **2** or **3** to flex each finger group (or use the on-screen buttons), and **Space** for a fist. The simulated Mark II signals include crosstalk on purpose, so you can try the threshold sliders. Demo mode keeps its own calibration, so it never overwrites your real one.

## Controls

| Setting | What it does |
|---|---|
| **Sensor setup** | Mark I (1 sensor) or Mark II (3 sensors). Switching while connected reopens the port at the right baud rate. |
| **Smoothing** | Time constant of the signal filter (EMA). Higher means steadier but slower. Try 80–200 ms. |
| **Responsiveness** | How quickly the fingers follow the signal. A critically damped spring, so there is no overshoot. |
| **Dead-zone** (Mark I) | Ignores the bottom part of the range so resting noise doesn't twitch the fingers. Raise it if the hand flickers while relaxed. |
| **Crosstalk filter** (Mark II) | One threshold per sensor, as a share of its rest-to-max range. Its fingers only move once the sensor rises above it, and then still move in proportion. It hides the signal a sensor picks up from neighbouring muscles (and resting noise). Calibration measures the crosstalk and **Use suggested thresholds** sets each one just above it. |
| **Gain** | Above 1 reaches a full fist with less effort. |
| **Signal type** | *Envelope* if the value **rises** when you clench (MyoWare "SIG"/envelope output, most muscle-sensor modules). *Raw EMG* if the value **oscillates around a midpoint** (e.g. ~512) and only gets wider when you clench. Recalibrate after changing it. |
| **Demon hand** | Charcoal skin, claws, and veins that glow brighter the harder you flex (per finger group in Mark II). Turn it off, or pick a skin colour, for the normal hand. |
| Hand / skin | Left or right hand, and several skin tones (plus a "robot" metal finish). |

Mouse: drag to orbit, scroll to zoom, double-click to reset the view.

**Signals view** (tab at the top, or **V**): one lane per sensor with the smoothed value (thick line), the raw reading (thin line), dashed rest / max / threshold lines, and an activity bar on the right that turns bright once the sensor is above its threshold. A lane lights up while it's moving the hand. **0–1023** puts every sensor on the same scale; **Auto zoom** fits each lane to its own signal. **Pause** freezes the graphs, and hovering shows the values at that moment in every lane.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Arduino not in the port list | Use a USB cable that carries data (some only charge). Clone boards need the **CH340 driver**. Check Device Manager → *Ports (COM & LPT)*. |
| "Port is probably in use" | Close the Arduino IDE Serial Monitor/Plotter, Cura, other serial programs, or a second EMG Hand window. |
| "Connected, but no numbers are arriving" | The baud rate in the app must match `Serial.begin(...)` in your sketch: 9600 for Mark I, 115200 for Mark II. The sketch must end each line with `Serial.println`. |
| "Sending one value per line" / "three values per line" | The sketch on the Arduino doesn't match the **Sensor setup**. Upload the other sketch, or click the button in the message to switch. |
| Mark II: a finger group twitches when you move other fingers | Crosstalk. Recalibrate, press **Use suggested thresholds**, or raise that sensor's threshold. If all three lanes always move together, spread the electrode pads further apart. |
| Hand twitches while relaxed | Increase *Dead-zone* or *Smoothing*, or recalibrate while staying fully relaxed. |
| Hand never fully closes | Recalibrate with a firm clench, or raise *Gain*. |
| "Could not start server on port 8765" | It's already running in another console window. Close that one first. |
| Hand model doesn't load | No internet connection. See *Offline use*. |

## Offline use (recommended before a presentation)

Run this once while online, from the project's main folder:

```
powershell -ExecutionPolicy Bypass -File download-assets.ps1
```

It saves three.js and the hand models into `vendor/` and `assets/`. The app uses those copies automatically after that. (While they don't exist, the browser console shows a few harmless 404s from the app checking for them.)

## How it works

```
Arduino (Mark I: A0 → Serial 9600, one number per line;
         Mark II: A0,A1,A2 → Serial 115200, three comma-separated numbers per line)
   │
   ▼
Web Serial API ── js/serial.js      line parsing (one or more numbers per line), port picking, error messages, no-data watchdog
   ▼
Signal pipeline ── js/signal.js
   1. Raw-EMG mode only: remove the DC baseline (slow 2 s average), take |deviation|
   2. Exponential moving average, time constant = Smoothing
   3. Normalise:  (x − rest) / (max − rest), then apply the dead-zone and gain, clamp to 0…1
   ▼
Animation ── js/hand.js
   4. Critically damped spring toward the target, for smooth, proportional motion
   5. Forward kinematics on the rigged hand: each finger joint rotates around its own axis.
      Fingers close pinky-first, and the thumb wraps across last, like a real grip.
```

**Mark II** runs steps 1–3 once per sensor (three independent filters), uses each sensor's own threshold as its dead-zone in step 3, and gives each finger its own spring in step 4. Sensor 1 sets the thumb's target, sensor 2 the index and middle, sensor 3 the ring and pinky. There's no pinky-first stagger, so each finger group's joint angles are directly proportional to its sensor.

**Calibration** uses the median of the relaxed recording as *rest* and the 85th percentile of the clench recording as *max*. Brief spikes don't inflate the range. It refuses a calibration where the clench isn't clearly above the rest noise. In Mark II this is done per sensor: one relaxed recording for all three, then a flex per finger group. While each group flexes, the other two sensors are recorded too. How far they rise, as a share of their own range, is the crosstalk, and the suggested threshold is the largest crosstalk a sensor showed plus 5 percentage points (at least 10%).

**Demon look** (`js/demon.js`): the veins are drawn by a shader from 3D noise evaluated on each point's rest-pose position, so they stay put on the skin as the fingers bend. Each bone gets a glow level from its finger's curl, blended across the skin with the mesh's own skinning weights. The claws are small curved meshes attached to the fingertip bones.

**Model:** the WebXR "generic hand" from the open-source `@webxr-input-profiles/assets` package. It is a skinned mesh with 25 joints, rendered with a physically based skin material, image-based lighting, a warm key light with soft shadows, and a cool rim light.

## Files

```
Start EMG Hand.bat     double-click to run
serve.ps1              tiny local web server (built into Windows PowerShell, no install)
index.html, style.css  UI
js/app.js              wiring: UI, Mark I / Mark II, demo mode, calibration flows, thresholds, live chart
js/serial.js           serial connection, line parsing
js/signal.js           filtering, normalisation, calibration (Mark I and Mark II), crosstalk suggestions
js/signalview.js       live signal view (one lane per sensor)
js/hand.js             3D scene, rigged hand, finger kinematics, per-finger springs
js/demon.js            demon look: vein shader and claws
download-assets.ps1    optional offline copy of libraries/models
arduino/emg_sender/    Mark I sketch: reads A0 and sends the values over USB (9600 baud)
arduino/emg_sender_v2/ Mark II sketch: reads A0, A1, A2 and sends "a,b,c" lines (115200 baud)
```
