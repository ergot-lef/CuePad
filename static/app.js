/* CuePad — interface, moteur audio, clavier et MIDI. */
(() => {
  'use strict';

  // ================================================================ DOM
  const $ = (id) => document.getElementById(id);
  const ui = {
    file: $('fileInput'), ytForm: $('ytForm'), ytUrl: $('ytUrl'), ytBtn: $('ytBtn'),
    bpm: $('lcdBpm'), time: $('lcdTime'), bar: $('lcdBar'), q: $('lcdQ'), layer: $('lcdLayer'), status: $('lcdStatus'),
    overview: $('overview'), zoom: $('zoom'), drop: $('dropZone'),
    pads: $('pads'), stems: $('stems'), stemState: $('stemState'), stemProgress: $('stemProgress'),
    btnPlay: $('btnPlay'), btnQ: $('btnQ'), btnRestore: $('btnRestore'), btnLatch: $('btnLatch'),
    btnMidi: $('btnMidi'), btnLearn: $('btnLearn'), midiState: $('midiState'), midiHint: $('midiHint'),
  };
  const status = (msg) => { ui.status.textContent = msg; ui.status.title = msg; };

  const LABEL_COLOR = {
    Intro: '--c-intro', Couplet: '--c-couplet', 'Montée': '--c-montee', Drop: '--c-drop',
    Refrain: '--c-refrain', Break: '--c-break', Pont: '--c-pont', Outro: '--c-outro',
  };
  const css = getComputedStyle(document.documentElement);
  const colorOf = (label) => css.getPropertyValue(LABEL_COLOR[label] || '--c-couplet').trim() || '#3fb8af';
  const fmtTime = (t) => {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  };
  const STEMS = ['vocals', 'drums', 'bass', 'other'];

  // ======================================================= moteur audio
  class Engine {
    constructor(ctx) {
      this.ctx = ctx;
      this.bus = ctx.createGain();
      this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 1.2;
      this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 1.2;
      this.master = ctx.createGain(); this.master.gain.value = 0.9;
      this.bus.connect(this.lp).connect(this.hp).connect(this.master).connect(ctx.destination);
      // écho synchronisé
      this.send = ctx.createGain(); this.send.gain.value = 0;
      this.delay = ctx.createDelay(4);
      this.fb = ctx.createGain(); this.fb.gain.value = 0.48;
      this.echoTone = ctx.createBiquadFilter(); this.echoTone.type = 'highpass'; this.echoTone.frequency.value = 250;
      this.hp.connect(this.send).connect(this.delay);
      this.delay.connect(this.echoTone).connect(this.fb).connect(this.delay);
      this.echoTone.connect(this.master);
      // pistes : 'mix' ou les 4 stems
      this.lanes = {};
      for (const k of ['mix', ...STEMS]) { const g = ctx.createGain(); g.connect(this.bus); this.lanes[k] = g; }
      this.buffers = {};
      this.voices = [];
      this.anchor = { ctx: 0, pos: 0, loop: null };
      this.pending = [];
      this.playing = false;
      this.pausedPos = 0;
      this.duration = 0;
    }

    setBuffers(map) {
      const wasPlaying = this.playing;
      const pos = this.position();
      const loop = this.currentLoop();
      this.buffers = map;
      this.duration = Math.max(0, ...Object.values(map).map((b) => b.duration));
      if (wasPlaying) this._launch(this.ctx.currentTime + 0.02, pos, loop);
    }

    position() {
      if (!this.playing) return this.pausedPos;
      const now = this.ctx.currentTime;
      while (this.pending.length && this.pending[0].ctx <= now) this.anchor = this.pending.shift();
      const a = this.anchor;
      let p = a.pos + Math.max(0, now - a.ctx);
      if (a.loop && p >= a.loop.end) {
        const len = a.loop.end - a.loop.start;
        p = a.loop.start + ((p - a.loop.start) % len);
      }
      return p;
    }

    currentLoop() {
      if (!this.playing) return null;
      this.position();
      return this.anchor.loop;
    }

    _stopVoices(when) {
      const fade = 0.006;
      for (const v of this.voices) {
        try {
          v.gain.gain.cancelScheduledValues(when);
          v.gain.gain.setValueAtTime(v.gain.gain.value, when);
          v.gain.gain.linearRampToValueAtTime(0, when + fade);
          v.src.stop(when + fade + 0.005);
        } catch (_) { /* déjà arrêtée */ }
      }
      this.voices = [];
    }

    _launch(when, pos, loop) {
      const ctx = this.ctx, fade = 0.006;
      when = Math.max(when, ctx.currentTime);
      this._stopVoices(when);
      for (const [lane, buf] of Object.entries(this.buffers)) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(1, when + fade);
        src.connect(g).connect(this.lanes[lane]);
        if (loop) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end; }
        src.start(when, Math.max(0, Math.min(pos, buf.duration - 0.01)));
        this.voices.push({ src, gain: g, lane });
      }
      const a = { ctx: when, pos, loop };
      if (when <= ctx.currentTime + 0.001) { this.anchor = a; this.pending = []; }
      else { this.pending = this.pending.filter((p) => p.ctx < when); this.pending.push(a); }
      this.playing = true;
    }

    play(pos = this.pausedPos) {
      if (!Object.keys(this.buffers).length) return;
      if (pos >= this.duration - 0.05) pos = 0;
      this._launch(this.ctx.currentTime + 0.01, pos, null);
    }

    pause() {
      this.pausedPos = this.position();
      this._stopVoices(this.ctx.currentTime);
      this.pending = [];
      this.playing = false;
    }

    /** Saute à `target` à l'instant (temps contexte) `when`. */
    jumpAt(when, target) {
      if (!this.playing) { this.play(target); return; }
      this._launch(when, target, null);
    }

    setLoop(start, end) {
      if (!this.playing) return;
      const p = this.position();
      for (const v of this.voices) { v.src.loopStart = start; v.src.loopEnd = end; v.src.loop = true; }
      this.pending = [];
      this.anchor = { ctx: this.ctx.currentTime, pos: Math.min(Math.max(p, start), end - 1e-3), loop: { start, end } };
    }

    clearLoop() {
      if (!this.playing) return;
      const p = this.position();
      for (const v of this.voices) v.src.loop = false;
      this.anchor = { ctx: this.ctx.currentTime, pos: p, loop: null };
    }

    setLane(lane, on) {
      const g = this.lanes[lane].gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(on ? 1 : 0, t + 0.02);
    }

    // ---- effets
    ramp(param, value, secs, exp = true) {
      const t = this.ctx.currentTime;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      if (exp) param.exponentialRampToValueAtTime(Math.max(1e-3, value), t + secs);
      else param.linearRampToValueAtTime(value, t + secs);
    }
  }

  // ================================================================ état
  const S = {
    ctx: null, engine: null,
    track: null,           // { name, key, mix, stems, analysis, peaks, peaksRate, sourceId, file }
    cues: [],              // [{key,time,name,label,...}] (peut être édité)
    quant: 'beat',         // 'beat' | 'bar' | 'off'
    shift: false, latch: false, ctrl: false,
    stemsOn: { vocals: true, drums: true, bass: true, other: true },
    stemSnapshot: null, stemMode: null,
    loopBeats: 0,
    roll: null,
    fxHeld: new Set(),
    server: { ok: false, stems: false, youtube: false },
    midi: { access: null, learn: false, target: null, map: {} },
    loadToken: 0,
  };

  function ensureAudio() {
    if (!S.ctx) {
      S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      S.engine = new Engine(S.ctx);
    }
    if (S.ctx.state === 'suspended') S.ctx.resume();
    return S.ctx;
  }

  // ===================================================== serveur local
  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch (_) { /* pas de JSON */ }
    if (!res.ok) throw new Error((body && (body.detail || body.error)) || `Erreur ${res.status}`);
    return body;
  }
  async function detectServer() {
    if (location.protocol === 'file:') return;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 2500);
      const h = await api('/api/health', { signal: ctl.signal });
      clearTimeout(to);
      S.server = { ok: true, stems: !!h.stems, youtube: !!h.youtube };
    } catch (_) { /* mode fichier seul */ }
    ui.stemState.textContent = !S.server.ok ? 'serveur non détecté'
      : S.server.stems ? 'prêt, en attente d\'un morceau' : 'Demucs non installé';
    if (!S.server.youtube) { ui.ytUrl.disabled = true; ui.ytBtn.disabled = true; ui.ytUrl.placeholder = S.server.ok ? 'yt-dlp non installé sur le serveur' : 'liens YouTube : lance le serveur'; }
  }
  async function waitJob(id, onProgress) {
    for (;;) {
      const j = await api(`/api/jobs/${id}`);
      if (onProgress) onProgress(j);
      if (j.status === 'done') return j.result;
      if (j.status === 'error') throw new Error(j.error || 'Échec du traitement');
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  // ==================================================== chargement
  async function decode(arrayBuffer) {
    ensureAudio();
    return await S.ctx.decodeAudioData(arrayBuffer);
  }

  async function loadFromFile(file) {
    if (!file) return;
    ensureAudio();
    status(`Lecture de « ${file.name} »…`);
    try {
      const buf = await decode(await file.arrayBuffer());
      await loadTrack(file.name.replace(/\.[^.]+$/, ''), buf, { file });
    } catch (e) {
      status(`Impossible de lire ce fichier (${e.message || e}). Formats : MP3, FLAC, WAV, OGG, M4A.`);
    }
  }

  async function loadFromYouTube(url) {
    if (!S.server.youtube) { status('Les liens YouTube passent par le serveur local : lance « python server.py ».'); return; }
    ensureAudio();
    status('Téléchargement de l\'audio YouTube…');
    try {
      const { job } = await api('/api/youtube', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const res = await waitJob(job, (j) => j.progress != null && status(`Téléchargement YouTube… ${Math.round(j.progress * 100)} %`));
      const ab = await (await fetch(res.file_url)).arrayBuffer();
      const buf = await decode(ab);
      await loadTrack(res.title || 'YouTube', buf, { sourceId: res.source_id });
    } catch (e) {
      status(`YouTube : ${e.message || e}`);
    }
  }

  async function loadTrack(name, audioBuffer, origin) {
    const token = ++S.loadToken;
    const eng = S.engine;
    if (eng.playing) eng.pause();
    eng.pausedPos = 0;
    // réinitialisation
    S.stemsOn = { vocals: true, drums: true, bass: true, other: true };
    S.stemSnapshot = null; S.stemMode = null; S.loopBeats = 0; S.roll = null;
    for (const k of Object.keys(eng.lanes)) eng.setLane(k, true);
    eng.setBuffers({ mix: audioBuffer });
    S.track = {
      name, key: `${name}|${audioBuffer.duration.toFixed(2)}`, mix: audioBuffer, stems: null,
      analysis: null, ...computePeaks(audioBuffer), sourceId: origin.sourceId || null, file: origin.file || null,
    };
    S.cues = [];
    renderPads(); updateStemsUI(); drawOverviewBase();
    status(`Analyse de « ${name} »…`);
    ui.bpm.textContent = '...';

    const analysis = await runAnalysis(audioBuffer, (p) => {
      if (token === S.loadToken) status(`Analyse de « ${name} »… ${Math.round(p * 100)} %`);
    });
    if (token !== S.loadToken) return;
    S.track.analysis = analysis;
    S.cues = loadSavedCues(S.track.key) || analysis.cues.map((c) => ({ ...c }));
    ui.bpm.textContent = analysis.bpm.toFixed(1);
    renderPads(); drawOverviewBase();
    const secs = analysis.sections.map((s) => s.label).join(', ');
    status(`« ${name} » prêt. ${analysis.bpm.toFixed(1)} BPM, sections : ${secs}. Appuie sur 1 à 9.`);
    requestStems(token).catch((e) => {
      if (token === S.loadToken) { ui.stemState.textContent = `échec : ${e.message || e}`; ui.stemProgress.style.width = '0'; }
    });
  }

  function runAnalysis(buf, onProgress) {
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
    const sr = buf.sampleRate;
    return new Promise((resolve, reject) => {
      let worker = null;
      try { worker = new Worker('analysis.js'); } catch (_) { worker = null; }
      const fallback = () => {
        // ex. page ouverte en file:// : calcul dans la page
        setTimeout(() => {
          try { resolve(window.CuePadAnalysis.analyze(channels, sr, onProgress)); } catch (e) { reject(e); }
        }, 30);
      };
      if (!worker) return fallback();
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress(m.p);
        else if (m.type === 'result') { worker.terminate(); resolve(m.result); }
        else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (ev) => { ev.preventDefault(); worker.terminate(); fallback(); };
      worker.postMessage({ channels, sampleRate: sr }, channels.map((c) => c.buffer));
    });
  }

  // ---- stems via le serveur
  async function requestStems(token) {
    if (!S.server.stems) { updateStemsUI(); return; }
    const t = S.track;
    let sourceId = t.sourceId;
    if (!sourceId && t.file) {
      ui.stemState.textContent = 'envoi au serveur…';
      const fd = new FormData(); fd.append('file', t.file, t.file.name);
      sourceId = (await api('/api/upload', { method: 'POST', body: fd })).source_id;
      t.sourceId = sourceId;
    }
    if (!sourceId || token !== S.loadToken) return;
    ui.stemState.textContent = 'séparation en cours…';
    const { job } = await api('/api/stems', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: sourceId }),
    });
    const res = await waitJob(job, (j) => {
      if (token !== S.loadToken) return;
      const p = j.progress || 0;
      ui.stemProgress.style.width = `${Math.round(p * 100)}%`;
      ui.stemState.textContent = j.status === 'queued' ? 'en file d\'attente…' : `séparation ${Math.round(p * 100)} %`;
    });
    if (token !== S.loadToken) return;
    ui.stemState.textContent = 'chargement des stems…';
    const bufs = {};
    await Promise.all(STEMS.map(async (k) => { bufs[k] = await decode(await (await fetch(res.stems[k])).arrayBuffer()); }));
    if (token !== S.loadToken) return;
    t.stems = bufs;
    S.engine.setBuffers(bufs);
    ui.stemProgress.style.width = '100%';
    updateStemsUI();
    status(`Stems prêts : Maj + 4 5 6 1 coupe voix, batterie, basse, instruments.`);
  }

  // ==================================================== cues & grille
  const saveKey = (k) => `cuepad:cues:${k}`;
  function loadSavedCues(key) {
    try { const raw = localStorage.getItem(saveKey(key)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function saveCues() {
    try { localStorage.setItem(saveKey(S.track.key), JSON.stringify(S.cues)); } catch (_) { /* stockage indisponible */ }
  }
  function restoreAutoCues() {
    if (!S.track || !S.track.analysis) return;
    S.cues = S.track.analysis.cues.map((c) => ({ ...c }));
    try { localStorage.removeItem(saveKey(S.track.key)); } catch (_) { /* rien */ }
    renderPads(); drawOverviewBase();
    status('Cues automatiques rétablis.');
  }

  const grid = () => (S.track && S.track.analysis) || null;
  function bsearch(arr, x) { // dernier indice i tel que arr[i] <= x
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  function nextGridTime(p, mode) {
    const a = grid();
    if (!a || mode === 'off') return p;
    const arr = mode === 'bar' ? a.downbeats : a.beats;
    const i = bsearch(arr, p + 0.025);
    if (i + 1 < arr.length) return arr[i + 1];
    return p;
  }
  function floorBeat(p) {
    const a = grid();
    if (!a || !a.beats.length) return p;
    const i = bsearch(a.beats, p + 1e-3);
    return i >= 0 ? a.beats[i] : a.beats[0];
  }
  function nearestBeat(p) {
    const a = grid();
    if (!a || !a.beats.length) return p;
    const i = Math.max(0, bsearch(a.beats, p));
    const c = [a.beats[i], a.beats[i + 1]].filter((x) => x != null);
    return c.reduce((b, x) => (Math.abs(x - p) < Math.abs(b - p) ? x : b), c[0]);
  }
  const beatLen = () => (grid() ? grid().beatLen : 0.5);

  /** Délai (secondes contexte) avant le prochain point de grille, en tenant compte d'une boucle. */
  function quantizedWhen() {
    const eng = S.engine, now = S.ctx.currentTime;
    if (!eng.playing) return now;
    const p = eng.position();
    let g = nextGridTime(p, S.quant);
    const loop = eng.currentLoop();
    if (loop && g > loop.end) g = loop.end;
    return now + Math.max(0, g - p);
  }

  // ===================================================== actions
  function hasTrack() { return S.track && S.engine && Object.keys(S.engine.buffers).length; }

  function triggerCue(n) {
    if (!hasTrack()) return;
    const cue = S.cues.find((c) => c.key === n);
    if (S.ctrl) { // placer le cue
      const t = nearestBeat(S.engine.position());
      const name = cue ? cue.name : `Cue ${n}`;
      const nc = { key: n, time: t, name: name.endsWith('*') ? name : `${name}*`, label: cue ? cue.label : 'Couplet', letter: cue ? cue.letter : 'A' };
      S.cues = S.cues.filter((c) => c.key !== n).concat(nc).sort((a, b) => a.key - b.key);
      saveCues(); renderPads(); drawOverviewBase();
      status(`Cue ${n} placé à ${fmtTime(t)}.`);
      return;
    }
    if (!cue) return;
    ensureAudio();
    S.loopBeats = 0; S.roll = null;
    if (!S.engine.playing) S.engine.play(cue.time);
    else S.engine.jumpAt(quantizedWhen(), cue.time);
    flashPad(n);
    renderPadStates();
  }

  function toggleLoop(beats) {
    const eng = S.engine;
    if (!hasTrack() || !eng.playing) return;
    if (S.roll) return;
    if (S.loopBeats === beats) { eng.clearLoop(); S.loopBeats = 0; status('Boucle relâchée.'); }
    else {
      const p = eng.position();
      const cur = eng.currentLoop();
      const start = cur ? cur.start : floorBeat(p);
      const end = start + beats * beatLen();
      eng.setLoop(start, end);
      S.loopBeats = beats;
      status(`Boucle de ${beats} temps.`);
    }
    renderPadStates();
  }

  function setStem(stem, on) {
    S.stemsOn[stem] = on;
    S.engine.setLane(stem, on);
  }
  function toggleStem(stem) {
    if (!S.track || !S.track.stems) return;
    S.stemMode = null;
    setStem(stem, !S.stemsOn[stem]);
    updateStemsUI(); renderPadStates();
  }
  function stemPreset(mode, keep) {
    if (!S.track || !S.track.stems) return;
    if (S.stemMode === mode) { // relâche le préréglage
      const snap = S.stemSnapshot || { vocals: true, drums: true, bass: true, other: true };
      for (const k of STEMS) setStem(k, snap[k]);
      S.stemMode = null;
    } else {
      if (!S.stemMode) S.stemSnapshot = { ...S.stemsOn };
      for (const k of STEMS) setStem(k, keep.includes(k));
      S.stemMode = mode;
    }
    updateStemsUI(); renderPadStates();
  }
  function resetAll() {
    if (!S.engine) return;
    for (const k of STEMS) setStem(k, true);
    S.stemMode = null;
    if (S.loopBeats) { S.engine.clearLoop(); S.loopBeats = 0; }
    for (const fx of [...S.fxHeld]) release(fx);
    updateStemsUI(); renderPadStates();
    status('Tout est rétabli.');
  }

  const LAYER2 = {
    7: { name: 'Boucle 1', sub: '1 temps', run: () => toggleLoop(1), kind: 'loop', beats: 1 },
    8: { name: 'Boucle 2', sub: '2 temps', run: () => toggleLoop(2), kind: 'loop', beats: 2 },
    9: { name: 'Boucle 4', sub: '1 mesure', run: () => toggleLoop(4), kind: 'loop', beats: 4 },
    4: { name: 'Voix', sub: 'couper / remettre', run: () => toggleStem('vocals'), kind: 'stem', stem: 'vocals' },
    5: { name: 'Batterie', sub: 'couper / remettre', run: () => toggleStem('drums'), kind: 'stem', stem: 'drums' },
    6: { name: 'Basse', sub: 'couper / remettre', run: () => toggleStem('bass'), kind: 'stem', stem: 'bass' },
    1: { name: 'Instruments', sub: 'couper / remettre', run: () => toggleStem('other'), kind: 'stem', stem: 'other' },
    2: { name: 'Acapella', sub: 'voix seule', run: () => stemPreset('acapella', ['vocals']), kind: 'preset', mode: 'acapella' },
    3: { name: 'Rythmique', sub: 'batterie + basse', run: () => stemPreset('rythmique', ['drums', 'bass']), kind: 'preset', mode: 'rythmique' },
  };

  function fxPress(fx) {
    const eng = S.engine;
    if (!eng) return;
    S.fxHeld.add(fx);
    if (fx === 'fx:lp') eng.ramp(eng.lp.frequency, 220, 2.2);
    if (fx === 'fx:hp') eng.ramp(eng.hp.frequency, 1600, 2.2);
    if (fx === 'fx:echo') {
      eng.delay.delayTime.setValueAtTime(beatLen() * 0.75, S.ctx.currentTime);
      eng.ramp(eng.send.gain, 0.75, 0.05, false);
    }
    if (fx === 'fx:roll' && eng.playing && !S.loopBeats && !S.roll) {
      const p = eng.position();
      const half = beatLen() / 2;
      const start = floorBeat(p) + Math.floor((p - floorBeat(p)) / half) * half;
      S.roll = { ctx: S.ctx.currentTime, pos: p };
      eng.setLoop(start, start + half);
    }
    renderFx();
  }
  function fxRelease(fx) {
    const eng = S.engine;
    if (!eng) return;
    S.fxHeld.delete(fx);
    if (fx === 'fx:lp') eng.ramp(eng.lp.frequency, 20000, 0.25);
    if (fx === 'fx:hp') eng.ramp(eng.hp.frequency, 10, 0.25);
    if (fx === 'fx:echo') eng.ramp(eng.send.gain, 0, 0.05, false);
    if (fx === 'fx:roll' && S.roll) {
      // « slip » : on reprend là où le morceau serait arrivé
      const target = S.roll.pos + (S.ctx.currentTime - S.roll.ctx);
      S.roll = null;
      eng.clearLoop();
      eng.jumpAt(S.ctx.currentTime, target);
    }
    renderFx();
  }
  function filterKnob(v) { // 0..1 : gauche passe-bas, droite passe-haut, centre neutre
    const eng = S.engine; if (!eng) return;
    const t = S.ctx.currentTime;
    if (v < 0.47) {
      const f = 200 * Math.pow(100, v / 0.47);
      eng.lp.frequency.setTargetAtTime(f, t, 0.02); eng.hp.frequency.setTargetAtTime(10, t, 0.02);
    } else if (v > 0.53) {
      const f = 10 * Math.pow(200, (v - 0.53) / 0.47);
      eng.hp.frequency.setTargetAtTime(f, t, 0.02); eng.lp.frequency.setTargetAtTime(20000, t, 0.02);
    } else {
      eng.lp.frequency.setTargetAtTime(20000, t, 0.02); eng.hp.frequency.setTargetAtTime(10, t, 0.02);
    }
  }

  function togglePlay() {
    if (!hasTrack()) return;
    ensureAudio();
    if (S.engine.playing) { S.engine.pause(); S.loopBeats = 0; S.roll = null; }
    else S.engine.play();
    renderPadStates();
  }
  function backToStart() {
    if (!hasTrack()) return;
    S.engine.pause(); S.loopBeats = 0;
    S.engine.pausedPos = S.cues.length ? S.cues[0].time : 0;
    renderPadStates();
  }
  function cycleQuant() {
    S.quant = { beat: 'bar', bar: 'off', off: 'beat' }[S.quant];
    ui.q.textContent = { beat: 'temps', bar: 'mesure', off: 'aucune' }[S.quant];
    status(`Quantification : ${ui.q.textContent}.`);
  }
  function toggleLatch() {
    S.latch = !S.latch;
    updateLayer();
  }

  /** Point d'entrée unique pour clavier, souris et MIDI. */
  function press(action) {
    if (S.midi.learn && !S.midi.target && action) { setLearnTarget(action); return; }
    const [kind, arg] = action.split(':');
    const n = +arg;
    if (kind === 'cue') triggerCue(n);
    else if (kind === 'l2') { if (LAYER2[n]) { LAYER2[n].run(); flashPad(n); } }
    else if (kind === 'fx') fxPress(action);
    else if (action === 'play') togglePlay();
    else if (action === 'start') backToStart();
    else if (action === 'quant') cycleQuant();
    else if (action === 'restore') restoreAutoCues();
    else if (action === 'latch') toggleLatch();
    else if (action === 'reset') resetAll();
  }
  function release(action) {
    if (action.startsWith('fx:')) fxRelease(action);
  }

  // =================================================== clavier
  const layer2 = () => S.shift || S.latch;
  function keyAction(e) {
    const c = e.code;
    let m = /^Numpad([1-9])$/.exec(c) || /^Digit([1-9])$/.exec(c);
    if (m) return `${layer2() ? 'l2' : 'cue'}:${m[1]}`;
    switch (c) {
      case 'ArrowLeft': return 'fx:lp';
      case 'ArrowRight': return 'fx:hp';
      case 'ArrowUp': return 'fx:echo';
      case 'ArrowDown': return 'fx:roll';
      case 'Numpad0': case 'Digit0': return layer2() ? 'reset' : 'play';
      case 'NumpadEnter': case 'Space': return 'play';
      case 'NumpadDecimal': return 'start';
      case 'NumpadDivide': return 'quant';
      case 'NumpadMultiply': return 'restore';
      case 'NumpadAdd': return 'latch';
      default: return null;
    }
  }
  const held = new Map(); // code → action (pour relâcher la bonne action)
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Shift') { S.shift = true; updateLayer(); return; }
    if (e.key === 'Control') { S.ctrl = true; return; }
    if (e.shiftKey !== S.shift) { S.shift = e.shiftKey; updateLayer(); }
    S.ctrl = e.ctrlKey || e.metaKey;
    const action = keyAction(e);
    if (!action) return;
    e.preventDefault();
    if (e.repeat) return;
    held.set(e.code, action);
    press(action);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') { S.shift = false; updateLayer(); }
    if (e.key === 'Control' || e.key === 'Meta') S.ctrl = false;
    const action = held.get(e.code);
    if (action) { held.delete(e.code); release(action); }
  });
  window.addEventListener('blur', () => {
    S.shift = false; S.ctrl = false; updateLayer();
    for (const a of held.values()) release(a);
    held.clear();
  });

  // =================================================== pads (DOM)
  const PAD_ORDER = [7, 8, 9, 4, 5, 6, 1, 2, 3]; // disposition du pavé numérique
  const padEls = {};
  function buildPads() {
    for (const n of PAD_ORDER) {
      const b = document.createElement('button');
      b.className = 'pad';
      b.dataset.n = n;
      b.innerHTML = '<span class="num"></span><span><span class="lbl"></span><br><span class="sub"></span></span>';
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        S.ctrl = e.ctrlKey || e.metaKey;
        const act = `${layer2() || e.shiftKey ? 'l2' : 'cue'}:${n}`;
        b.dataset.held = act;
        press(act);
      });
      const up = () => { if (b.dataset.held) { release(b.dataset.held); delete b.dataset.held; } };
      b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
      b.addEventListener('click', (e) => { if (e.detail === 0) press(`${layer2() ? 'l2' : 'cue'}:${n}`); });
      ui.pads.appendChild(b);
      padEls[n] = b;
    }
  }
  function renderPads() {
    const l2 = layer2();
    ui.pads.dataset.layer = l2 ? '2' : '1';
    for (const n of PAD_ORDER) {
      const b = padEls[n];
      const [num, lbl, sub] = [b.querySelector('.num'), b.querySelector('.lbl'), b.querySelector('.sub')];
      num.textContent = n;
      b.classList.remove('empty');
      b.disabled = false;
      if (l2) {
        const d = LAYER2[n];
        lbl.textContent = d.name; sub.textContent = d.sub;
        const stemsReady = !!(S.track && S.track.stems);
        b.style.setProperty('--led', `var(${d.kind === 'loop' ? '--c-loop' : '--c-stem'})`);
        if (d.kind !== 'loop' && !stemsReady) { b.classList.add('empty'); sub.textContent = 'stems indisponibles'; }
      } else {
        const c = S.cues.find((x) => x.key === n);
        if (c) {
          lbl.textContent = c.name; sub.textContent = fmtTime(c.time);
          b.style.setProperty('--led', colorOf(c.label));
        } else {
          lbl.textContent = S.track ? (S.track.analysis ? '' : 'analyse…') : ''; sub.textContent = '';
          b.classList.add('empty');
          b.style.setProperty('--led', '#6b6f73');
        }
      }
      b.setAttribute('aria-label', `Pad ${n} : ${lbl.textContent}`);
    }
    renderPadStates();
  }
  function currentCueKey() {
    if (!S.engine || !S.cues.length) return 0;
    const p = S.engine.position();
    let k = 0;
    for (const c of S.cues) if (c.time <= p + 0.02) k = c.key;
    return k;
  }
  let lastLive = -1;
  function renderPadStates() {
    const l2 = layer2();
    const live = l2 ? 0 : currentCueKey();
    for (const n of PAD_ORDER) {
      const b = padEls[n];
      b.classList.toggle('live', !l2 && n === live && !!(S.engine && S.engine.playing));
      let on = false;
      if (l2) {
        const d = LAYER2[n];
        if (d.kind === 'loop') on = S.loopBeats === d.beats;
        else if (d.kind === 'stem') on = !!(S.track && S.track.stems) && S.stemsOn[d.stem];
        else on = S.stemMode === d.mode;
      }
      b.classList.toggle('on', on);
    }
    lastLive = live;
    ui.btnPlay.textContent = S.engine && S.engine.playing ? 'Pause' : 'Lecture';
  }
  function flashPad(n) {
    const b = padEls[n]; if (!b) return;
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 110);
  }
  function updateLayer() {
    const l2 = layer2();
    ui.layer.textContent = l2 ? '2 stems' : '1 cues';
    ui.btnLatch.setAttribute('aria-pressed', String(S.latch));
    if (ui.pads.dataset.layer !== (l2 ? '2' : '1')) renderPads();
  }
  function updateStemsUI() {
    const ready = !!(S.track && S.track.stems);
    for (const b of ui.stems.querySelectorAll('.stem')) {
      const k = b.dataset.stem;
      b.disabled = !ready;
      b.classList.toggle('live', ready && S.stemsOn[k]);
      b.classList.toggle('muted', ready && !S.stemsOn[k]);
    }
    if (ready) ui.stemState.textContent = S.stemMode === 'acapella' ? 'acapella' : S.stemMode === 'rythmique' ? 'rythmique' : 'actifs';
    else if (!S.server.stems && S.server.ok) ui.stemState.textContent = 'Demucs non installé';
    if (layer2()) renderPads();
  }
  function renderFx() {
    for (const b of document.querySelectorAll('.fx')) b.classList.toggle('on', S.fxHeld.has(b.dataset.action));
  }

  // boutons latéraux (souris)
  for (const b of document.querySelectorAll('[data-action]')) {
    if (b.classList.contains('pad')) continue;
    const act = b.dataset.action;
    b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); b.dataset.held = '1'; press(act); });
    const up = () => { if (b.dataset.held) { delete b.dataset.held; release(act); } };
    b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
    b.addEventListener('click', (e) => { if (e.detail === 0) { press(act); release(act); } });
  }

  // =================================================== formes d'onde
  function computePeaks(buf) {
    const rate = 200; // valeurs par seconde
    const step = Math.max(1, Math.floor(buf.sampleRate / rate));
    const n = Math.ceil(buf.length / step);
    const peaks = new Float32Array(n);
    const chs = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = i * step, b = Math.min(buf.length, a + step);
      for (let j = a; j < b; j += 2) for (const ch of chs) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      peaks[i] = m;
    }
    let mx = 0; for (const v of peaks) if (v > mx) mx = v;
    if (mx > 0) for (let i = 0; i < n; i++) peaks[i] /= mx;
    return { peaks, peaksRate: buf.sampleRate / step };
  }

  const dpr = () => window.devicePixelRatio || 1;
  function sizeCanvas(cv) {
    const w = Math.max(10, Math.floor(cv.clientWidth * dpr()));
    const h = Math.floor(+cv.getAttribute('height') * dpr());
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv.style.height = `${cv.getAttribute('height')}px`; }
    return [w, h];
  }
  let overviewCache = null;
  function sectionAt(t) {
    const a = grid(); if (!a) return null;
    for (const s of a.sections) if (t >= s.start && t < s.end) return s;
    return null;
  }
  function drawOverviewBase() {
    const cv = ui.overview, [w, h] = sizeCanvas(cv);
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const g = off.getContext('2d');
    g.fillStyle = '#24272a'; g.fillRect(0, 0, w, h);
    const t = S.track;
    if (!t) { overviewCache = off; return; }
    const dur = t.mix.duration, band = 8 * dpr(), mid = (h - band) / 2;
    const a = t.analysis;
    if (a) for (const s of a.sections) {
      g.fillStyle = colorOf(s.label);
      g.globalAlpha = 0.9;
      g.fillRect((s.start / dur) * w, h - band, Math.max(1, ((s.end - s.start) / dur) * w - 2 * dpr()), band);
      g.globalAlpha = 1;
    }
    const per = t.peaks.length / w;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(x * per), i1 = Math.max(i0 + 1, Math.floor((x + 1) * per));
      let m = 0; for (let i = i0; i < i1; i++) if (t.peaks[i] > m) m = t.peaks[i];
      const s = sectionAt((x / w) * dur);
      g.fillStyle = s ? colorOf(s.label) : '#8a8f94';
      g.globalAlpha = 0.75;
      const hh = Math.max(1, m * (mid - 2 * dpr()));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.globalAlpha = 1;
    // marqueurs de cues
    g.font = `600 ${11 * dpr()}px "Chakra Petch", sans-serif`;
    g.textBaseline = 'top';
    for (const c of S.cues) {
      const x = Math.round((c.time / dur) * w);
      g.fillStyle = '#e6e2d8'; g.fillRect(x, 0, Math.max(1, dpr()), h - band);
      g.fillStyle = '#d8d2c4'; g.fillRect(x, 0, 14 * dpr(), 14 * dpr());
      g.fillStyle = '#2a2d30'; g.fillText(String(c.key), x + 3.5 * dpr(), 1.5 * dpr());
    }
    overviewCache = off;
  }

  function drawFrame() {
    // vue d'ensemble
    const ov = ui.overview, [w, h] = sizeCanvas(ov);
    if (!overviewCache || overviewCache.width !== w) drawOverviewBase();
    const g = ov.getContext('2d');
    g.drawImage(overviewCache, 0, 0);
    const t = S.track, eng = S.engine;
    if (!t) { requestAnimationFrame(drawFrame); return drawZoom(null); }
    const p = eng ? eng.position() : 0;
    const dur = t.mix.duration;
    const loop = eng && eng.currentLoop();
    if (loop) {
      g.fillStyle = 'rgba(242,163,58,.35)';
      g.fillRect((loop.start / dur) * w, 0, Math.max(2, ((loop.end - loop.start) / dur) * w), h);
    }
    g.fillStyle = '#f2a33a';
    g.fillRect(Math.round((p / dur) * w) - dpr(), 0, 2 * dpr(), h);
    drawZoom(p);

    // LCD
    ui.time.textContent = fmtTime(p);
    const a = grid();
    if (a && a.downbeats.length) {
      const bi = bsearch(a.downbeats, p + 1e-3);
      const beatIn = bi >= 0 ? Math.floor((p - a.downbeats[bi]) / a.beatLen + 1e-6) + 1 : 0;
      ui.bar.textContent = bi >= 0 ? `${bi + 1}.${Math.min(4, Math.max(1, beatIn))}` : '0.0';
    }
    // fin de morceau
    if (eng && eng.playing && !loop && p >= dur - 0.02) { eng.pause(); eng.pausedPos = 0; renderPadStates(); }
    if (currentCueKey() !== lastLive) renderPadStates();
    requestAnimationFrame(drawFrame);
  }

  function drawZoom(p) {
    const cv = ui.zoom, [w, h] = sizeCanvas(cv);
    const g = cv.getContext('2d');
    g.fillStyle = '#24272a'; g.fillRect(0, 0, w, h);
    const t = S.track;
    if (!t || p == null) {
      g.fillStyle = '#7c7a74'; g.font = `500 ${15 * dpr()}px "IBM Plex Sans", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('Ouvre un MP3, FLAC ou WAV, ou glisse-le ici', w / 2, h / 2);
      g.textAlign = 'left';
      return;
    }
    const span = 6; // secondes visibles
    const t0 = p - span / 2;
    const pxPerSec = w / span;
    const a = grid();
    // grille
    if (a) {
      const iB = Math.max(0, bsearch(a.beats, t0));
      for (let i = iB; i < a.beats.length && a.beats[i] < t0 + span; i++) {
        const x = (a.beats[i] - t0) * pxPerSec;
        g.fillStyle = 'rgba(230,226,216,.14)'; g.fillRect(x, 0, dpr(), h);
      }
      const iD = Math.max(0, bsearch(a.downbeats, t0));
      for (let i = iD; i < a.downbeats.length && a.downbeats[i] < t0 + span; i++) {
        const x = (a.downbeats[i] - t0) * pxPerSec;
        g.fillStyle = 'rgba(230,226,216,.45)'; g.fillRect(x, 0, 2 * dpr(), h);
      }
    }
    // onde
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const tt = t0 + x / pxPerSec;
      if (tt < 0 || tt > t.mix.duration) continue;
      const i0 = Math.floor(tt * t.peaksRate), i1 = Math.max(i0 + 1, Math.floor((tt + 1 / pxPerSec) * t.peaksRate));
      let m = 0; for (let i = i0; i < i1 && i < t.peaks.length; i++) if (t.peaks[i] > m) m = t.peaks[i];
      const s = sectionAt(tt);
      g.fillStyle = s ? colorOf(s.label) : '#8a8f94';
      g.globalAlpha = tt < p ? 0.55 : 0.95;
      const hh = Math.max(1, m * (mid - 4));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.globalAlpha = 1;
    // cues visibles
    g.font = `600 ${12 * dpr()}px "Chakra Petch", sans-serif`; g.textBaseline = 'top';
    for (const c of S.cues) {
      if (c.time < t0 || c.time > t0 + span) continue;
      const x = (c.time - t0) * pxPerSec;
      g.fillStyle = '#d8d2c4'; g.fillRect(x, 0, 2 * dpr(), h);
      g.fillText(`${c.key} ${c.name}`, x + 5 * dpr(), 4 * dpr());
    }
    g.fillStyle = '#f2a33a'; g.fillRect(w / 2 - dpr(), 0, 2 * dpr(), h);
  }

  ui.overview.addEventListener('pointerdown', (e) => {
    if (!hasTrack()) return;
    const r = ui.overview.getBoundingClientRect();
    const pos = ((e.clientX - r.left) / r.width) * S.track.mix.duration;
    ensureAudio();
    S.loopBeats = 0;
    if (S.engine.playing) S.engine.jumpAt(S.ctx.currentTime, pos);
    else S.engine.pausedPos = pos;
    renderPadStates();
  });
  window.addEventListener('resize', () => drawOverviewBase());

  // =================================================== chargement (UI)
  ui.file.addEventListener('change', () => { loadFromFile(ui.file.files[0]); ui.file.value = ''; });
  ui.ytForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ui.ytUrl.value.trim();
    if (url) loadFromYouTube(url);
  });
  for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('dragging'); });
  for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    ui.drop.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFromFile(f);
  });

  // =================================================== MIDI
  const DEFAULT_MIDI = (() => {
    const m = {};
    for (let i = 0; i < 9; i++) { m[`n${36 + i}`] = `cue:${i + 1}`; m[`n${48 + i}`] = `l2:${i + 1}`; }
    m.c1 = 'knob:filter';
    return m;
  })();
  function loadMidiMap() {
    try { return { ...DEFAULT_MIDI, ...JSON.parse(localStorage.getItem('cuepad:midi') || '{}') }; } catch (_) { return { ...DEFAULT_MIDI }; }
  }
  function saveMidiMap(custom) { try { localStorage.setItem('cuepad:midi', JSON.stringify(custom)); } catch (_) { /* rien */ } }
  let midiCustom = {};
  try { midiCustom = JSON.parse(localStorage.getItem('cuepad:midi') || '{}'); } catch (_) { midiCustom = {}; }

  function onMidi(ev) {
    const [st, d1, d2] = ev.data;
    const type = st & 0xf0;
    let id = null, on = null, val = null;
    if (type === 0x90 && d2 > 0) { id = `n${d1}`; on = true; }
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) { id = `n${d1}`; on = false; }
    else if (type === 0xb0) { id = `c${d1}`; val = d2 / 127; }
    if (!id) return;
    if (S.midi.learn && S.midi.target) {
      if (on === false) return;
      midiCustom[id] = S.midi.target;
      saveMidiMap(midiCustom);
      S.midi.map = loadMidiMap();
      ui.midiHint.textContent = `${id.startsWith('n') ? 'Note' : 'CC'} ${id.slice(1)} → ${S.midi.target}. Clique une autre cible ou « Terminer ».`;
      document.querySelectorAll('.learn-target').forEach((e) => e.classList.remove('learn-target'));
      S.midi.target = null;
      return;
    }
    const action = S.midi.map[id];
    if (!action) return;
    if (action === 'knob:filter') { if (val != null) filterKnob(val); return; }
    if (val != null) { if (val > 0.5) press(action); else release(action); return; }
    if (on) press(action); else release(action);
  }
  async function enableMidi() {
    if (!navigator.requestMIDIAccess) { ui.midiState.textContent = 'non pris en charge'; ui.midiHint.textContent = 'Ce navigateur n\'a pas Web MIDI. Utilise Chrome, Chromium ou Edge.'; return; }
    try {
      const acc = await navigator.requestMIDIAccess();
      S.midi.access = acc; S.midi.map = loadMidiMap();
      const bind = () => {
        let n = 0;
        acc.inputs.forEach((inp) => { inp.onmidimessage = onMidi; n++; });
        ui.midiState.textContent = n ? `${n} appareil${n > 1 ? 's' : ''}` : 'aucun appareil';
      };
      bind(); acc.onstatechange = bind;
      ui.btnLearn.disabled = false;
      ui.btnMidi.disabled = true;
    } catch (e) {
      ui.midiState.textContent = 'refusé';
      ui.midiHint.textContent = 'Accès MIDI refusé par le navigateur.';
    }
  }
  function setLearnTarget(action) {
    S.midi.target = action;
    document.querySelectorAll('.learn-target').forEach((e) => e.classList.remove('learn-target'));
    const el = action.startsWith('cue:') || action.startsWith('l2:') ? padEls[+action.split(':')[1]] : document.querySelector(`[data-action="${action}"]`);
    if (el) el.classList.add('learn-target');
    ui.midiHint.textContent = `Cible : ${action}. Appuie sur un pad ou tourne un bouton de ton contrôleur.`;
  }
  ui.btnMidi.addEventListener('click', enableMidi);
  ui.btnLearn.addEventListener('click', () => {
    S.midi.learn = !S.midi.learn; S.midi.target = null;
    document.body.classList.toggle('learning', S.midi.learn);
    ui.btnLearn.textContent = S.midi.learn ? 'Terminer' : 'Apprendre';
    ui.btnLearn.setAttribute('aria-pressed', String(S.midi.learn));
    document.querySelectorAll('.learn-target').forEach((e) => e.classList.remove('learn-target'));
    ui.midiHint.textContent = S.midi.learn ? 'Clique un pad ou un effet, puis actionne une commande MIDI.' : 'Assignations enregistrées dans ce navigateur.';
  });

  // =================================================== démarrage
  buildPads();
  renderPads();
  updateLayer();
  detectServer();
  requestAnimationFrame(drawFrame);

  // accès pour les tests automatisés
  window.CuePad = { S, press, release, loadTrack: (n, b) => loadTrack(n, b, {}), ensureAudio };
})();
