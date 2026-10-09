# EMG Hand: software guide

How to install, run, tune and troubleshoot the browser app. For the project overview, see the [main README](../README.md).

The app shows a realistic 3D hand that follows your EMG muscle sensor: relax and the hand opens; clench and it closes into a fist, smoothly and in proportion to how hard you squeeze.

## What to install

Nothing extra on Windows 10/11. You need:

- **Microsoft Edge** (already on Windows) or **Google Chrome**. These browsers can read serial ports. Firefox and Safari can't.
- The Arduino sketch in `arduino/emg_sender/` uploaded to the Uno. It prints one number per line at 9600 baud.
- An internet connection the first time you run it, or see *Offline use* below.

## How to run

1. Plug in the Arduino. **Close the Arduino IDE Serial Monitor/Plotter**, because only one program can use the port at a time.
2. Double-click **`Start EMG Hand.bat`**. A small console window starts a local server, and EMG Hand opens in its own window. Keep the console open while you use the app; close it to quit.
3. Click **Connect**, pick your Arduino in the list (usually "USB-SERIAL CH340" or "Arduino Uno (COMx)"), and click *Connect* in that dialog.
4. **Calibration starts automatically** once data arrives:
   - *Step 1:* keep your arm relaxed for 3 seconds. This records your resting level.
   - *Step 2:* clench your fist firmly and hold for 3 seconds. This records your maximum.
5. Now open and close your hand.

After the first time, the port appears in the drop-down, so you just click **Connect**. The calibration is saved. At startup you can press **Use last calibration** to skip it, or press **C** at any time to recalibrate.

**No hardware with you?** Tick **Demo mode** and hold **Space** to simulate a clench.

## Controls

| Setting | What it does |
|---|---|
| **Smoothing** | Time constant of the signal filter (EMA). Higher means steadier but slower. Try 80–200 ms. |
| **Responsiveness** | How quickly the fingers follow the signal. A critically damped spring, so there is no overshoot. |
| **Dead-zone** | Ignores the bottom part of the range so resting noise doesn't twitch the fingers. Raise it if the hand flickers while relaxed. |
| **Gain** | Above 1 reaches a full fist with less effort. |
| **Signal type** | *Envelope* if the value **rises** when you clench (MyoWare "SIG"/envelope output, most muscle-sensor modules). *Raw EMG* if the value **oscillates around a midpoint** (e.g. ~512) and only gets wider when you clench. Recalibrate after changing it. |
| Hand / skin | Left or right hand, and several skin tones (plus a "robot" metal finish). |

Mouse: drag to orbit, scroll to zoom, double-click to reset the view.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Arduino not in the port list | Use a USB cable that carries data (some only charge). Clone boards need the **CH340 driver**. Check Device Manager → *Ports (COM & LPT)*. |
| "Port is probably in use" | Close the Arduino IDE Serial Monitor/Plotter, Cura, other serial programs, or a second EMG Hand window. |
| "Connected, but no numbers are arriving" | The baud rate in the app must match `Serial.begin(...)` in your sketch. The sketch must print with `Serial.println`. |
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
Arduino (A0 → Serial 9600)
   │  one number per line
   ▼
Web Serial API ── js/serial.js      line parsing, port picking, error messages, no-data watchdog
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

**Calibration** uses the median of the relaxed recording as *rest* and the 85th percentile of the clench recording as *max*. Brief spikes don't inflate the range. It refuses a calibration where the clench isn't clearly above the rest noise.

**Model:** the WebXR "generic hand" from the open-source `@webxr-input-profiles/assets` package. It is a skinned mesh with 25 joints, rendered with a physically based skin material, image-based lighting, a warm key light with soft shadows, and a cool rim light.

## Files

```
Start EMG Hand.bat     double-click to run
serve.ps1              tiny local web server (built into Windows PowerShell, no install)
index.html, style.css  UI
js/app.js              wiring: UI, demo mode, calibration flow, live chart
js/serial.js           serial connection
js/signal.js           filtering, normalisation, calibration
js/hand.js             3D scene, rigged hand, finger kinematics
download-assets.ps1    optional offline copy of libraries/models
arduino/emg_sender/    Arduino sketch: reads A0 and sends the values over USB
```
