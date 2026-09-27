// Tiny WebAudio chiptune SFX synth. Off by default; the choice is persisted.
// Browsers only allow audio after a user gesture: call unlock() from a click/tap handler.
//   play('throw' | 'splat' | 'bigSplat' | 'victory' | 'giant', { intensity: 0..1 })

const SOUND_KEY = 'sb.sound';
const MASTER_GAIN = 0.18;
const MIN_GAP_MS = { throw: 70, splat: 60, bigSplat: 150, victory: 1500, giant: 1500 };

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = readSaved();
const lastPlayed = {};

function readSaved() {
  try { return localStorage.getItem(SOUND_KEY) === '1'; } catch { return false; }
}

export const isSoundEnabled = () => enabled;

export function setSoundEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem(SOUND_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
  if (enabled) unlock();
  return enabled;
}

export const toggleSound = () => setSoundEnabled(!enabled);

// Create / resume the AudioContext. Safe to call on every gesture.
export function unlock() {
  if (!enabled) return;
  try {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch (err) {
    console.warn('[audio] unavailable', err);
  }
}

// ---------- primitives ----------
function env(gainNode, t0, attack, peak, decay) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(peak, t0 + attack);
  g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone({ type = 'square', from, to = from, t0, dur, peak = 0.5, attack = 0.005 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  env(g, t0, attack, peak, dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + dur + 0.02);
}

function noise({ t0, dur, peak = 0.5, filter = 'lowpass', from = 2000, to = from, q = 1, attack = 0.005 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t0);
  if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  env(g, t0, attack, peak, dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + attack + dur + 0.02);
}

// ---------- sounds ----------
const SOUNDS = {
  throw(t0, k) {
    noise({ t0, dur: 0.12, peak: 0.25 + 0.2 * k, filter: 'bandpass', from: 3000, to: 700, q: 2, attack: 0.02 });
  },
  splat(t0, k) {
    noise({ t0, dur: 0.09, peak: 0.35 + 0.3 * k, from: 1400, to: 300 });
    tone({ from: 220, to: 90, t0, dur: 0.06, peak: 0.15 });
  },
  bigSplat(t0, k) {
    noise({ t0, dur: 0.3, peak: 0.6 + 0.3 * k, from: 1800, to: 150 });
    tone({ from: 140, to: 45, t0, dur: 0.25, peak: 0.35 });
  },
  victory(t0) {
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
    const lens = [0.1, 0.1, 0.1, 0.18, 0.1, 0.45];
    let t = t0;
    notes.forEach((f, i) => {
      tone({ from: f, t0: t, dur: lens[i], peak: 0.3 });
      tone({ type: 'triangle', from: f / 4, t0: t, dur: lens[i], peak: 0.35 });
      t += lens[i] + 0.02;
    });
  },
  giant(t0, k) {
    // roar: detuned low saws gliding down, then two stomps
    tone({ type: 'sawtooth', from: 110, to: 55, t0, dur: 0.7, peak: 0.25 + 0.15 * k, attack: 0.08 });
    tone({ type: 'sawtooth', from: 116, to: 58, t0, dur: 0.7, peak: 0.2, attack: 0.08 });
    noise({ t0, dur: 0.6, peak: 0.15, filter: 'bandpass', from: 600, to: 200, q: 3, attack: 0.1 });
    for (const dt of [0.8, 1.15]) {
      tone({ type: 'sine', from: 90, to: 30, t0: t0 + dt, dur: 0.22, peak: 0.9 });
      noise({ t0: t0 + dt, dur: 0.15, peak: 0.4, from: 500, to: 80 });
    }
  },
};

export function play(name, { intensity = 0.5 } = {}) {
  if (!enabled || !ctx || ctx.state !== 'running' || !SOUNDS[name]) return;
  const now = performance.now();
  if (now - (lastPlayed[name] || 0) < (MIN_GAP_MS[name] || 0)) return;
  lastPlayed[name] = now;
  try {
    SOUNDS[name](ctx.currentTime + 0.01, Math.min(1, Math.max(0, intensity)));
  } catch (err) {
    console.warn('[audio] play failed', name, err);
  }
}
