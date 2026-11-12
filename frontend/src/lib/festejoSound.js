// Stadium air horns + drum roll + brass fanfare + crash, synthesized with Web
// Audio (no audio files). Browsers only let a page make sound after the
// person has clicked something on it: playFestejo() resolves false when the
// sound was blocked, so the screen can offer a button.
let ctx = null;

function audio() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

function noiseBuffer(ac, seconds) {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function horn(ac, out, t, dur) {
  const g = ac.createGain();
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 6;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
  g.gain.setValueAtTime(0.5, t + dur - 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g); g.connect(out);
  for (const [f, det] of [[466, 0], [466, 12], [587, -8], [233, 0]]) {
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.94, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    o.detune.value = det;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
  }
}

function brass(ac, out, t, freqs, dur, vol = 0.22) {
  const g = ac.createGain();
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(600, t);
  lp.frequency.exponentialRampToValueAtTime(3200, t + 0.08);
  lp.frequency.exponentialRampToValueAtTime(1800, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
  g.gain.setValueAtTime(vol, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g); g.connect(out);
  for (const f of freqs) {
    for (const det of [-7, 7]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.02);
    }
  }
}

function hit(ac, out, t, { dur, type, freq, vol }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur);
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t);
}

function kick(ac, out, t) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.32);
}

export async function playFestejo() {
  const ac = audio();
  if (!ac) return false;
  try { await ac.resume(); } catch { /* blocked */ }
  if (ac.state !== 'running') return false;

  const out = ac.createGain();
  out.gain.value = 0.55;
  const comp = ac.createDynamicsCompressor();
  out.connect(comp); comp.connect(ac.destination);
  const t0 = ac.currentTime + 0.05;

  // BWAP BWAP BWAAAAP
  horn(ac, out, t0, 0.22);
  horn(ac, out, t0 + 0.32, 0.22);
  horn(ac, out, t0 + 0.64, 0.95);

  // Drum roll building up
  const rollStart = t0 + 1.7;
  for (let i = 0; i < 18; i++) {
    hit(ac, out, rollStart + i * 0.055, { dur: 0.08, type: 'bandpass', freq: 1800, vol: 0.12 + i * 0.02 });
  }

  // Fanfare: G C E G ... C (big chord) + crash
  const f0 = rollStart + 1.05;
  const notes = [[392], [523], [659], [784]];
  notes.forEach((n, i) => { brass(ac, out, f0 + i * 0.14, n, 0.16); kick(ac, out, f0 + i * 0.14); });
  const big = f0 + notes.length * 0.14 + 0.05;
  brass(ac, out, big, [523, 659, 784, 1047], 1.9, 0.26);
  kick(ac, out, big);
  hit(ac, out, big, { dur: 3.2, type: 'highpass', freq: 5000, vol: 0.5 });

  // Final horn over the chord
  horn(ac, out, big + 1.1, 0.9);
  return true;
}
