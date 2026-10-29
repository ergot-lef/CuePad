/*
 * CuePad — moteur d'analyse musicale (100 % JavaScript, sans dépendance).
 *
 * Entrée : canaux PCM (Float32Array) + fréquence d'échantillonnage.
 * Sortie : BPM, grille des temps, premiers temps des mesures, sections
 *          étiquetées (Intro, Couplet, Refrain, Montée, Drop, Break, Pont, Outro)
 *          et 9 hot cues calés sur les mesures.
 *
 * Utilisable : - dans un Web Worker (new Worker('analysis.js'))
 *              - dans la page (script classique → window.CuePadAnalysis)
 *              - sous Node (require) pour les tests.
 */
(function (root) {
  'use strict';

  const N = 2048;      // taille de fenêtre FFT (≈ 93 ms à 22 kHz)
  const HOP = 256;     // pas d'analyse (≈ 11,6 ms à 22 kHz)

  // ---------------------------------------------------------------- outils
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const tw = TWIDDLE[len];
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const wr = tw[2 * k], wi = tw[2 * k + 1];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  const TWIDDLE = {};
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, t = new Float64Array(len);
    for (let k = 0; k < half; k++) {
      const ang = -2 * Math.PI * k / len;
      t[2 * k] = Math.cos(ang); t[2 * k + 1] = Math.sin(ang);
    }
    TWIDDLE[len] = t;
  }

  const mean = (a, s = 0, e = a.length) => {
    let m = 0; for (let i = s; i < e; i++) m += a[i];
    return e > s ? m / (e - s) : 0;
  };
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  function zscore(a) {
    const m = mean(a);
    let v = 0; for (const x of a) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / Math.max(1, a.length)) || 1;
    return a.map((x) => (x - m) / sd);
  }

  // ------------------------------------------------- mono + décimation
  function toMono(channels, sr) {
    const factor = Math.max(1, Math.round(sr / 22050));
    const len = Math.floor(channels[0].length / factor);
    const x = new Float32Array(len);
    const nc = channels.length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      const b = i * factor;
      for (let c = 0; c < nc; c++) {
        const ch = channels[c];
        for (let k = 0; k < factor; k++) s += ch[b + k];
      }
      x[i] = s / (nc * factor);
    }
    return { x, sr: sr / factor };
  }

  // --------------------------------------------- descripteurs par trame
  function stftFeatures(x, sr, onProgress) {
    const nFrames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
    const half = N / 2;
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const binHz = sr / N;
    const kKick = Math.max(2, Math.round(150 / binHz));
    const kB1 = Math.round(200 / binHz);
    const kB2 = Math.round(2000 / binHz);
    const pcMap = new Int8Array(half).fill(-1);
    for (let k = 1; k < half; k++) {
      const f = k * binHz;
      if (f >= 55 && f <= 5000) {
        const midi = 12 * Math.log2(f / 440) + 69;
        pcMap[k] = ((Math.round(midi) % 12) + 12) % 12;
      }
    }
    const flux = new Float32Array(nFrames);
    const lowFlux = new Float32Array(nFrames);
    const eLow = new Float32Array(nFrames);
    const eMid = new Float32Array(nFrames);
    const eHigh = new Float32Array(nFrames);
    const rms = new Float32Array(nFrames);
    const chroma = new Float32Array(nFrames * 12);
    const re = new Float64Array(N), im = new Float64Array(N);
    let prev = new Float32Array(half), cur = new Float32Array(half);
    const step = Math.max(1, Math.floor(nFrames / 50));

    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      let sq = 0;
      for (let i = 0; i < N; i++) {
        const v = x[off + i] || 0;
        sq += v * v;
        re[i] = v * win[i]; im[i] = 0;
      }
      rms[f] = Math.sqrt(sq / N);
      fft(re, im);
      let fl = 0, lf = 0, el = 0, em = 0, eh = 0;
      const cbase = f * 12;
      for (let k = 1; k < half; k++) {
        const amp = (Math.hypot(re[k], im[k]) * 4) / N;
        const lm = Math.log1p(100 * amp);
        const d = lm - prev[k];
        if (d > 0) { fl += d; if (k < kKick) lf += d; }
        cur[k] = lm;
        const p = amp * amp;
        if (k < kB1) el += p; else if (k < kB2) em += p; else eh += p;
        const pc = pcMap[k];
        if (pc >= 0) chroma[cbase + pc] += amp;
      }
      flux[f] = fl; lowFlux[f] = lf;
      eLow[f] = el; eMid[f] = em; eHigh[f] = eh;
      const t = prev; prev = cur; cur = t;
      if (onProgress && f % step === 0) onProgress(0.05 + 0.6 * (f / nFrames));
    }
    const fps = sr / HOP;
    const t0 = N / 2 / sr; // temps du centre de la trame 0
    return { nFrames, fps, t0, flux, lowFlux, eLow, eMid, eHigh, rms, chroma };
  }

  // ---------------------------------------------- enveloppe d'attaques
  function onsetEnvelope(flux, fps) {
    const n = flux.length;
    const w = Math.max(1, Math.round(fps * 0.4));
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + flux[i];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      const m = (pre[b] - pre[a]) / (b - a);
      out[i] = Math.max(0, flux[i] - m);
    }
    let sd = 0; for (let i = 0; i < n; i++) sd += out[i] * out[i];
    sd = Math.sqrt(sd / Math.max(1, n)) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    return out;
  }

  // ------------------------------------------------------------ tempo
  function estimatePeriod(onset, fps) {
    const n = onset.length;
    const minLag = Math.max(2, Math.floor((fps * 60) / 210));
    const maxLag = Math.ceil((fps * 60) / 55);
    const acf = new Float64Array(2 * maxLag + 2);
    for (let l = 1; l < acf.length; l++) {
      let s = 0;
      for (let i = 0; i + l < n; i++) s += onset[i] * onset[i + l];
      acf[l] = s / Math.max(1, n - l);
    }
    let best = -Infinity, bestLag = Math.round((fps * 60) / 120);
    const score = new Float64Array(maxLag + 2);
    for (let l = minLag; l <= maxLag; l++) {
      const bpm = (60 * fps) / l;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      score[l] = w * (acf[l] + 0.5 * acf[2 * l]);
      if (score[l] > best) { best = score[l]; bestLag = l; }
    }
    // interpolation parabolique pour un retard fractionnaire
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const a = score[bestLag - 1], b = score[bestLag], c = score[bestLag + 1];
      const den = a - 2 * b + c;
      if (den < 0) lag = bestLag + (0.5 * (a - c)) / den;
    }
    return lag;
  }

  // ------------------------------------- suivi des temps (Ellis 2007, DP)
  function trackBeats(onset, period, tightness = 100) {
    const n = onset.length;
    // lissage gaussien (σ = période/32)
    const sig = Math.max(1, period / 32);
    const hw = Math.ceil(sig * 3);
    const g = []; for (let i = -hw; i <= hw; i++) g.push(Math.exp(-0.5 * (i / sig) ** 2));
    const local = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -hw; k <= hw; k++) { const j = i + k; if (j >= 0 && j < n) s += onset[j] * g[k + hw]; }
      local[i] = s;
    }
    const lo = Math.max(1, Math.round(period / 2));
    const hi = Math.round(period * 2);
    const pen = new Float64Array(hi + 1);
    for (let d = lo; d <= hi; d++) pen[d] = -tightness * Math.log(d / period) ** 2;
    const cum = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    for (let t = 0; t < n; t++) {
      let best = -Infinity, bi = -1;
      for (let d = lo; d <= hi; d++) {
        const p = t - d; if (p < 0) break;
        const v = cum[p] + pen[d];
        if (v > best) { best = v; bi = p; }
      }
      if (bi >= 0 && best > 0) { cum[t] = local[t] + best; back[t] = bi; }
      else cum[t] = local[t];
    }
    // dernier temps : maximum local tardif au-dessus de la moitié de la médiane
    const peaks = [];
    for (let t = 1; t < n - 1; t++) if (cum[t] >= cum[t - 1] && cum[t] >= cum[t + 1]) peaks.push(cum[t]);
    const thr = 0.5 * median(peaks);
    let last = n - 1;
    for (let t = n - 2; t > 0; t--) {
      if (cum[t] >= cum[t - 1] && cum[t] >= cum[t + 1] && cum[t] > thr) { last = t; break; }
    }
    const beats = [];
    for (let t = last; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
    beats.reverse();
    return { beats, local };
  }

  // ----------------------------------------------- utilitaires de trames
  function maxAround(arr, center, rad) {
    let m = 0;
    for (let i = Math.max(0, center - rad); i <= Math.min(arr.length - 1, center + rad); i++) if (arr[i] > m) m = arr[i];
    return m;
  }
  function meanChroma(chroma, a, b) {
    const v = new Float64Array(12);
    a = Math.max(0, a); b = Math.max(a + 1, b);
    const nF = chroma.length / 12;
    b = Math.min(b, nF);
    for (let f = a; f < b; f++) for (let k = 0; k < 12; k++) v[k] += chroma[f * 12 + k];
    let nrm = 0; for (let k = 0; k < 12; k++) nrm += v[k] * v[k];
    nrm = Math.sqrt(nrm) || 1;
    for (let k = 0; k < 12; k++) v[k] /= nrm;
    return v;
  }
  const dot12 = (a, b) => { let s = 0; for (let k = 0; k < 12; k++) s += a[k] * b[k]; return s; };
  const dist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2; return Math.sqrt(s); };

  // ======================================================== analyse
  function analyze(channels, sampleRate, onProgress) {
    const prog = onProgress || (() => {});
    prog(0.01);
    const duration = channels[0].length / sampleRate;
    const { x, sr } = toMono(channels, sampleRate);
    const F = stftFeatures(x, sr, prog);
    const { fps, t0, nFrames } = F;
    const frameTime = (f) => t0 + f / fps;
    const timeFrame = (t) => Math.max(0, Math.min(nFrames - 1, Math.round((t - t0) * fps)));

    // début / fin de la musique (hors silence)
    let maxR = 0; for (const r of F.rms) if (r > maxR) maxR = r;
    let fStart = 0, fEnd = nFrames - 1;
    while (fStart < nFrames - 1 && F.rms[fStart] < 0.03 * maxR) fStart++;
    while (fEnd > fStart && F.rms[fEnd] < 0.03 * maxR) fEnd--;
    const musicStart = Math.max(0, frameTime(fStart) - N / 2 / sr);
    const musicEnd = Math.min(duration, frameTime(fEnd) + N / 2 / sr);

    // ---- tempo + temps
    const onset = onsetEnvelope(F.flux, fps);
    prog(0.7);
    const period = estimatePeriod(onset, fps);
    const { beats: dpBeats } = trackBeats(onset, period);
    prog(0.8);

    let beatTimes = dpBeats.map(frameTime).filter((t) => t >= musicStart - 0.05 && t <= musicEnd + 0.05);
    let bpm = (60 * fps) / period;
    let constantTempo = false;
    if (beatTimes.length >= 8) {
      // Ajustement global d'une grille régulière : on cherche (période, phase)
      // qui maximisent l'énergie d'attaque (large bande + basses) sur TOUT le morceau.
      const ib = []; for (let i = 1; i < beatTimes.length; i++) ib.push(beatTimes[i] - beatTimes[i - 1]);
      const T0 = median(ib);
      const lowEnv = onsetEnvelope(F.lowFlux, fps);
      const comb = new Float32Array(nFrames);
      for (let i = 0; i < nFrames; i++) comb[i] = onset[i] + lowEnv[i];
      const at = (t) => { // interpolation linéaire de l'enveloppe au temps t
        const fpos = (t - t0) * fps, i = Math.floor(fpos);
        if (i < 0 || i >= nFrames - 1) return 0;
        const a = fpos - i; return comb[i] * (1 - a) + comb[i + 1] * a;
      };
      const span = musicEnd - musicStart;
      let bestS = -Infinity, bestT = T0, bestPh = 0;
      const tryGrid = (T, ph) => {
        let s = 0;
        for (let t = musicStart + ph; t < musicEnd; t += T) s += at(t);
        return s / Math.max(1, Math.floor(span / T));
      };
      // recherche grossière puis fine
      for (let pass = 0; pass < 2; pass++) {
        const Tc = pass ? bestT : T0, rel = pass ? 0.0015 : 0.02, nT = pass ? 30 : 80;
        for (let a = 0; a <= nT; a++) {
          const T = Tc * (1 - rel + (2 * rel * a) / nT);
          const nP = 64;
          for (let p = 0; p < nP; p++) {
            const ph = (p / nP) * T;
            const s = tryGrid(T, ph);
            if (s > bestS) { bestS = s; bestT = T; bestPh = ph; }
          }
        }
        // affinage de la phase à ±1/64 de période
        const phC = bestPh;
        for (let q = -16; q <= 16; q++) {
          const ph = phC + (q / 16) * (bestT / 64);
          const s = tryGrid(bestT, ph);
          if (s > bestS) { bestS = s; bestPh = ph; }
        }
      }
      // le morceau est-il à tempo constant ? (les temps du suivi tombent sur la grille)
      const onGrid = beatTimes.filter((t) => {
        const k = Math.round((t - musicStart - bestPh) / bestT);
        return Math.abs(t - (musicStart + bestPh + k * bestT)) < 0.045;
      }).length / beatTimes.length;
      if (onGrid > 0.7 && bestT > 0.25 && bestT < 1.2) {
        constantTempo = true;
        bpm = 60 / bestT;
        let first = musicStart + bestPh;
        while (first - bestT >= musicStart - 0.02) first -= bestT;
        beatTimes = [];
        for (let t = first; t < musicEnd + 1e-6; t += bestT) beatTimes.push(t);
      } else {
        bpm = 60 / T0;
      }
    }
    if (beatTimes.length < 4) {
      // secours : grille à 120 BPM
      bpm = 120; beatTimes = [];
      for (let t = musicStart; t < musicEnd; t += 0.5) beatTimes.push(t);
    }
    const beatLen = 60 / bpm;

    // ---- premier temps de la mesure (4/4) : basses + changement d'accord
    const nb = beatTimes.length;
    const beatF = beatTimes.map(timeFrame);
    const bfLen = Math.max(2, Math.round(beatLen * fps));
    const lowS = beatF.map((f) => maxAround(F.lowFlux, f, 2));
    const chS = beatF.map((f) => 1 - dot12(meanChroma(F.chroma, f - bfLen, f), meanChroma(F.chroma, f, f + bfLen)));
    const lowZ = zscore(lowS), chZ = zscore(chS);
    let phase = 0, bestPh = -Infinity;
    for (let p = 0; p < 4; p++) {
      let s = 0, c = 0;
      for (let i = p; i < nb; i += 4) { s += 0.6 * lowZ[i] + 1.0 * chZ[i]; c++; }
      s /= Math.max(1, c);
      if (s > bestPh) { bestPh = s; phase = p; }
    }
    const downbeats = [];
    for (let i = phase; i < nb; i += 4) downbeats.push(beatTimes[i]);
    // la mesure incomplète du début est rattachée comme mesure « 0 » si elle contient de la musique
    if (phase > 0 && downbeats.length && downbeats[0] - 4 * beatLen > musicStart - 2 * beatLen) {
      // on garde la levée hors des mesures : le cue 1 restera au début de la musique
    }
    prog(0.85);

    // ---- descripteurs par mesure
    const bars = [];
    for (let i = 0; i < downbeats.length; i++) {
      const s = downbeats[i];
      const e = i + 1 < downbeats.length ? downbeats[i + 1] : Math.min(musicEnd, s + 4 * beatLen);
      if (e - s > beatLen * 0.5) bars.push({ start: s, end: e });
    }
    const NB = bars.length;
    const featLog = { low: [], mid: [], high: [], rms: [], dens: [] };
    const chromaBars = [];
    for (const b of bars) {
      const fa = timeFrame(b.start), fb = Math.max(fa + 1, timeFrame(b.end));
      featLog.low.push(Math.log(1e-9 + mean(F.eLow, fa, fb)));
      featLog.mid.push(Math.log(1e-9 + mean(F.eMid, fa, fb)));
      featLog.high.push(Math.log(1e-9 + mean(F.eHigh, fa, fb)));
      featLog.rms.push(Math.log(1e-6 + mean(F.rms, fa, fb)));
      featLog.dens.push(mean(onset, fa, fb));
      chromaBars.push(meanChroma(F.chroma, fa, fb));
    }
    const z = {
      low: zscore(featLog.low), mid: zscore(featLog.mid), high: zscore(featLog.high),
      rms: zscore(featLog.rms), dens: zscore(featLog.dens),
    };
    const vec = bars.map((_, i) => {
      const v = Array.from(chromaBars[i]);
      const w = 0.35;
      v.push(w * z.low[i], w * z.mid[i], w * z.high[i], w * z.rms[i], w * z.dens[i]);
      return v;
    });
    // énergie perçue par mesure (0..1)
    const energyRaw = bars.map((_, i) => z.rms[i] + 0.5 * z.low[i] + 0.3 * z.high[i] + 0.3 * z.dens[i]);
    let eMin = Infinity, eMax = -Infinity;
    for (const e of energyRaw) { eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); }
    const barEnergy = energyRaw.map((e) => (eMax - eMin > 1e-9 ? (e - eMin) / (eMax - eMin) : 0.5));

    // ---- nouveauté (noyau en damier de Foote, à l'échelle de la mesure)
    const nov = new Float64Array(NB + 1);
    for (let i = 1; i < NB; i++) {
      const K = Math.min(4, i, NB - i);
      if (K < 1) continue;
      let cross = 0, wp = 0, wf = 0, cc = 0, cp = 0, cf = 0;
      for (let a = i - K; a < i; a++) for (let b = i; b < i + K; b++) { cross += dist(vec[a], vec[b]); cc++; }
      for (let a = i - K; a < i; a++) for (let b = a + 1; b < i; b++) { wp += dist(vec[a], vec[b]); cp++; }
      for (let a = i; a < i + K; a++) for (let b = a + 1; b < i + K; b++) { wf += dist(vec[a], vec[b]); cf++; }
      let v = cross / cc - 0.5 * ((cp ? wp / cp : 0) + (cf ? wf / cf : 0));
      const ej = Math.abs(mean(barEnergy, i, i + K) - mean(barEnergy, i - K, i));
      v = Math.max(0, v) + 0.8 * ej;
      // pénalise les bords où le noyau est tronqué
      nov[i] = v * (K >= 2 ? 1 : 0.5);
    }
    let novMax = 0; for (const v of nov) novMax = Math.max(novMax, v);
    if (novMax > 0) for (let i = 0; i <= NB; i++) nov[i] /= novMax;

    // ---- décalage de phrase (sections de 8 mesures)
    let phr = 0, phrBest = -Infinity;
    for (let o = 0; o < 8; o++) {
      let s = 0;
      for (let i = 1; i < NB; i++) {
        if ((i - o) % 8 === 0) s += nov[i];
        else if ((i - o) % 4 === 0) s += 0.5 * nov[i];
      }
      if (s > phrBest) { phrBest = s; phr = o; }
    }
    const phraseBonus = (i) => (((i - phr) % 8 + 8) % 8 === 0 ? 1.5 : (((i - phr) % 4 + 4) % 4 === 0 ? 1.2 : 1));

    // ---- frontières de sections
    const cands = [];
    for (let i = 1; i < NB; i++) {
      let isPeak = true;
      for (let d = -2; d <= 2; d++) if (d && i + d > 0 && i + d < NB && nov[i + d] > nov[i]) isPeak = false;
      if (isPeak && nov[i] > 0.12) cands.push({ bar: i, score: nov[i] * phraseBonus(i) });
    }
    cands.sort((a, b) => b.score - a.score);
    const maxBounds = Math.max(3, Math.min(16, Math.round(NB / 6)));
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= maxBounds) break;
      if (c.score < 0.22 && chosen.length >= 3) break;
      if (c.bar >= 4 && NB - c.bar >= 2 && chosen.every((o) => Math.abs(o.bar - c.bar) >= 4)) chosen.push(c);
    }
    chosen.sort((a, b) => a.bar - b.bar);
    const bounds = [0, ...chosen.map((c) => c.bar), NB];
    const boundScore = new Map(chosen.map((c) => [c.bar, c.score]));

    // ---- sections + étiquettes
    const sections = [];
    for (let s = 0; s + 1 < bounds.length; s++) {
      const a = bounds[s], b = bounds[s + 1];
      if (b <= a) continue;
      const fv = new Array(vec[0] ? vec[0].length : 0).fill(0);
      for (let i = a; i < b; i++) for (let k = 0; k < fv.length; k++) fv[k] += vec[i][k] / (b - a);
      // pente d'énergie (montée ?)
      let slope = 0;
      if (b - a >= 2) {
        const xs = [], ys = [];
        for (let i = a; i < b; i++) { xs.push(i - a); ys.push(barEnergy[i] + 0.5 * (z.high[i] + z.dens[i]) / 4); }
        const mx = mean(xs), my = mean(ys);
        let sxy = 0, sxx = 0;
        for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
        slope = sxx ? (sxy / sxx) * (b - a) : 0;
      }
      sections.push({
        barStart: a, barEnd: b,
        start: s === 0 ? Math.min(bars[a].start, Math.max(musicStart, bars[a].start)) : bars[a].start,
        end: b < NB ? bars[b].start : musicEnd,
        energyRaw: mean(barEnergy, a, b), slope, fv,
        score: s === 0 ? 1 : boundScore.get(a) || 0,
      });
    }
    // énergie relative des sections
    let sMin = Infinity, sMax = -Infinity;
    for (const s of sections) { sMin = Math.min(sMin, s.energyRaw); sMax = Math.max(sMax, s.energyRaw); }
    for (const s of sections) s.energy = sMax - sMin > 0.05 ? (s.energyRaw - sMin) / (sMax - sMin) : 0.5;
    // regroupement par similarité → lettres A, B, C…
    const pair = [];
    for (let i = 0; i < sections.length; i++) for (let j = i + 1; j < sections.length; j++) pair.push(dist(sections[i].fv, sections[j].fv));
    const thr = pair.length ? 0.5 * median(pair) : 1;
    const reps = [];
    for (const s of sections) {
      let best = -1, bd = Infinity;
      reps.forEach((r, k) => { const d = dist(r, s.fv); if (d < bd) { bd = d; best = k; } });
      if (best >= 0 && bd < thr) s.cluster = best;
      else { s.cluster = reps.length; reps.push(s.fv); }
      s.letter = String.fromCharCode(65 + (s.cluster % 26));
    }
    const clusterCount = {};
    for (const s of sections) clusterCount[s.cluster] = (clusterCount[s.cluster] || 0) + 1;
    const nS = sections.length;
    // le groupe le plus énergique = refrain / drop ; les autres groupes forts = couplets
    const clE = {};
    for (const s of sections) (clE[s.cluster] = clE[s.cluster] || []).push(s.energy);
    let topCl = -1, topE = -Infinity;
    for (const k in clE) { const m = mean(clE[k]); if (m > topE) { topE = m; topCl = +k; } }
    sections.forEach((s, i) => {
      const prev = sections[i - 1], next = sections[i + 1];
      const isPeak = s.energy >= 0.6 && s.cluster === topCl;
      let label;
      if (i === 0 && s.energy < 0.55) label = 'Intro';
      else if (i === nS - 1 && nS > 1 && s.energy < 0.55) label = 'Outro';
      else if (isPeak) label = prev && (prev.energy < 0.5 || prev.label === 'Montée') ? 'Drop' : 'Refrain';
      else if (s.energy >= 0.7) label = 'Couplet';
      else if (next && next.energy >= 0.7 && s.slope > 0.3 && s.energy < next.energy - 0.15) label = 'Montée';
      else if (s.energy <= 0.3) label = 'Break';
      else if (clusterCount[s.cluster] === 1 && i > nS / 2) label = 'Pont';
      else label = 'Couplet';
      s.label = label;
    });
    prog(0.92);

    // ---- 9 hot cues
    const NCUES = 9;
    let cuePts = sections.map((s, i) => ({
      bar: s.barStart, time: i === 0 ? Math.max(0, Math.min(s.start, musicStart)) : s.start,
      section: i, label: s.label, letter: s.letter, energy: s.energy, score: s.score, part: 1,
    }));
    if (cuePts.length > NCUES) {
      const first = cuePts[0];
      const rest = cuePts.slice(1).sort((a, b) => b.score - a.score).slice(0, NCUES - 1);
      cuePts = [first, ...rest].sort((a, b) => a.bar - b.bar);
    }
    // si moins de 9 : on découpe les segments les plus longs sur des phrases
    let guard = 0;
    while (cuePts.length < NCUES && guard++ < 50 && NB > 0) {
      let bestK = -1, bestLen = 0;
      for (let k = 0; k < cuePts.length; k++) {
        const a = cuePts[k].bar, b = k + 1 < cuePts.length ? cuePts[k + 1].bar : NB;
        if (b - a > bestLen) { bestLen = b - a; bestK = k; }
      }
      if (bestK < 0 || bestLen < 4) break;
      const a = cuePts[bestK].bar, b = bestK + 1 < cuePts.length ? cuePts[bestK + 1].bar : NB;
      const step = bestLen >= 16 ? 8 : bestLen >= 8 ? 4 : 2;
      let split = -1, sBest = -Infinity;
      for (let i = a + step; i <= b - step; i += step) {
        const sc = nov[i] - Math.abs(i - (a + b) / 2) / bestLen;
        if (sc > sBest) { sBest = sc; split = i; }
      }
      if (split < 0) split = a + Math.max(1, Math.floor(bestLen / 2));
      const parent = cuePts[bestK];
      const sib = cuePts.filter((c) => c.section === parent.section).length + 1;
      cuePts.splice(bestK + 1, 0, {
        bar: split, time: bars[split].start, section: parent.section, label: parent.label,
        letter: parent.letter, energy: barEnergy[split], score: nov[split], part: sib,
      });
      cuePts.sort((x, y) => x.bar - y.bar);
    }
    // numérotation « Couplet 2 », « Refrain 3 »…
    const seen = {};
    const cues = cuePts.map((c, i) => {
      seen[c.label] = (seen[c.label] || 0) + 1;
      return {
        key: i + 1, time: c.time, bar: c.bar, label: c.label,
        name: seen[c.label] > 1 ? `${c.label} ${seen[c.label]}` : c.label,
        letter: c.letter, energy: c.energy, section: c.section,
      };
    });
    prog(1);

    return {
      duration, musicStart, musicEnd,
      bpm: Math.round(bpm * 100) / 100, constantTempo, beatLen,
      beats: beatTimes, downbeats: bars.map((b) => b.start),
      barEnergy, novelty: Array.from(nov),
      sections: sections.map((s) => ({
        start: s.start, end: s.end, barStart: s.barStart, barEnd: s.barEnd,
        label: s.label, letter: s.letter, energy: s.energy,
      })),
      cues,
    };
  }

  const api = { analyze, _internals: { fft, toMono, stftFeatures, onsetEnvelope, estimatePeriod, trackBeats } };

  // --- exposition selon l'environnement
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CuePadAnalysis = api;
  else if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof module === 'undefined') {
    self.onmessage = (ev) => {
      const { channels, sampleRate } = ev.data;
      try {
        const res = analyze(channels, sampleRate, (p) => self.postMessage({ type: 'progress', p }));
        self.postMessage({ type: 'result', result: res });
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.stack || err) });
      }
    };
  }
  if (root) root.CuePadAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
