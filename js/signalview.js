// Live signal view: one lane per sensor, each with a scrolling graph, a big live number and an
// activity meter, so you can see at a glance which sensor reacts when you move each finger.
// It replaces the Arduino IDE's Serial Plotter for testing.

// Sensor colours: three categorical hues checked for colour-blind separation and contrast on the
// dark chart background. Every lane is also labelled in text, so colour is never the only cue.
export const SENSORS = [
  { name: 'Sensor 1', pin: 'A0', group: 'Thumb',          fingers: ['thumb'],           color: '#3987e5' },
  { name: 'Sensor 2', pin: 'A1', group: 'Index + middle', fingers: ['index', 'middle'], color: '#d95926' },
  { name: 'Sensor 3', pin: 'A2', group: 'Ring + pinky',   fingers: ['ring', 'pinky'],   color: '#199e70' },
];
export const MK1_SENSOR = {
  name: 'Sensor', pin: 'A0', group: 'Whole hand', fingers: ['thumb', 'index', 'middle', 'ring', 'pinky'], color: '#3ddcb4',
};

// Ring buffer of recent samples: time (ms), raw reading and smoothed value.
export class SignalHistory {
  constructor(capacity = 4096) {
    this.cap = capacity;
    this.t = new Float64Array(capacity);
    this.raw = new Float32Array(capacity);
    this.smooth = new Float32Array(capacity);
    this.n = 0; this.i = 0;
  }
  push(t, raw, smooth) {
    this.t[this.i] = t; this.raw[this.i] = raw; this.smooth[this.i] = smooth;
    this.i = (this.i + 1) % this.cap;
    this.n = Math.min(this.cap, this.n + 1);
  }
  // k = 0 is the newest sample.
  idx(k) { return (this.i - 1 - k + this.cap) % this.cap; }
  clear() { this.n = 0; this.i = 0; }
}

// How active a sensor is, 0..1: its place between the calibrated rest and max (before the
// threshold), or its share of the 0..1023 range if it hasn't been calibrated yet.
export function activity(proc) {
  const c = proc.calibration;
  if (!c) return Math.min(1, Math.max(0, proc.smoothed / 1023));
  return Math.min(1, Math.max(0, (proc.smoothed - c.rest) / Math.max(c.max - c.rest, 1e-6)));
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class SignalView {
  constructor(root) {
    this.root = root;
    this.lanesEl = root.querySelector('.sv-lanes');
    this.windowMs = 6000;
    this.scale = 'full';     // 'full' = fixed 0..1023 (compare sensors on one scale), 'auto' = zoom to fit
    this.paused = false;
    this.pausedAt = 0;
    this.hover = null;       // crosshair position, 0..1 across the graph, shared by every lane
    this.lanes = [];
    this.colors = { grid: '#1d252f', text: css('--muted'), ink: css('--text'), rest: '#8a96a6', max: '#c9d2dd' };
  }

  // defs: [{ sensor, proc, history, thresholdLabel }]
  setLanes(defs) {
    this.lanesEl.innerHTML = '';
    this.lanes = defs.map(def => {
      const el = document.createElement('div');
      el.className = 'lane';
      el.style.setProperty('--c', def.sensor.color);
      el.innerHTML = `
        <div class="lane-head">
          <div class="lane-title"><i class="sw"></i><b>${def.sensor.name}</b><span class="pin">${def.sensor.pin}</span></div>
          <div class="lane-group">${def.sensor.group}</div>
          <div class="lane-value"><span class="num">–</span><small>smoothed</small></div>
          <div class="lane-raw">raw <span>–</span></div>
          <div class="lane-out">–</div>
        </div>
        <div class="lane-plot"><canvas></canvas></div>
        <div class="lane-meter" title="Activity: how far between rest and max this sensor is">
          <div class="meter-fill"></div><div class="meter-thr"></div>
        </div>`;
      this.lanesEl.append(el);
      const canvas = el.querySelector('canvas');
      canvas.addEventListener('pointermove', e => {
        const r = canvas.getBoundingClientRect();
        this.hover = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      });
      canvas.addEventListener('pointerleave', () => { this.hover = null; });
      return {
        ...def, el, canvas, ctx: canvas.getContext('2d'),
        num: el.querySelector('.num'), raw: el.querySelector('.lane-raw span'), out: el.querySelector('.lane-out'),
        fill: el.querySelector('.meter-fill'), thr: el.querySelector('.meter-thr'),
      };
    });
    this.root.classList.toggle('single', defs.length === 1);
  }

  setPaused(p) {
    this.paused = p;
    if (p) this.pausedAt = performance.now();
  }

  draw() {
    const now = this.paused ? this.pausedAt : performance.now();
    for (const lane of this.lanes) this._drawLane(lane, now);
  }

  _drawLane(lane, now) {
    const { proc, history: h, canvas, ctx } = lane;
    const cal = proc.calibration;
    const thrFrac = proc.settings.deadzone;
    const level = proc.level;                         // what actually drives the hand, after the threshold
    const act = activity(proc);

    // ---- header numbers and meter
    lane.num.textContent = h.n ? proc.smoothed.toFixed(0) : '–';
    lane.raw.textContent = h.n ? proc.raw.toFixed(0) : '–';
    let active;
    if (!cal) {
      lane.out.textContent = 'Not calibrated';
      // Without a calibration, call it active when it's well above its lowest recent value.
      active = h.n > 0 && proc.smoothed - this._windowMin(h, now) > 60;
    } else if (level > 0) {
      lane.out.innerHTML = `Moves hand <b>${Math.round(level * 100)}%</b>`;
      active = level > 0.02;
    } else {
      lane.out.textContent = act > 0.03 ? 'Below threshold' : 'Resting';
      active = false;
    }
    lane.el.classList.toggle('active', active);
    lane.fill.style.height = `${(act * 100).toFixed(1)}%`;
    lane.fill.classList.toggle('over', !!cal && act > thrFrac);
    lane.thr.style.bottom = `${(thrFrac * 100).toFixed(1)}%`;
    lane.thr.hidden = !cal;

    // ---- graph
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, ht = canvas.clientHeight;
    if (!w || !ht) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(ht * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);

    const t0 = now - this.windowMs;
    let lo = 0, hi = 1023;
    if (this.scale === 'auto') {
      lo = Infinity; hi = -Infinity;
      for (let k = 0; k < h.n; k++) {
        const j = h.idx(k);
        if (h.t[j] < t0) break;
        lo = Math.min(lo, h.raw[j], h.smooth[j]); hi = Math.max(hi, h.raw[j], h.smooth[j]);
      }
      if (cal) { lo = Math.min(lo, cal.rest); hi = Math.max(hi, cal.max); }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1023; }
      if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
      const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    }
    const top = 6, bottom = ht - 6;
    const yOf = v => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    const xOf = t => ((t - t0) / this.windowMs) * w;

    // Recessive grid with a few value labels.
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 1;
    const ticks = this.scale === 'full' ? [0, 256, 512, 768, 1023] : niceTicks(lo, hi, 4);
    for (const v of ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = this.colors.grid;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = this.colors.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round(v)), 4, Math.min(bottom - 6, Math.max(top + 6, y)));
    }

    // Rest, max and threshold as dashed reference lines, labelled at the right edge.
    if (cal) {
      const thrValue = cal.rest + thrFrac * (cal.max - cal.rest);
      const refs = [
        [cal.rest, this.colors.rest, `rest ${cal.rest.toFixed(0)}`],
        [cal.max, this.colors.max, `max ${cal.max.toFixed(0)}`],
        [thrValue, lane.sensor.color, `${lane.thresholdLabel ?? 'threshold'} ${thrValue.toFixed(0)}`],
      ];
      ctx.setLineDash([4, 4]);
      for (const [v, color] of refs) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = color; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // Labels: nudge apart if they'd overlap.
      const placed = [];
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      for (const [v, , text] of [...refs].sort((a, b) => b[0] - a[0])) {
        let y = yOf(v) - 2;
        for (const p of placed) if (Math.abs(p - y) < 11) y = p + 11;
        y = Math.min(bottom, Math.max(top + 10, y));
        placed.push(y);
        ctx.fillStyle = this.colors.text;
        ctx.fillText(text, w - 4, y);
      }
    }

    if (!h.n) {
      ctx.fillStyle = this.colors.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('Waiting for data…', w / 2, ht / 2);
      return;
    }

    // Raw reading (thin, faint) under the smoothed value (thick).
    const series = (arr, width, alpha) => {
      ctx.strokeStyle = lane.sensor.color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      let first = true;
      for (let k = 0; k < h.n; k++) {
        const j = h.idx(k);
        const x = xOf(h.t[j]), y = yOf(arr[j]);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        if (h.t[j] < t0) break;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    series(h.raw, 1, 0.4);
    series(h.smooth, 2, 1);

    // Crosshair + readout, at the same moment in every lane.
    if (this.hover != null) {
      const th = t0 + this.hover * this.windowMs;
      let best = -1, bestDt = Infinity;
      for (let k = 0; k < h.n; k++) {
        const j = h.idx(k);
        const dt = Math.abs(h.t[j] - th);
        if (dt < bestDt) { bestDt = dt; best = j; }
        if (h.t[j] < th - 50) break;
      }
      const x = Math.round(this.hover * w) + 0.5;
      ctx.strokeStyle = this.colors.max; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ht); ctx.stroke();
      ctx.globalAlpha = 1;
      if (best >= 0 && bestDt < 200) {
        const y = yOf(h.smooth[best]);
        ctx.fillStyle = lane.sensor.color;
        ctx.strokeStyle = '#0f141a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        const text = `${h.smooth[best].toFixed(0)} smoothed · ${h.raw[best].toFixed(0)} raw · ${((h.t[best] - now) / 1000).toFixed(1)} s`;
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 12;
        const bx = Math.min(w - tw - 2, Math.max(2, x + 8 > w - tw ? x - tw - 8 : x + 8));
        const by = Math.min(ht - 22, Math.max(2, y - 26));
        ctx.fillStyle = 'rgba(15,20,26,.92)'; ctx.strokeStyle = '#262f3a'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(bx, by, tw, 20, 5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = this.colors.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 6, by + 10);
      }
    }
  }

  _windowMin(h, now) {
    let m = Infinity;
    for (let k = 0; k < h.n; k++) {
      const j = h.idx(k);
      if (h.t[j] < now - this.windowMs) break;
      m = Math.min(m, h.smooth[j]);
    }
    return m;
  }
}

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(s => s * mag).find(s => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}
