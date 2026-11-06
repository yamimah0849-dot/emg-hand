// EMG signal pipeline: raw sample -> (optional rectification) -> EMA smoothing -> calibrated 0..1 grip level.
// Mark I uses one SignalProcessor. Mark II uses three (one per sensor), each with its own calibration.

const STORAGE_KEY = 'emghand.calibration.v1';

export class SignalProcessor {
  constructor({ storageKey = STORAGE_KEY } = {}) {
    this.storageKey = storageKey;
    this.settings = {
      mode: 'envelope',   // 'envelope': value rises with effort; 'raw': AC signal, use amplitude around baseline
      smoothingMs: 120,   // EMA time constant
      deadzone: 0.08,     // fraction of calibrated range ignored above rest (kills resting noise)
      gain: 1.0,          // >1 reaches a full fist with less effort
    };
    this.raw = 0;            // last raw value
    this.rectified = 0;      // value after mode handling
    this.smoothed = 0;       // after EMA
    this.level = 0;          // calibrated 0..1
    this.baseline = null;    // DC baseline for raw mode
    this.sampleRate = 100;   // estimated, Hz
    this._count = 0;
    this._rateT0 = performance.now();
    this._initialised = false;
    this.calibration = loadCalibration(storageKey);
    this.listeners = new Set();
  }

  onSample(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  push(value) {
    const now = performance.now();
    this._count++;
    if (now - this._rateT0 >= 1000) {
      const r = (this._count * 1000) / (now - this._rateT0);
      this.sampleRate = this.sampleRate * 0.5 + r * 0.5;
      this._count = 0; this._rateT0 = now;
    }

    this.raw = value;
    let x = value;
    if (this.settings.mode === 'raw') {
      // Slow-moving baseline (~2 s) removes the DC offset; amplitude = |deviation|.
      if (this.baseline === null) this.baseline = value;
      const a = 1 - Math.exp(-1 / (Math.max(this.sampleRate, 1) * 2.0));
      this.baseline += (value - this.baseline) * a;
      x = Math.abs(value - this.baseline);
    }
    this.rectified = x;

    if (!this._initialised) { this.smoothed = x; this._initialised = true; }
    const tau = Math.max(this.settings.smoothingMs, 1) / 1000;
    const alpha = 1 - Math.exp(-1 / (Math.max(this.sampleRate, 1) * tau));
    this.smoothed += (x - this.smoothed) * alpha;

    this.level = this.normalise(this.smoothed);
    for (const fn of this.listeners) fn(this);
  }

  normalise(v) {
    const c = this.calibration;
    if (!c) return 0;
    const range = Math.max(c.max - c.rest, 1e-6);
    let t = (v - c.rest) / range;
    const dz = this.settings.deadzone;
    t = (t - dz) / (1 - dz);
    t *= this.settings.gain;
    return Math.min(1, Math.max(0, t));
  }

  setMode(mode) {
    this.settings.mode = mode;
    this.baseline = null;
    this._initialised = false;
  }

  setCalibration(cal) {
    this.calibration = cal;
    try { localStorage.setItem(this.storageKey, JSON.stringify(cal)); } catch {}
  }

  // Switch to another saved calibration slot (Mark II keeps demo-mode calibrations separate).
  setStorageKey(key) {
    this.storageKey = key;
    this.calibration = loadCalibration(key);
  }
}

function loadCalibration(key) {
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (c && Number.isFinite(c.rest) && Number.isFinite(c.max) && c.max > c.rest) return c;
  } catch {}
  return null;
}

// Two-phase calibration: record relaxed level, then max clench.
export class Calibrator {
  constructor(processor, { restMs = 3000, clenchMs = 3000, prepMs = 1500 } = {}) {
    this.p = processor;
    this.restMs = restMs; this.clenchMs = clenchMs; this.prepMs = prepMs;
    this.active = false;
  }

  // onUpdate({phase, progress, secondsLeft}) ; resolves with calibration or rejects with Error
  run(onUpdate) {
    if (this.active) return Promise.reject(new Error('Calibration already running'));
    this.active = true;
    const phases = [
      { name: 'prep-rest', ms: this.prepMs },
      { name: 'rest', ms: this.restMs },
      { name: 'prep-clench', ms: this.prepMs },
      { name: 'clench', ms: this.clenchMs },
    ];
    const samples = { rest: [], clench: [] };
    let phaseIdx = 0;
    let phaseStart = performance.now();
    const off = this.p.onSample(p => {
      const name = phases[phaseIdx]?.name;
      if (name === 'rest' || name === 'clench') samples[name].push(p.smoothed);
    });

    return new Promise((resolve, reject) => {
      this._cancel = () => { cleanup(); reject(new Error('cancelled')); };
      const cleanup = () => { off(); clearInterval(timer); this.active = false; this._cancel = null; };
      const timer = setInterval(() => {
        const now = performance.now();
        let ph = phases[phaseIdx];
        if (now - phaseStart >= ph.ms) {
          if (ph.name === 'rest' && samples.rest.length < 5) {
            cleanup(); reject(new Error('No data received during calibration. Is the sensor sending values?')); return;
          }
          phaseIdx++; phaseStart = now;
          if (phaseIdx >= phases.length) {
            cleanup();
            try { resolve(this._compute(samples)); } catch (e) { reject(e); }
            return;
          }
          ph = phases[phaseIdx];
        }
        const elapsed = now - phaseStart;
        onUpdate?.({ phase: ph.name, progress: elapsed / ph.ms, secondsLeft: Math.ceil((ph.ms - elapsed) / 1000) });
      }, 50);
    });
  }

  cancel() { this._cancel?.(); }

  _compute({ rest, clench }) {
    if (clench.length < 5) throw new Error('No data received while clenching.');
    const sr = [...rest].sort((a, b) => a - b);
    const sc = [...clench].sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * (arr.length - 1)))];
    const restLevel = q(sr, 0.5);
    const mean = rest.reduce((s, v) => s + v, 0) / rest.length;
    const noise = Math.sqrt(rest.reduce((s, v) => s + (v - mean) ** 2, 0) / rest.length);
    // 85th percentile: the clench you can actually hold, ignoring brief spikes.
    const maxLevel = q(sc, 0.85);
    const span = maxLevel - restLevel;
    if (span <= Math.max(3 * noise, 2)) {
      throw new Error(`Clench wasn't clearly stronger than rest (rest ≈ ${restLevel.toFixed(0)}, clench ≈ ${maxLevel.toFixed(0)}). Check electrode placement and try again.`);
    }
    return { rest: restLevel, max: maxLevel, noise, mode: this.p.settings.mode, date: new Date().toISOString() };
  }
}


// ---------------------------------------------------------------------------------------------
// Mark II calibration: one relaxed recording for all sensors, then one flex per finger group.
// While a group flexes, the other sensors are recorded too. How far they rise (as a fraction of
// their own rest-to-max range) is the crosstalk, which is used to suggest a threshold per sensor.

const quantile = (arr, f) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
};
const stdDev = arr => {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
};

export class MultiCalibrator {
  constructor(processors, { restMs = 3000, flexMs = 3000, prepMs = 1500 } = {}) {
    this.procs = processors;
    this.restMs = restMs; this.flexMs = flexMs; this.prepMs = prepMs;
    this.active = false;
  }

  // sensors: which sensors to calibrate, e.g. [0, 1, 2] for all or [1] to redo sensor 2 only.
  // onUpdate({ phase, sensor, step, steps, progress, secondsLeft })
  // Resolves with { calibrations, errors, crosstalk }:
  //   calibrations[k]  new calibration for sensor k, or null if it failed / wasn't run
  //   errors[k]        message for a sensor that failed
  //   crosstalk[j][k]  how far sensor j rose (0..1 of its range) while group k flexed; NaN = not measured
  run(onUpdate, { sensors = this.procs.map((_, i) => i) } = {}) {
    if (this.active) return Promise.reject(new Error('Calibration already running'));
    this.active = true;
    const n = this.procs.length;
    const phases = [{ name: 'prep-rest', ms: this.prepMs }, { name: 'rest', ms: this.restMs }];
    for (const k of sensors) {
      phases.push({ name: 'prep-flex', sensor: k, ms: this.prepMs }, { name: 'flex', sensor: k, ms: this.flexMs });
    }
    const steps = 1 + sensors.length;
    const blank = () => this.procs.map(() => []);
    const samples = { rest: blank(), flex: {} };
    for (const k of sensors) samples.flex[k] = blank();

    let phaseIdx = 0;
    let phaseStart = performance.now();
    const offs = this.procs.map((p, j) => p.onSample(() => {
      const ph = phases[phaseIdx];
      if (ph?.name === 'rest') samples.rest[j].push(p.smoothed);
      else if (ph?.name === 'flex') samples.flex[ph.sensor][j].push(p.smoothed);
    }));

    return new Promise((resolve, reject) => {
      const cleanup = () => { offs.forEach(off => off()); clearInterval(timer); this.active = false; this._cancel = null; };
      this._cancel = () => { cleanup(); reject(new Error('cancelled')); };
      const timer = setInterval(() => {
        const now = performance.now();
        let ph = phases[phaseIdx];
        if (now - phaseStart >= ph.ms) {
          if (ph.name === 'rest' && samples.rest.some(a => a.length < 5)) {
            cleanup(); reject(new Error('No data received during calibration. Is the Arduino sending three values per line?')); return;
          }
          phaseIdx++; phaseStart = now;
          if (phaseIdx >= phases.length) {
            cleanup();
            resolve(this._compute(samples, sensors, n));
            return;
          }
          ph = phases[phaseIdx];
        }
        const elapsed = now - phaseStart;
        const step = ph.name.endsWith('rest') ? 1 : 2 + sensors.indexOf(ph.sensor);
        onUpdate?.({
          phase: ph.name, sensor: ph.sensor, step, steps,
          progress: elapsed / ph.ms, secondsLeft: Math.ceil((ph.ms - elapsed) / 1000),
        });
      }, 50);
    });
  }

  cancel() { this._cancel?.(); }

  _compute(samples, sensors, n) {
    const calibrations = Array(n).fill(null);
    const errors = Array(n).fill(null);
    const mode = this.procs[0].settings.mode;
    for (const k of sensors) {
      const rest = samples.rest[k], flex = samples.flex[k][k];
      if (flex.length < 5) { errors[k] = `Sensor ${k + 1}: no data received while flexing.`; continue; }
      const restLevel = quantile(rest, 0.5);
      const noise = stdDev(rest);
      const maxLevel = quantile(flex, 0.85);  // the flex you can actually hold, ignoring brief spikes
      if (maxLevel - restLevel <= Math.max(3 * noise, 2)) {
        errors[k] = `Sensor ${k + 1} didn't react clearly (rest ≈ ${restLevel.toFixed(0)}, flex ≈ ${maxLevel.toFixed(0)}). ` +
          `Check its pads, then press Redo next to sensor ${k + 1}.`;
        continue;
      }
      calibrations[k] = { rest: restLevel, max: maxLevel, noise, mode, date: new Date().toISOString() };
    }

    // Crosstalk: while group k flexed, how high did sensor j go, as a fraction of j's own range?
    const crosstalk = Array.from({ length: n }, () => Array(n).fill(NaN));
    for (const k of sensors) {
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const cal = calibrations[j] ?? this.procs[j].calibration;
        const vals = samples.flex[k][j];
        if (!cal || vals.length < 5) continue;
        const range = Math.max(cal.max - cal.rest, 1e-6);
        crosstalk[j][k] = Math.min(1, Math.max(0, (quantile(vals, 0.85) - cal.rest) / range));
      }
    }
    return { calibrations, errors, crosstalk };
  }
}

// Threshold suggestion for each sensor: just above the most crosstalk it picked up from any other
// finger group, so other groups' movements stay below it. Returns NaN where nothing was measured.
export function suggestThresholds(crosstalk, { margin = 0.05, min = 0.05, max = 0.6 } = {}) {
  return crosstalk.map(row => {
    const seen = row.filter(Number.isFinite);
    if (!seen.length) return NaN;
    return Math.min(max, Math.max(min, Math.max(...seen) + margin));
  });
}
