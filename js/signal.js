// EMG signal pipeline: raw sample -> (optional rectification) -> EMA smoothing -> calibrated 0..1 grip level.

const STORAGE_KEY = 'emghand.calibration.v1';

export class SignalProcessor {
  constructor() {
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
    this.calibration = loadCalibration();
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cal)); } catch {}
  }
}

function loadCalibration() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY));
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
