// Retro 8-bit sounds for each sale on the TV screen, synthesized with Web
// Audio (square/triangle waves + noise, like an old console). All melodies
// are our own. Any tier can be swapped for a file: drop
// public/sonidos/venta-<tier>.mp3 (0 = small sale … 4 = +2M) and it is used
// instead of the synthesized one.
//
// Browsers only allow sound after a click on the page: call unlockSounds()
// from the click that turns the TV mode on.
let ctx = null;
const files = new Map(); // tier -> HTMLAudioElement, when a file exists

function audio() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI note -> Hz
const C4 = 60;

function tone(ac, out, { t, dur, midi, type = 'square', vol = 0.18, slideTo = null, vibrato = 0 }) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(NOTE(midi), t);
  if (slideTo != null) o.frequency.exponentialRampToValueAtTime(NOTE(slideTo), t + dur);
  if (vibrato) {
    const lfo = ac.createOscillator();
    const lg = ac.createGain();
    lfo.frequency.value = 6; lg.gain.value = NOTE(midi) * vibrato;
    lfo.connect(lg); lg.connect(o.frequency);
    lfo.start(t + dur * 0.25); lfo.stop(t + dur + 0.02);
  }
  // Short attack, a flat body and a quick release: the "chip" envelope.
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.setValueAtTime(vol, t + Math.max(0.01, dur - 0.03));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.02);
}

let noise = null;
function noiseHit(ac, out, t, { dur = 0.08, vol = 0.2, freq = 3000, type = 'highpass' } = {}) {
  if (!noise) {
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource();
  src.buffer = noise;
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t, Math.random() * 0.5, dur + 0.02);
}

function kick(ac, out, t, vol = 0.5) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2);
}

// Notes as [semitones from C4, length in steps]; null = rest.
function phrase(ac, out, t, step, notes, opts = {}) {
  let at = t;
  for (const [n, len] of notes) {
    if (n != null) tone(ac, out, { t: at, dur: step * len * 0.92, midi: C4 + n, ...opts });
    at += step * len;
  }
  return at;
}

// 0 · small sale: a short two-note blip.
function blip(ac, out, t) {
  phrase(ac, out, t, 0.06, [[21, 1], [28, 2]], { vol: 0.08 });
  return 0.25;
}

// 1 · 500k–1M: a bright coin-like arpeggio with a sparkle on top.
function coin(ac, out, t) {
  const end = phrase(ac, out, t, 0.055, [[24, 1], [28, 1], [31, 1], [36, 3]], { vol: 0.16 });
  tone(ac, out, { t: end - 0.05, dur: 0.35, midi: C4 + 43, vol: 0.06, type: 'triangle' });
  return end - t + 0.4;
}

// 2 · 1M–1.5M: a power-up that climbs three octaves, doubled an octave below.
function powerUp(ac, out, t) {
  const up = [7, 11, 14, 19, 23, 26, 31, 35, 38, 43];
  const step = 0.05;
  up.forEach((n, i) => {
    tone(ac, out, { t: t + i * step, dur: step * 0.9, midi: C4 + n, vol: 0.14 });
    tone(ac, out, { t: t + i * step, dur: step * 0.9, midi: C4 + n - 12, vol: 0.1, type: 'triangle' });
  });
  const end = t + up.length * step;
  tone(ac, out, { t: end, dur: 0.45, midi: C4 + 43, vol: 0.14, vibrato: 0.01 });
  tone(ac, out, { t: end, dur: 0.45, midi: C4 + 36, vol: 0.1, type: 'triangle' });
  return end - t + 0.5;
}

// 3 · 1.5M–2M: a short victory jingle with bass and snare.
function jingle(ac, out, t) {
  const step = 0.11;
  const lead = [[16, 1], [19, 1], [24, 1], [null, 1], [21, 1], [24, 1], [28, 2], [26, 1], [28, 1], [31, 4]];
  const bass = [[-12, 2], [-5, 2], [-7, 2], [-3, 2], [-5, 2], [0, 4]];
  phrase(ac, out, t, step, lead, { vol: 0.15 });
  phrase(ac, out, t, step, bass, { vol: 0.16, type: 'triangle' });
  [0, 2, 4, 6, 8, 10].forEach(i => noiseHit(ac, out, t + i * step, { dur: 0.06, vol: 0.08 }));
  kick(ac, out, t);
  kick(ac, out, t + 10 * step);
  noiseHit(ac, out, t + 10 * step, { dur: 0.9, vol: 0.12, freq: 6000 });
  return 14 * step + 0.4;
}

// 4 · +2M: the big one. Drum roll, a march-like theme, a key change up and a
// long shimmering final chord with cymbal.
function epic(ac, out, t) {
  const step = 0.1;
  // Drum roll building up (1 s)
  for (let i = 0; i < 16; i++) noiseHit(ac, out, t + i * 0.06, { dur: 0.05, vol: 0.05 + i * 0.01, freq: 2000, type: 'bandpass' });
  const t1 = t + 1.0;
  kick(ac, out, t1, 0.7);
  noiseHit(ac, out, t1, { dur: 0.6, vol: 0.15, freq: 6000 });
  const theme = [[12, 1], [12, 1], [12, 1], [12, 3], [8, 3], [10, 3], [12, 2], [10, 1], [12, 6]];
  const bass = [[-12, 3], [-12, 3], [-16, 3], [-14, 3], [-12, 6]];
  const t2 = phrase(ac, out, t1, step, theme, { vol: 0.15 });
  phrase(ac, out, t1, step, bass, { vol: 0.17, type: 'triangle' });
  for (let i = 0; i < 18; i += 3) kick(ac, out, t1 + i * step, 0.45);
  // Same theme two semitones up, faster, into the finale.
  const up = theme.map(([n, l]) => [n + 2, l * 0.7]);
  const t3 = phrase(ac, out, t2, step, up, { vol: 0.16 });
  phrase(ac, out, t2, step * 0.7, [[-10, 3], [-10, 3], [-14, 3], [-12, 3], [-10, 6]], { vol: 0.17, type: 'triangle' });
  for (let i = 0; i < 18; i += 3) kick(ac, out, t2 + i * step * 0.7, 0.45);
  // Finale: fast arpeggio shimmer over a held chord + cymbal.
  const chord = [26, 30, 33, 38];
  for (let i = 0; i < 24; i++) tone(ac, out, { t: t3 + i * 0.045, dur: 0.04, midi: C4 + chord[i % 4] + 12, vol: 0.07 });
  chord.forEach(n => tone(ac, out, { t: t3, dur: 1.8, midi: C4 + n, vol: 0.09, vibrato: 0.008 }));
  tone(ac, out, { t: t3, dur: 1.8, midi: C4 + 2 - 12, vol: 0.18, type: 'triangle' });
  kick(ac, out, t3, 0.8);
  noiseHit(ac, out, t3, { dur: 2.2, vol: 0.2, freq: 5000 });
  return t3 - t + 2.0;
}

const SYNTH = [blip, coin, powerUp, jingle, epic];

async function probeFile(tier) {
  const url = `${import.meta.env?.BASE_URL ?? '/'}sonidos/venta-${tier}.mp3`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // A missing file falls back to index.html (200, text/html) on the static host.
    if (res.ok && (res.headers.get('content-type') || '').startsWith('audio')) {
      const el = new Audio(url);
      el.preload = 'auto';
      files.set(tier, el);
    }
  } catch { /* no file: synthesized */ }
}

// From a click. Resolves true when sound is allowed.
export async function unlockSounds() {
  const ac = audio();
  if (!ac) return false;
  try { await ac.resume(); } catch { /* blocked */ }
  await Promise.all([0, 1, 2, 3, 4].map(probeFile));
  return ac.state === 'running';
}

export function soundsReady() {
  return !!ctx && ctx.state === 'running';
}

// Plays tier 0..4; returns the sound's length in seconds (0 when blocked).
export function playSale(tier) {
  const file = files.get(tier);
  if (file) {
    const el = file.cloneNode();
    el.volume = 0.9;
    el.play().catch(() => {});
    return Number.isFinite(file.duration) ? file.duration : 2;
  }
  const ac = audio();
  if (!ac || ac.state !== 'running') return 0;
  const out = ac.createGain();
  out.gain.value = 0.8;
  const comp = ac.createDynamicsCompressor();
  out.connect(comp); comp.connect(ac.destination);
  return (SYNTH[tier] ?? blip)(ac, out, ac.currentTime + 0.03);
}
