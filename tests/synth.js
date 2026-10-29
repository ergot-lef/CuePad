// Génère un morceau synthétique structuré (vérité terrain connue) pour tester l'analyse.
'use strict';

function makeTrack({ bpm = 124, offset = 0.37, sr = 44100, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const beat = 60 / bpm, bar = 4 * beat;
  const plan = [
    ['Intro', 8], ['Couplet', 16], ['Montée', 8], ['Drop', 16],
    ['Break', 8], ['Couplet', 16], ['Drop', 16], ['Outro', 8],
  ];
  const totalBars = plan.reduce((a, p) => a + p[1], 0);
  const dur = offset + totalBars * bar + 1.5;
  const n = Math.ceil(dur * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const add = (t, buf) => { const i0 = Math.round(t * sr); for (let i = 0; i < buf.length && i0 + i < n; i++) { L[i0 + i] += buf[i]; R[i0 + i] += buf[i]; } };
  const kick = (() => { const b = new Float32Array(Math.round(0.3 * sr)); let ph = 0; for (let i = 0; i < b.length; i++) { const t = i / sr; ph += 2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) / sr; b[i] = 0.9 * Math.sin(ph) * Math.exp(-t * 9); } return b; })();
  const snare = (() => { const b = new Float32Array(Math.round(0.2 * sr)); for (let i = 0; i < b.length; i++) { const t = i / sr; b[i] = (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 18); } return b; })();
  const hat = (() => { const b = new Float32Array(Math.round(0.05 * sr)); let prev = 0; for (let i = 0; i < b.length; i++) { const t = i / sr; const w = rnd(); b[i] = 0.12 * (w - prev) * Math.exp(-t * 80); prev = w; } return b; })();
  const tone = (freqs, len, amp, decay = 0, saw = false) => {
    const b = new Float32Array(Math.round(len * sr));
    for (let i = 0; i < b.length; i++) {
      const t = i / sr; let v = 0;
      for (const f of freqs) v += saw ? 2 * ((t * f) % 1) - 1 : Math.sin(2 * Math.PI * f * t);
      const env = Math.min(1, t / 0.01) * Math.min(1, (len - t) / 0.02) * (decay ? Math.exp(-t * decay) : 1);
      b[i] = (amp * v * env) / freqs.length;
    }
    return b;
  };
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const chordsA = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const chordsB = [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55]]; // Dm Bb F C

  const truth = [];
  let barIdx = 0;
  for (const [name, len] of plan) {
    truth.push({ name, bar: barIdx, time: offset + barIdx * bar });
    for (let b = 0; b < len; b++, barIdx++) {
      const t0 = offset + barIdx * bar;
      const prog = b / len;
      const ch = (name === 'Drop' ? chordsB : chordsA)[b % 4];
      if (name === 'Intro' || name === 'Break') add(t0, tone(ch.map(midi), bar, 0.18));
      if (name === 'Couplet') { add(t0, tone(ch.map((m) => midi(m - 24)), bar * 0.9, 0.35)); add(t0, tone(ch.map(midi), bar, 0.1)); }
      if (name === 'Drop') { add(t0, tone(ch.map((m) => midi(m - 24)), bar * 0.9, 0.45, 0, true)); }
      for (let k = 0; k < 4; k++) {
        const tb = t0 + k * beat;
        if (['Couplet', 'Drop', 'Outro'].includes(name)) add(tb, kick);
        if (name === 'Drop' && (k === 1 || k === 3)) add(tb, snare);
        if (name === 'Couplet' && (k === 1 || k === 3)) add(tb, snare.map((v) => v * 0.6));
        if (name === 'Drop') add(tb, tone(ch.map((m) => midi(m + 12)), beat * 0.3, 0.2, 12, true));
        if (name !== 'Break') { add(tb + beat / 2, hat); if (name === 'Drop') add(tb, hat); }
        if (name === 'Montée') {
          const sub = prog < 0.5 ? 1 : prog < 0.75 ? 2 : 4;
          for (let q = 0; q < sub; q++) add(tb + (q * beat) / sub, snare.map((v) => v * (0.3 + 0.7 * prog)));
        }
      }
    }
  }
  // normalisation
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(L[i]));
  for (let i = 0; i < n; i++) { L[i] /= m * 1.1; R[i] /= m * 1.1; }
  return { channels: [L, R], sr, bpm, offset, bar, truth, totalBars };
}

function writeWav(path, channels, sr) {
  const fs = require('fs');
  const n = channels[0].length, nc = channels.length;
  const buf = Buffer.alloc(44 + n * nc * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * nc * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), o); o += 2; }
  fs.writeFileSync(path, buf);
}

module.exports = { makeTrack, writeWav };
