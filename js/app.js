import { HandScene, SKIN_TONES } from './hand.js';
import { SignalProcessor, Calibrator } from './signal.js';
import { SerialLink, serialSupported, portLabel } from './serial.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'emghand.settings.v1';
const prefs = loadPrefs();

// ---------------------------------------------------------------- core objects
const proc = new SignalProcessor();
Object.assign(proc.settings, pick(prefs, ['smoothingMs', 'deadzone', 'gain', 'mode']));
const calibrator = new Calibrator(proc);
const scene = new HandScene($('viewport'));
scene.responsiveness = prefs.responsiveness ?? 9;

const link = new SerialLink({
  onValue: v => { if (!demo.on) proc.push(v); },
  onStatus: ({ state, message }) => {
    setStatus(state, { idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', nodata: 'No data', error: 'Error' }[state]);
    showMessage(message, state === 'error' ? 'error' : state === 'nodata' ? 'warn' : '');
    $('connect').disabled = state === 'connecting';
    $('disconnect').disabled = !link.connected;
    if (state === 'connected' && message === 'Receiving data.' && !startupCalibrated) {
      startupCalibrated = true;
      setTimeout(() => startCalibration({ startup: true }), 600);
    }
    if (state === 'idle' || state === 'error') startupCalibrated = false;
  },
});
let startupCalibrated = false;

window.app = { scene, proc, link, calibrator };  // handy from DevTools

// ---------------------------------------------------------------- hand model
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
  const ok = await link.connect(port, +$('baud').value);
  await refreshPorts(port);
  if (ok) savePrefs({ baud: +$('baud').value });
};
$('disconnect').onclick = async () => { calibrator.cancel(); await link.disconnect(); $('disconnect').disabled = true; };

if (serialSupported()) {
  refreshPorts();
  navigator.serial.addEventListener('connect', () => refreshPorts());
  navigator.serial.addEventListener('disconnect', () => refreshPorts());
} else {
  $('connect').disabled = true;
  $('port-select').add(new Option('Serial not available', ''));
  showMessage('This browser cannot access serial ports. Open the app in Microsoft Edge or Google Chrome (use “Start EMG Hand.bat”). Demo mode still works.', 'error');
}
$('baud').value = String(prefs.baud ?? 9600);

// ---------------------------------------------------------------- demo mode (synthetic EMG)
const demo = { on: false, timer: null, effort: 0, held: false, auto: false };
function setDemo(on) {
  demo.on = on;
  $('demo').checked = on;
  clearInterval(demo.timer);
  if (on) {
    if (link.connected) link.disconnect();
    setStatus('demo', 'Demo mode');
    showMessage('Simulated sensor. Hold Space to clench — tap it lightly for a partial grip.', '');
    demo.timer = setInterval(() => {
      const want = demo.held || demo.auto ? 1 : 0;
      demo.effort += (want - demo.effort) * (want > demo.effort ? 0.035 : 0.05);
      const noise = () => (Math.random() - 0.5) * 2;
      let v;
      if (proc.settings.mode === 'raw') {
        const amp = 18 + demo.effort * 260;
        v = 512 + noise() * amp;
      } else {
        v = 70 + Math.abs(noise()) * 22 + demo.effort * (430 + noise() * 70);
      }
      proc.push(Math.round(v));
    }, 10);
    if (!proc.calibration) setTimeout(() => startCalibration({ startup: true }), 300);
  } else {
    demo.held = demo.auto = false;
    setStatus('idle', 'Not connected');
    showMessage('', '');
  }
}
$('demo').onchange = e => setDemo(e.target.checked);
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.code === 'Space' && demo.on) { demo.held = true; e.preventDefault(); }
  if (e.code === 'KeyC' && !e.repeat) startCalibration();
  if (e.code === 'Escape') calibrator.cancel();
});
addEventListener('keyup', e => { if (e.code === 'Space') demo.held = false; });

// ---------------------------------------------------------------- calibration
const CAL_TEXT = {
  'prep-rest':   ['Step 1 of 2', 'Relax your arm', 'Let your hand rest loosely. Recording starts in a moment…'],
  'rest':        ['Step 1 of 2', 'Stay relaxed', 'Recording your resting level. Keep still.'],
  'prep-clench': ['Step 2 of 2', 'Get ready to clench', 'Make a firm fist when the timer starts…'],
  'clench':      ['Step 2 of 2', 'Clench your fist!', 'Squeeze as hard as is comfortable and hold it.'],
};
async function startCalibration({ startup = false } = {}) {
  if (calibrator.active) return;
  if (!link.connected && !demo.on) {
    showMessage('Connect to the sensor (or enable demo mode) before calibrating.', 'warn');
    return;
  }
  $('calib').hidden = false;
  $('calib-skip').hidden = !(startup && proc.calibration);
  const ring = document.querySelector('.calib-ring');
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
$('calibrate').onclick = () => startCalibration();
$('calib-cancel').onclick = () => calibrator.cancel();
$('calib-skip').onclick = () => calibrator.cancel();

function showCalibration() {
  const c = proc.calibration;
  $('c-rest').textContent = c ? c.rest.toFixed(0) : '–';
  $('c-max').textContent = c ? c.max.toFixed(0) : '–';
  $('c-noise').textContent = c ? '±' + c.noise.toFixed(1) : '–';
}
showCalibration();

// ---------------------------------------------------------------- tuning controls
bindSlider('smooth', 'o-smooth', v => `${v} ms`, v => { proc.settings.smoothingMs = v; savePrefs({ smoothingMs: v }); }, proc.settings.smoothingMs);
bindSlider('resp', 'o-resp', v => v.toFixed(1), v => { scene.responsiveness = v; savePrefs({ responsiveness: v }); }, scene.responsiveness);
bindSlider('dz', 'o-dz', v => `${Math.round(v * 100)}%`, v => { proc.settings.deadzone = v; savePrefs({ deadzone: v }); }, proc.settings.deadzone);
bindSlider('gain', 'o-gain', v => `×${v.toFixed(2)}`, v => { proc.settings.gain = v; savePrefs({ gain: v }); }, proc.settings.gain);
$('mode').value = proc.settings.mode;
$('mode').onchange = e => {
  proc.setMode(e.target.value);
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
  };
  $('swatches').append(b);
}

// ---------------------------------------------------------------- live readouts + chart
const HISTORY = 600;
const hist = { raw: new Float32Array(HISTORY), smooth: new Float32Array(HISTORY), n: 0, i: 0 };
const chart = $('chart');
const ctx = chart.getContext('2d');
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colors = { raw: css('--raw'), smooth: css('--smooth'), cal: css('--cal'), grid: '#1d252f' };
let lastSampleCount = 0, sampleCount = 0;
proc.onSample(() => sampleCount++);

function tick() {
  requestAnimationFrame(tick);
  const fresh = sampleCount !== lastSampleCount;
  lastSampleCount = sampleCount;

  // Drive the hand only when there is a live signal and a calibration (and not mid-calibration).
  const live = (link.connected || demo.on) && proc.calibration && !calibrator.active;
  scene.target = live ? proc.level : 0;

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
tick();

// ---------------------------------------------------------------- helpers
function setStatus(state, text) {
  $('status').className = `status ${state}`;
  $('status-text').textContent = text;
}
function showMessage(text, kind) {
  const el = $('message');
  el.textContent = text || '';
  el.className = `message ${kind || ''}`;
}
function loadPrefs() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } }
function savePrefs(patch) {
  Object.assign(prefs, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch {}
}
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
