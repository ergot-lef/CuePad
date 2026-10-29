// Test de l'analyse : node tests/test_analysis.js
'use strict';
const path = require('path');
const { analyze } = require(path.join(__dirname, '..', 'static', 'analysis.js'));
const { makeTrack } = require('./synth');

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'ÉCHEC'} ${msg}`); if (!cond) failures++; };

for (const cfg of [{ bpm: 124, offset: 0.37 }, { bpm: 95, offset: 1.1, seed: 7 }, { bpm: 140, offset: 0.05, seed: 3 }]) {
  const tr = makeTrack(cfg);
  const t = Date.now();
  const r = analyze(tr.channels, tr.sr);
  console.log(`\n=== Morceau synthétique ${cfg.bpm} BPM, décalage ${cfg.offset}s — analyse en ${Date.now() - t} ms`);
  console.log(`BPM détecté ${r.bpm} (tempo constant : ${r.constantTempo})`);
  check(Math.abs(r.bpm - cfg.bpm) < 0.5, `BPM à ±0,5 (${r.bpm} vs ${cfg.bpm})`);

  // premiers temps alignés sur la vraie grille des mesures
  const errs = r.downbeats.slice(0, 40).map((d) => {
    const k = Math.round((d - tr.offset) / tr.bar);
    return Math.abs(d - (tr.offset + k * tr.bar));
  });
  const maxErr = Math.max(...errs);
  check(maxErr < 0.03, `premiers temps des mesures alignés (erreur max ${(maxErr * 1000).toFixed(1)} ms)`);

  console.log('Sections détectées :');
  for (const s of r.sections) console.log(`  ${s.start.toFixed(2).padStart(7)}s  mesure ${String(s.barStart).padStart(3)}  ${s.letter}  ${s.label.padEnd(8)} énergie ${s.energy.toFixed(2)}`);
  console.log('Vérité terrain :');
  for (const g of tr.truth) console.log(`  ${g.time.toFixed(2).padStart(7)}s  mesure ${String(g.bar).padStart(3)}  ${g.name}`);
  const truthB = tr.truth.slice(1).map((g) => g.time);
  const found = truthB.filter((tb) => r.sections.some((s) => Math.abs(s.start - tb) < 0.1));
  check(found.length >= truthB.length - 1, `frontières retrouvées : ${found.length}/${truthB.length}`);

  console.log('Hot cues :');
  for (const c of r.cues) console.log(`  [${c.key}] ${c.time.toFixed(2).padStart(7)}s  ${c.name}`);
  check(r.cues.length === 9, '9 hot cues');
  check(r.cues.every((c, i) => i === 0 || c.time > r.cues[i - 1].time), 'cues dans l\'ordre chronologique');
  const dropCue = r.cues.find((c) => c.label === 'Drop' || c.label === 'Refrain');
  check(!!dropCue, `un cue Drop/Refrain existe (${dropCue && dropCue.name})`);
}
console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
