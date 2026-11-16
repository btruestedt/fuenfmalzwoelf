// Dezente, vollständig synthetisierte Klänge (Web Audio) – keine Audiodateien nötig.

let ctx = null;
let master = null;
let noise = null;
let lastImpact = 0;
let muted = false;
try {
  muted = localStorage.getItem('wuerfel.muted') === '1';
} catch {}

export const isMuted = () => muted;

export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem('wuerfel.muted', m ? '1' : '0');
  } catch {}
  if (master) master.gain.value = m ? 0 : 0.9;
}

/** Muss aus einer Nutzeraktion heraus aufgerufen werden (Autoplay-Regeln der Browser). */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function burst({ type, freq, q = 1, gain, dur, at = 0 }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.5;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.1, dur + 0.02);
}

function tone({ freq, gain, dur, at = 0, type = 'sine', slideTo }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Aufprall eines Würfels: auf Samt dumpf, Würfel auf Würfel ein kurzes helles Klacken. */
export function impact(kind, strength) {
  if (!ctx || muted) return;
  const now = performance.now();
  if (now - lastImpact < 14) return;
  lastImpact = now;
  const s = Math.min(1, strength / 14);
  if (kind === 'dice') {
    burst({ type: 'bandpass', freq: 2600 + Math.random() * 1600, q: 2.5, gain: 0.05 + 0.3 * s, dur: 0.035 });
    tone({ freq: 1500 + Math.random() * 500, gain: 0.02 + 0.06 * s, dur: 0.03, type: 'triangle' });
  } else {
    burst({ type: 'lowpass', freq: 500 + 700 * s, gain: 0.08 + 0.42 * s, dur: 0.07 });
    tone({ freq: 120 + Math.random() * 30, slideTo: 70, gain: 0.05 + 0.2 * s, dur: 0.08 });
  }
}

const bell = (freq, at, gain = 0.09, dur = 0.9) => {
  tone({ freq, gain, dur, at });
  tone({ freq: freq * 2.01, gain: gain * 0.25, dur: dur * 0.6, at });
};

/** Treffer herausgelegt. */
export function hit(count = 1) {
  if (!ctx || muted) return;
  for (let i = 0; i < Math.min(count, 5); i++) bell(784 * Math.pow(1.122, i), 0.25 + i * 0.11, 0.07, 0.7);
}

/** Eine Zahl ist komplett. */
export function complete() {
  if (!ctx || muted) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, 0.3 + i * 0.1, 0.085, 1.2));
}

/** Zug vorbei. */
export function bust() {
  if (!ctx || muted) return;
  tone({ freq: 196, slideTo: 147, gain: 0.12, dur: 0.45, at: 0.1 });
  tone({ freq: 147, slideTo: 110, gain: 0.1, dur: 0.6, at: 0.32 });
}

export function win() {
  if (!ctx || muted) return;
  [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, i) => bell(f, 0.3 + i * 0.14, 0.1, 1.6));
}

export function tap() {
  if (!ctx || muted) return;
  tone({ freq: 660, gain: 0.03, dur: 0.06 });
}
