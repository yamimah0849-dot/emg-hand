import { HandScene, SKIN_TONES } from './hand.js';
import { SignalProcessor, Calibrator, MultiCalibrator, suggestThresholds } from './signal.js';
import { SerialLink, serialSupported, portLabel } from './serial.js';
import { SignalView, SignalHistory, SENSORS, MK1_SENSOR, activity } from './signalview.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'emghand.settings.v1';
const prefs = loadPrefs();

// Two sensor setups: Mark I (one sensor on A0, the original project) and Mark II (three sensors).
const RIG_BAUD = { mk1: 9600, mk2: 115200 };
let rig = prefs.rig === 'mk1' ? 'mk1' : 'mk2';
const rigBaud = r => (r === 'mk1' ? prefs.baud : prefs.baudMk2) ?? RIG_BAUD[r];

// ---------------------------------------------------------------- core objects
// Mark I: one signal processor for the whole hand (unchanged from version one).
const proc = new SignalProcessor();
Object.assign(proc.settings, pick(prefs, ['smoothingMs', 'deadzone', 'gain', 'mode']));
const calibrator = new Calibrator(proc);

// Mark II: one processor per sensor, each with its own saved calibration. Demo mode keeps separate
// calibrations so trying the demo never overwrites the real one.
const mk2Key = (i, demoProfile) => `emghand.mk2.calibration.s${i + 1}${demoProfile ? '.demo' : ''}`;
const sensors = SENSORS.map((_, i) => new SignalProcessor({ storageKey: mk2Key(i, false) }));
const multiCal = new MultiCalibrator(sensors);
const DEFAULT_THRESHOLD = 0.1;
let thresholds = loadThresholds(false);
let crosstalk = loadCrosstalk(false);
syncSensorSettings();

const scene = new HandScene($('viewport'));
scene.responsiveness = prefs.responsiveness ?? 9;
scene.stagger = rig === 'mk1';

const link = new SerialLink({
  onValues: vals => { if (!demo.on) feed(vals); },
  onStatus: ({ state, message }) => {
    setStatus(state, { idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', nodata: 'No data', error: 'Error' }[state]);
    showMessage(message, state === 'error' ? 'error' : state === 'nodata' ? 'warn' : '');
    $('connect').disabled = state === 'connecting';
    $('disconnect').disabled = !link.connected;
    if (state === 'connected' && message === 'Receiving data.' && !startupCalibrated) {
      startupCalibrated = true;
      setTimeout(() => onFirstData(), 600);
    }
    if (state === 'idle' || state === 'error') startupCalibrated = false;
  },
});
let startupCalibrated = false;

window.app = { scene, proc, sensors, link, calibrator, multiCal };  // handy from DevTools

// Route each line from the Arduino to the right processor(s).
const format = { otherCount: 0, warned: false };
function feed(vals) {
  if (rig === 'mk1') {
    proc.push(vals[0]);
    checkFormat(vals.length >= 3 ? 'mk2' : null);
  } else {
    if (vals.length < 3) { checkFormat('mk1'); return; }
    checkFormat(null);
    for (let i = 0; i < sensors.length; i++) sensors[i].push(vals[i]);
  }
}
// If the lines look like the other sketch, say so (once) and offer to switch.
function checkFormat(looksLike) {
  if (!looksLike) { format.otherCount = 0; return; }
  if (format.warned || ++format.otherCount < 20) return;
  format.warned = true;
  if (looksLike === 'mk2') {
    showMessage('The Arduino is sending three values per line (the Mark II sketch). Mark I mode only uses the first one (A0).', 'warn',
      { label: 'Switch to Mark II', onClick: () => setRig('mk2') });
  } else {
    showMessage('The Arduino is sending one value per line: that is the Mark I sketch. Upload arduino/emg_sender_v2 for three sensors, or switch to Mark I.', 'warn',
      { label: 'Switch to Mark I', onClick: () => setRig('mk1') });
  }
}

function onFirstData() {
  if (rig === 'mk1') { startCalibration({ startup: true }); return; }
  if (format.warned) return;   // keep the "wrong sketch" message on screen
  if (sensors.every(s => s.calibration)) {
    showMessage(`Receiving data. Using your saved calibration from ${formatDate(sensors[0].calibration.date)}. Press C to recalibrate.`, '');
  } else {
    showMessage('Receiving data. Not calibrated yet: open the Signals view (V) to check that each sensor reacts to its own fingers, then press Calibrate all sensors (C).', 'warn');
    $('calibrate').classList.add('nudge');
  }
}

// ---------------------------------------------------------------- hand model
scene.setDemon(prefs.demon !== false);
scene.loadHand(prefs.side ?? 'right', prefs.skin ?? 'medium')
  .then(() => $('loading').remove())
  .catch(err => {
    console.error(err);
    const el = $('loading');
    el.classList.add('error');
    el.textContent = 'Could not load the 3D hand model. Check your internet connection, or run download-assets.ps1 once to keep an offline copy.';
  });

// ---------------------------------------------------------------- serial port picking
async function refreshPorts(selectPort) {
  const sel = $('port-select');
  const ports = await link.knownPorts();
  sel.innerHTML = '';
  ports.forEach((p, i) => sel.add(new Option(portLabel(p, i), String(i))));
  sel.add(new Option(ports.length ? 'Choose another port…' : 'Choose a port… (opens a list)', 'new'));
  const idx = selectPort ? ports.indexOf(selectPort) : 0;
  sel.value = idx >= 0 && ports.length ? String(idx) : 'new';
  sel._ports = ports;
}

$('connect').onclick = async () => {
  if (demo.on) setDemo(false);
  const sel = $('port-select');
  let port = sel.value === 'new' ? null : sel._ports?.[+sel.value];
  if (!port) {
    port = await link.requestPort();
    if (!port) return;
  }
  format.otherCount = 0; format.warned = false;
  const ok = await link.connect(port, +$('baud').value);
  await refreshPorts(port);
  if (ok) savePrefs(rig === 'mk1' ? { baud: +$('baud').value } : { baudMk2: +$('baud').value });
};
$('disconnect').onclick = async () => {
  calibrator.cancel(); multiCal.cancel();
  await link.disconnect(); $('disconnect').disabled = true;
};

if (serialSupported()) {
  refreshPorts();
  navigator.serial.addEventListener('connect', () => refreshPorts());
  navigator.serial.addEventListener('disconnect', () => refreshPorts());
} else {
  $('connect').disabled = true;
  $('port-select').add(new Option('Serial not available', ''));
  showMessage('This browser cannot access serial ports. Open the app in Microsoft Edge or Google Chrome (use “Start EMG Hand.bat”). Demo mode still works.', 'error');
}

// ---------------------------------------------------------------- sensor setup (Mark I / Mark II)
async function setRig(r) {
  calibrator.cancel(); multiCal.cancel();
  rig = r;
  savePrefs({ rig: r });
  document.body.dataset.rig = r;
  $('rig').value = r;
  scene.stagger = r === 'mk1';
  const baud = rigBaud(r);
  $('baud').value = String(baud);
  format.otherCount = 0; format.warned = false;
  $('calibrate').classList.remove('nudge');
  setupSignalView();
  showCalibration();
  if (demo.on) setDemo(true);                       // restart the simulator for this setup
  else if (link.connected && link.baudRate !== baud) {
    // The two sketches use different baud rates, so reopen the port at the new one.
    const port = link.port;
    await link.connect(port, baud);
  } else if (link.connected) {
    showMessage(`Switched to ${r === 'mk1' ? 'Mark I (one sensor)' : 'Mark II (three sensors)'}.`, '');
  }
}
$('rig').onchange = e => setRig(e.target.value);

// ---------------------------------------------------------------- demo mode (synthetic EMG)
// Mark II demo signals include some crosstalk (each sensor picks up part of its neighbours'
// muscles), so the threshold sliders can be tried without hardware.
const DEMO_LEAK = [[0, 0.28, 0.08], [0.22, 0, 0.26], [0.06, 0.32, 0]];
const demo = {
  on: false, timer: null, effort: 0, held: false, auto: false,
  group: [0, 0, 0], groupHeld: [false, false, false], groupAuto: [false, false, false],
};
function setDemo(on) {
  const wasOn = demo.on;
  demo.on = on;
  $('demo').checked = on;
  $('demo-pads').hidden = !on;
  clearInterval(demo.timer);
  if (on !== wasOn) useMk2Profile(on);
  if (on) {
    if (link.connected) link.disconnect();
    setStatus('demo', 'Demo mode');
    if (rig === 'mk1') {
      showMessage('Simulated sensor. Hold Space to clench — tap it lightly for a partial grip.', '');
      demo.timer = setInterval(demoTickMk1, 10);
      if (!proc.calibration) setTimeout(() => startCalibration({ startup: true }), 300);
    } else {
      showMessage('Simulated sensors. Hold 1 (thumb), 2 (index + middle) or 3 (ring + pinky), or Space for a fist. The fake signals include crosstalk, so try the threshold sliders.', '');
      demo.timer = setInterval(demoTickMk2, 5);
      if (!sensors.every(s => s.calibration)) setTimeout(() => startCalibration({ startup: true }), 300);
    }
  } else {
    demo.held = demo.auto = false;
    demo.groupHeld.fill(false); demo.groupAuto.fill(false);
    setStatus('idle', 'Not connected');
    showMessage('', '');
  }
}
const noise = () => (Math.random() - 0.5) * 2;
function demoTickMk1() {
  const want = demo.held || demo.auto ? 1 : 0;
  demo.effort += (want - demo.effort) * (want > demo.effort ? 0.035 : 0.05);
  let v;
  if (proc.settings.mode === 'raw') {
    const amp = 18 + demo.effort * 260;
    v = 512 + noise() * amp;
  } else {
    v = 70 + Math.abs(noise()) * 22 + demo.effort * (430 + noise() * 70);
  }
  proc.push(Math.round(v));
}
function demoTickMk2() {
  // Time-based, so the simulated muscles respond at the same speed even if the timer runs late.
  const now = performance.now();
  const dt = Math.min(0.1, (now - (demo.lastTick ?? now)) / 1000);
  demo.lastTick = now;
  for (let g = 0; g < 3; g++) {
    const want = demo.held || demo.groupHeld[g] || demo.groupAuto[g] ? 1 : 0;
    const tau = want > demo.group[g] ? 0.28 : 0.2;    // seconds to get most of the way there
    demo.group[g] += (want - demo.group[g]) * (1 - Math.exp(-dt / tau));
  }
  for (let j = 0; j < 3; j++) {
    let a = demo.group[j];
    for (let k = 0; k < 3; k++) if (k !== j) a += DEMO_LEAK[j][k] * demo.group[k];
    a = Math.min(1, a);
    const v = proc.settings.mode === 'raw'
      ? 512 + noise() * (18 + a * 260)
      : 55 + j * 8 + Math.abs(noise()) * 20 + a * (440 + noise() * 60);
    sensors[j].push(Math.round(Math.min(1023, Math.max(0, v))));
  }
}
$('demo').onchange = e => setDemo(e.target.checked);

// On-screen hold buttons for the demo (for touchscreens, or if you'd rather click).
SENSORS.forEach((s, g) => {
  const b = document.createElement('button');
  b.style.setProperty('--c', s.color);
  b.innerHTML = `<b>${g + 1}</b> ${s.group}`;
  b.title = `Hold to flex the ${s.group.toLowerCase()} (key ${g + 1})`;
  const set = held => { demo.groupHeld[g] = held; b.classList.toggle('held', held); };
  b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); set(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => set(false));
  $('demo-pads').append(b);
});

addEventListener('keydown', e => {
  if ((e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space' && demo.on) { demo.held = true; e.preventDefault(); }
  const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (digit >= 0 && demo.on && rig === 'mk2') { demo.groupHeld[digit] = true; e.preventDefault(); }
  if (e.code === 'KeyC' && !e.repeat) startCalibration();
  if (e.code === 'KeyV' && !e.repeat) setView(view === 'signals' ? 'hand' : 'signals');
  if (e.code === 'Escape') { calibrator.cancel(); multiCal.cancel(); }
});
addEventListener('keyup', e => {
  if (e.code === 'Space') demo.held = false;
  const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (digit >= 0) demo.groupHeld[digit] = false;
});
addEventListener('blur', () => { demo.held = false; demo.groupHeld.fill(false); });

// ---------------------------------------------------------------- calibration
const CAL_TEXT = {
  'prep-rest':   ['Step 1 of 2', 'Relax your arm', 'Let your hand rest loosely. Recording starts in a moment…'],
  'rest':        ['Step 1 of 2', 'Stay relaxed', 'Recording your resting level. Keep still.'],
  'prep-clench': ['Step 2 of 2', 'Get ready to clench', 'Make a firm fist when the timer starts…'],
  'clench':      ['Step 2 of 2', 'Clench your fist!', 'Squeeze as hard as is comfortable and hold it.'],
};
const FLEX_TEXT = [
  { ready: 'Get ready: thumb', go: 'Flex your thumb!',
    how: 'Press your thumb firmly across your palm and hold it. Keep the other fingers relaxed.' },
  { ready: 'Get ready: index + middle', go: 'Curl index + middle!',
    how: 'Curl your index and middle fingers firmly and hold. Keep the thumb, ring and pinky relaxed.' },
  { ready: 'Get ready: ring + pinky', go: 'Curl ring + pinky!',
    how: 'Curl your ring and pinky fingers firmly and hold. Keep the thumb, index and middle relaxed.' },
];

function startCalibration(opts = {}) {
  return rig === 'mk1' ? startCalibrationMk1(opts) : startCalibrationMk2(opts);
}

async function startCalibrationMk1({ startup = false } = {}) {
  if (calibrator.active) return;
  if (!link.connected && !demo.on) {
    showMessage('Connect to the sensor (or enable demo mode) before calibrating.', 'warn');
    return;
  }
  $('calib').hidden = false;
  $('calib-skip').hidden = !(startup && proc.calibration);
  const ring = document.querySelector('.calib-ring');
  ring.style.removeProperty('--ring');
  try {
    const cal = await calibrator.run(({ phase, progress, secondsLeft }) => {
      const [step, title, text] = CAL_TEXT[phase];
      $('calib-step').textContent = step; $('calib-title').textContent = title; $('calib-text').textContent = text;
      $('calib-count').textContent = secondsLeft;
      ring.classList.toggle('clench', phase.includes('clench'));
      $('calib-bar').style.strokeDashoffset = String(326.7 * (1 - (phase.startsWith('prep') ? 0 : progress)));
      if (demo.on) demo.auto = phase === 'clench' || (phase === 'prep-clench' && progress > 0.85);
    });
    proc.setCalibration(cal);
    showCalibration();
    showMessage(`Calibrated: rest ≈ ${cal.rest.toFixed(0)}, max ≈ ${cal.max.toFixed(0)}.`, '');
  } catch (e) {
    if (e.message !== 'cancelled') showMessage(e.message, 'error');
  } finally {
    demo.auto = false;
    $('calib').hidden = true;
  }
}

// Mark II: relax all, then flex each finger group in turn. sensors = [k] redoes just sensor k.
async function startCalibrationMk2({ startup = false, only = null } = {}) {
  if (multiCal.active) return;
  if (!link.connected && !demo.on) {
    showMessage('Connect to the sensors (or enable demo mode) before calibrating.', 'warn');
    return;
  }
  const list = only == null ? [0, 1, 2] : [only];
  $('calibrate').classList.remove('nudge');
  $('calib').hidden = false;
  $('calib-skip').hidden = !(startup && sensors.every(s => s.calibration));
  const ring = document.querySelector('.calib-ring');
  ring.classList.remove('clench');
  const liveRows = [...$('calib-live').children];
  try {
    const result = await multiCal.run(({ phase, sensor, step, steps, progress, secondsLeft }) => {
      const prefix = only == null ? '' : `Sensor ${only + 1} · `;
      let title, text;
      if (phase === 'prep-rest') [title, text] = ['Relax your arm', 'Let your hand rest loosely. Recording starts in a moment…'];
      else if (phase === 'rest') [title, text] = ['Stay relaxed', `Recording the resting level of ${only == null ? 'all three sensors' : `sensor ${only + 1}`}. Keep still.`];
      else if (phase === 'prep-flex') [title, text] = [FLEX_TEXT[sensor].ready, `When the timer starts: ${FLEX_TEXT[sensor].how}`];
      else [title, text] = [FLEX_TEXT[sensor].go, FLEX_TEXT[sensor].how];
      $('calib-step').textContent = `${prefix}Step ${step} of ${steps}`;
      $('calib-title').textContent = title; $('calib-text').textContent = text;
      $('calib-count').textContent = secondsLeft;
      const flexing = phase.endsWith('flex');
      if (flexing) ring.style.setProperty('--ring', SENSORS[sensor].color); else ring.style.removeProperty('--ring');
      $('calib-bar').style.strokeDashoffset = String(326.7 * (1 - (phase.startsWith('prep') ? 0 : progress)));
      liveRows.forEach((row, i) => row.classList.toggle('target', flexing ? i === sensor : list.includes(i)));
      if (demo.on) demo.groupAuto = [0, 1, 2].map(i => i === sensor && (phase === 'flex' || (phase === 'prep-flex' && progress > 0.85)));
    }, { sensors: list });

    const ok = [], failed = [];
    result.calibrations.forEach((cal, i) => { if (cal) { sensors[i].setCalibration(cal); ok.push(i + 1); } });
    result.errors.forEach(err => { if (err) failed.push(err); });
    // Merge the newly measured crosstalk into what we already know.
    result.crosstalk.forEach((row, j) => row.forEach((v, k) => { if (Number.isFinite(v)) crosstalk[j][k] = v; }));
    saveCrosstalk();
    showCalibration();
    showThresholds();

    const suggestions = suggestThresholds(crosstalk, { min: DEFAULT_THRESHOLD });
    const better = suggestions.some((s, i) => Number.isFinite(s) && Math.abs(s - thresholds[i]) >= 0.02);
    if (failed.length) {
      showMessage(`${ok.length ? `Calibrated sensor${ok.length > 1 ? 's' : ''} ${ok.join(', ')}. ` : ''}${failed.join(' ')}`, 'error');
    } else {
      showMessage(`Calibrated sensor${ok.length > 1 ? 's' : ''} ${ok.join(', ')}.` +
        (better ? ' Crosstalk was measured: see the suggested thresholds under Crosstalk filter.' : ''), '',
        better ? { label: 'Use suggested thresholds', onClick: applySuggestions } : null);
    }
  } catch (e) {
    if (e.message !== 'cancelled') showMessage(e.message, 'error');
  } finally {
    demo.groupAuto.fill(false);
    ring.style.removeProperty('--ring');
    $('calib').hidden = true;
  }
}
$('calibrate').onclick = () => startCalibration();
$('calib-cancel').onclick = () => { calibrator.cancel(); multiCal.cancel(); };
$('calib-skip').onclick = () => { calibrator.cancel(); multiCal.cancel(); };

// Live bars inside the calibration card (Mark II), so you can see which sensor is reacting.
for (const s of SENSORS) {
  const row = document.createElement('div');
  row.className = 'cl-row';
  row.style.setProperty('--c', s.color);
  row.innerHTML = `<span><i></i>${s.name.replace('Sensor ', '')} · ${s.group}</span><div class="cl-bar"><i></i></div>`;
  $('calib-live').append(row);
}

// Calibration table (Mark II): one row per sensor with a Redo button.
for (const [i, s] of SENSORS.entries()) {
  const tr = document.createElement('tr');
  tr.style.setProperty('--c', s.color);
  tr.innerHTML = `<td><span><i></i>${i + 1} · ${s.group}</span></td><td class="c-rest">–</td><td class="c-max">–</td><td class="c-noise">–</td>
    <td><button class="ghost" title="Recalibrate only sensor ${i + 1}">Redo</button></td>`;
  tr.querySelector('button').onclick = () => startCalibration({ only: i });
  $('cal-rows').append(tr);
}

function showCalibration() {
  const c = proc.calibration;
  $('c-rest').textContent = c ? c.rest.toFixed(0) : '–';
  $('c-max').textContent = c ? c.max.toFixed(0) : '–';
  $('c-noise').textContent = c ? '±' + c.noise.toFixed(1) : '–';

  [...$('cal-rows').children].forEach((tr, i) => {
    const sc = sensors[i].calibration;
    tr.querySelector('.c-rest').textContent = sc ? sc.rest.toFixed(0) : '–';
    tr.querySelector('.c-max').textContent = sc ? sc.max.toFixed(0) : '–';
    tr.querySelector('.c-noise').textContent = sc ? '±' + sc.noise.toFixed(1) : '–';
    tr.querySelector('.c-rest').classList.toggle('bad', !sc);
  });
  const dates = sensors.map(s => s.calibration?.date).filter(Boolean).sort();
  $('cal-saved').textContent = !dates.length
    ? `Not calibrated yet${demo.on ? ' (demo)' : ''}. The hand won't move until it is.`
    : dates.length < sensors.length
      ? `Some sensors aren't calibrated yet: press Redo next to them.`
      : `Saved ${formatDate(dates[dates.length - 1])}${demo.on ? ' (demo calibration, kept separate from your real one)' : ''}. It's remembered next time.`;
}

// ---------------------------------------------------------------- crosstalk thresholds (Mark II)
for (const [i, s] of SENSORS.entries()) {
  const block = document.createElement('div');
  block.className = 'thr-block';
  block.style.setProperty('--c', s.color);
  block.innerHTML = `<label class="slider"><span><i></i>Sensor ${i + 1} · ${s.group.toLowerCase()}</span><output></output>
      <input type="range" min="0" max="0.7" step="0.01" aria-label="Threshold for sensor ${i + 1}"></label>
    <div class="thr-note"></div>`;
  const input = block.querySelector('input');
  input.oninput = () => { thresholds[i] = +input.value; syncSensorSettings(); saveThresholds(); showThresholds(); };
  $('thresholds').append(block);
}

function showThresholds() {
  const suggestions = suggestThresholds(crosstalk, { min: DEFAULT_THRESHOLD });
  let any = false;
  [...$('thresholds').children].forEach((block, i) => {
    block.querySelector('input').value = thresholds[i];
    block.querySelector('output').textContent = `${Math.round(thresholds[i] * 100)}%`;
    const picked = crosstalk[i].filter(Number.isFinite);
    const note = block.querySelector('.thr-note');
    if (picked.length) {
      const s = suggestions[i];
      note.textContent = `Picks up to ${Math.round(Math.max(...picked) * 100)}% from other fingers · suggested ${Math.round(s * 100)}%`;
      if (Math.abs(s - thresholds[i]) >= 0.02) any = true;
    } else {
      note.textContent = 'Calibrate to measure crosstalk and get a suggestion.';
    }
  });
  $('apply-suggest').disabled = !any;
}
function applySuggestions() {
  const s = suggestThresholds(crosstalk, { min: DEFAULT_THRESHOLD });
  thresholds = thresholds.map((t, i) => (Number.isFinite(s[i]) ? Math.round(s[i] * 100) / 100 : t));
  syncSensorSettings(); saveThresholds(); showThresholds();
  showMessage(`Thresholds set to ${thresholds.map(t => Math.round(t * 100) + '%').join(', ')}. Fine-tune them with the sliders if a group still twitches or feels hard to move.`, '');
}
$('apply-suggest').onclick = applySuggestions;

// Mark II sensors share the Smoothing / Gain / Signal type settings; each has its own threshold.
function syncSensorSettings() {
  sensors.forEach((s, i) => {
    s.settings.smoothingMs = proc.settings.smoothingMs;
    s.settings.gain = proc.settings.gain;
    s.settings.deadzone = thresholds[i];
    if (s.settings.mode !== proc.settings.mode) s.setMode(proc.settings.mode);
  });
}
// Real hardware and demo mode each keep their own calibrations, thresholds and crosstalk.
function useMk2Profile(demoProfile) {
  sensors.forEach((s, i) => s.setStorageKey(mk2Key(i, demoProfile)));
  thresholds = loadThresholds(demoProfile);
  crosstalk = loadCrosstalk(demoProfile);
  syncSensorSettings();
  showCalibration();
  showThresholds();
}
function loadThresholds(demoProfile) {
  const t = prefs[demoProfile ? 'thresholdsDemo' : 'thresholds'];
  return SENSORS.map((_, i) => (Number.isFinite(t?.[i]) ? t[i] : DEFAULT_THRESHOLD));
}
function saveThresholds() { savePrefs({ [demo.on ? 'thresholdsDemo' : 'thresholds']: thresholds }); }
function loadCrosstalk(demoProfile) {
  const c = prefs[demoProfile ? 'crosstalkDemo' : 'crosstalk'];
  return SENSORS.map((_, j) => SENSORS.map((_, k) => (Number.isFinite(c?.[j]?.[k]) ? c[j][k] : NaN)));
}
function saveCrosstalk() {
  // JSON can't store NaN, so unmeasured cells are saved as null.
  savePrefs({ [demo.on ? 'crosstalkDemo' : 'crosstalk']: crosstalk.map(r => r.map(v => (Number.isFinite(v) ? v : null))) });
}

// ---------------------------------------------------------------- tuning controls
bindSlider('smooth', 'o-smooth', v => `${v} ms`, v => { proc.settings.smoothingMs = v; syncSensorSettings(); savePrefs({ smoothingMs: v }); }, proc.settings.smoothingMs);
bindSlider('resp', 'o-resp', v => v.toFixed(1), v => { scene.responsiveness = v; savePrefs({ responsiveness: v }); }, scene.responsiveness);
bindSlider('dz', 'o-dz', v => `${Math.round(v * 100)}%`, v => { proc.settings.deadzone = v; savePrefs({ deadzone: v }); }, proc.settings.deadzone);
bindSlider('gain', 'o-gain', v => `×${v.toFixed(2)}`, v => { proc.settings.gain = v; syncSensorSettings(); savePrefs({ gain: v }); }, proc.settings.gain);
$('mode').value = proc.settings.mode;
$('mode').onchange = e => {
  proc.setMode(e.target.value);
  syncSensorSettings();
  savePrefs({ mode: e.target.value });
  showMessage('Signal type changed — recalibrate (press C) so the range matches.', 'warn');
};

function bindSlider(id, outId, fmt, apply, initial) {
  const input = $(id), out = $(outId);
  input.value = initial;
  const update = () => { const v = +input.value; out.textContent = fmt(v); apply(v); };
  input.oninput = update;
  out.textContent = fmt(+input.value);
}

// ---------------------------------------------------------------- appearance
function setDemonLook(on) {
  scene.setDemon(on);
  document.body.dataset.demon = String(on);
  $('demon').checked = on;
  savePrefs({ demon: on });
}
$('demon').onchange = e => setDemonLook(e.target.checked);
$('side').value = prefs.side ?? 'right';
$('side').onchange = e => { savePrefs({ side: e.target.value }); scene.loadHand(e.target.value, prefs.skin ?? 'medium'); };
for (const [name, hex] of Object.entries(SKIN_TONES)) {
  const b = document.createElement('button');
  b.title = name[0].toUpperCase() + name.slice(1);
  b.setAttribute('aria-label', `${b.title} skin`);
  b.style.background = name === 'robot'
    ? 'linear-gradient(135deg,#dfe6ee,#7d8a99)' : '#' + hex.toString(16).padStart(6, '0');
  b.setAttribute('aria-pressed', String((prefs.skin ?? 'medium') === name));
  b.onclick = () => {
    scene.setSkin(name); savePrefs({ skin: name });
    for (const s of $('swatches').children) s.setAttribute('aria-pressed', String(s === b));
    setDemonLook(false);
  };
  $('swatches').append(b);
}

// ---------------------------------------------------------------- views: 3D hand / live signals
let view = 'hand';
function setView(v) {
  view = v;
  const signals = v === 'signals';
  $('signal-view').hidden = !signals;
  document.body.classList.toggle('view-signals', signals);
  $('tab-hand').setAttribute('aria-selected', String(!signals));
  $('tab-signals').setAttribute('aria-selected', String(signals));
  scene.paused = signals;
}
$('tab-hand').onclick = () => setView('hand');
$('tab-signals').onclick = () => setView('signals');
$('open-signals').onclick = () => setView('signals');

const signalView = new SignalView($('signal-view'));
const mk1History = new SignalHistory();
const mk2Histories = sensors.map(() => new SignalHistory());
const displayRaw = p => (p.settings.mode === 'raw' ? p.rectified : p.raw);
proc.onSample(p => mk1History.push(performance.now(), displayRaw(p), p.smoothed));
sensors.forEach((s, i) => s.onSample(p => mk2Histories[i].push(performance.now(), displayRaw(p), p.smoothed)));
function setupSignalView() {
  signalView.setLanes(rig === 'mk1'
    ? [{ sensor: MK1_SENSOR, proc, history: mk1History, thresholdLabel: 'dead-zone' }]
    : sensors.map((p, i) => ({ sensor: SENSORS[i], proc: p, history: mk2Histories[i] })));
}
const setScale = s => {
  signalView.scale = s;
  $('sv-full').setAttribute('aria-pressed', String(s === 'full'));
  $('sv-auto').setAttribute('aria-pressed', String(s === 'auto'));
  savePrefs({ signalScale: s });
};
$('sv-full').onclick = () => setScale('full');
$('sv-auto').onclick = () => setScale('auto');
$('sv-pause').onclick = () => {
  signalView.setPaused(!signalView.paused);
  $('sv-pause').setAttribute('aria-pressed', String(signalView.paused));
  $('sv-pause').textContent = signalView.paused ? 'Resume' : 'Pause';
};

// Finger-group readouts on the 3D view and compact sensor bars in the side panel (Mark II).
const hudRows = SENSORS.map(s => {
  const row = document.createElement('div');
  row.className = 'g-row';
  row.style.setProperty('--c', s.color);
  row.innerHTML = `<span class="g-name"><i></i>${s.group}</span><b>0<small>%</small></b><span class="g-bar"><i></i></span>`;
  $('group-hud').append(row);
  return { pct: row.querySelector('b'), bar: row.querySelector('.g-bar i') };
});
const miniRows = SENSORS.map((s, i) => {
  const row = document.createElement('div');
  row.className = 'ms-row';
  row.style.setProperty('--c', s.color);
  row.innerHTML = `<span><i></i>${s.name} · ${s.pin} · ${s.group.toLowerCase()}</span><b>–</b>
    <div class="ms-bar"><div class="fill"></div><div class="thr"></div></div>`;
  $('mini-sensors').append(row);
  return { val: row.querySelector('b'), fill: row.querySelector('.fill'), thr: row.querySelector('.thr') };
});

// ---------------------------------------------------------------- live readouts + chart (Mark I chart unchanged)
const HISTORY = 600;
const hist = { raw: new Float32Array(HISTORY), smooth: new Float32Array(HISTORY), n: 0, i: 0 };
const chart = $('chart');
const ctx = chart.getContext('2d');
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colors = { raw: css('--raw'), smooth: css('--smooth'), cal: css('--cal'), grid: '#1d252f' };
let lastSampleCount = 0, sampleCount = 0;
proc.onSample(() => sampleCount++);
let mk2Count = 0;
sensors[0].onSample(() => mk2Count++);
let lastText = 0;

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const live = link.connected || demo.on;

  if (rig === 'mk1') {
    const fresh = sampleCount !== lastSampleCount;
    lastSampleCount = sampleCount;

    // Drive the hand only when there is a live signal and a calibration (and not mid-calibration).
    const ok = live && proc.calibration && !calibrator.active;
    scene.setTargets(ok ? proc.level : 0);

    const pct = Math.round(Math.max(0, Math.min(1, scene.curl)) * 100);
    $('hud-pct').textContent = pct;
    $('gripbar-fill').style.width = `${Math.round(proc.level * 100)}%`;

    if (fresh) {
      hist.raw[hist.i] = proc.settings.mode === 'raw' ? proc.rectified : proc.raw;
      hist.smooth[hist.i] = proc.smoothed;
      hist.i = (hist.i + 1) % HISTORY;
      hist.n = Math.min(HISTORY, hist.n + 1);
      $('v-raw').textContent = proc.raw.toFixed(0);
      $('v-smooth').textContent = proc.smoothed.toFixed(0);
      $('v-rate').textContent = `${proc.sampleRate.toFixed(0)} Hz`;
    }
    drawChart();
  } else {
    // Each sensor drives its own finger group, in proportion to how far it is above its threshold.
    const targets = {};
    SENSORS.forEach((s, i) => {
      const ok = live && sensors[i].calibration && !multiCal.active;
      for (const f of s.fingers) targets[f] = ok ? sensors[i].level : 0;
    });
    scene.setTargets(targets);

    const textDue = now - lastText > 80;               // numbers: ~12 updates a second is easier to read
    SENSORS.forEach((s, i) => {
      const curl = Math.max(0, Math.min(1, scene.curlOf(s.fingers[0])));
      hudRows[i].bar.style.width = `${(curl * 100).toFixed(1)}%`;
      const act = activity(sensors[i]);
      const cal = sensors[i].calibration;
      miniRows[i].fill.style.width = `${(act * 100).toFixed(1)}%`;
      miniRows[i].fill.classList.toggle('over', !!cal && act > thresholds[i]);
      miniRows[i].thr.style.left = `${thresholds[i] * 100}%`;
      miniRows[i].thr.hidden = !cal;
      if (textDue) {
        hudRows[i].pct.firstChild.textContent = String(Math.round(curl * 100));
        miniRows[i].val.textContent = mk2Count ? sensors[i].smoothed.toFixed(0) : '–';
      }
    });
    if (!$('calib').hidden) {
      [...$('calib-live').children].forEach((row, i) => {
        row.querySelector('.cl-bar i').style.width = `${Math.min(100, sensors[i].smoothed / 10.23).toFixed(1)}%`;
      });
    }
    if (textDue) lastText = now;
  }

  // Demon glow strength for the aura behind the hand.
  $('viewport').style.setProperty('--glow', scene.glow.toFixed(3));

  if (view === 'signals') {
    signalView.draw();
    const rate = rig === 'mk1' ? proc.sampleRate : sensors[0].sampleRate;
    $('sv-rate').textContent = live && (rig === 'mk1' ? mk1History.n : mk2Histories[0].n) ? `${rate.toFixed(0)} per second` : '–';
  }
}

function drawChart() {
  const dpr = devicePixelRatio || 1;
  const w = chart.clientWidth, h = chart.clientHeight;
  if (chart.width !== Math.round(w * dpr)) { chart.width = Math.round(w * dpr); chart.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) { const y = Math.round(h * k / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  if (!hist.n) return;

  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < hist.n; k++) { lo = Math.min(lo, hist.raw[k], hist.smooth[k]); hi = Math.max(hi, hist.raw[k], hist.smooth[k]); }
  const c = proc.calibration;
  if (c) { lo = Math.min(lo, c.rest); hi = Math.max(hi, c.max); }
  if (hi - lo < 10) hi = lo + 10;
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const yOf = v => h - ((v - lo) / (hi - lo)) * h;
  const series = (arr, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let k = 0; k < hist.n; k++) {
      const idx = (hist.i - hist.n + k + HISTORY) % HISTORY;
      const x = (k / (HISTORY - 1)) * w + (HISTORY - hist.n) / (HISTORY - 1) * w;
      k ? ctx.lineTo(x, yOf(arr[idx])) : ctx.moveTo(x, yOf(arr[idx]));
    }
    ctx.stroke();
  };
  series(hist.raw, colors.raw, 1);
  series(hist.smooth, colors.smooth, 2);
  if (c) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = colors.cal; ctx.lineWidth = 1;
    for (const v of [c.rest, c.max]) { const y = Math.round(yOf(v)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------- start up
document.body.dataset.rig = rig;
$('rig').value = rig;
$('baud').value = String(rigBaud(rig));
setDemonLook(prefs.demon !== false);
setScale(prefs.signalScale === 'auto' ? 'auto' : 'full');
setupSignalView();
showCalibration();
showThresholds();
tick();

// ---------------------------------------------------------------- helpers
function setStatus(state, text) {
  $('status').className = `status ${state}`;
  $('status-text').textContent = text;
}
// action: optional { label, onClick } shown as a small button after the text.
function showMessage(text, kind, action = null) {
  const el = $('message');
  el.textContent = text || '';
  el.className = `message ${kind || ''}`;
  if (text && action) {
    const b = document.createElement('button');
    b.className = 'secondary msg-action';
    b.textContent = action.label;
    b.onclick = () => action.onClick();
    el.append(b);
  }
}
function formatDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}
function loadPrefs() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } }
function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
}
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
