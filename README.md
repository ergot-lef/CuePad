# CuePad

A remix pad driven by the numeric keypad. You drop in a track, CuePad analyses it (tempo, beats, bars, sections) and places **9 hot cues** on the interesting points: intro, verses, build-ups, drops, breaks… Then you play with the keypad, like YouTube's 1–9 keys, but in time with the music.

![CuePad](docs/capture.png)

## What it does

- **Automatic analysis**, entirely in the browser: BPM, beat grid, downbeats, section detection and labelling (Intro, Couplet, Refrain, Montée, Drop, Break, Pont, Outro).
- **9 hot cues** placed on the starts of sections and phrases, colour-coded by section type.
- **Quantised jumps**: when you hit a pad, the jump waits for the next beat (or bar), so it always lands in time.
- **Two pad layers**: cues normally, loops and stems with <kbd>Shift</kbd> held.
- **Arrow-key effects** (held): low-pass, high-pass, synced echo, roll with "slip" (the track picks up where it would have been).
- **Stems** (vocals / drums / bass / instruments) with [Demucs](https://github.com/facebookresearch/demucs), through the local server.
- **YouTube links** with [yt-dlp](https://github.com/yt-dlp/yt-dlp), through the local server.
- **MIDI**: works with a pad controller, with a "learn" mode to map your controls.

## Running it

### Browser only (no stems, no YouTube)

Open `static/index.html` in Chrome / Chromium / Firefox and load an MP3, FLAC, WAV, OGG or M4A file.

### With the local server (stems + YouTube)

Needs Python 3.10+ and **ffmpeg**.

```bash
pip install -r requirements.txt          # interface server + yt-dlp
pip install demucs                       # stems (pulls in PyTorch, large download)
python server.py
```

Then open <http://127.0.0.1:8765>.

The first stem separation downloads the Demucs model (about 80 MB). Expect around 10–30 s per track on an NVIDIA GPU, and a few minutes on CPU. Results are cached in `cache/`, so a track that has already been processed loads instantly.

Options (environment variables):

| Variable        | Purpose                                          | Default      |
|-----------------|--------------------------------------------------|--------------|
| `CUEPAD_DEVICE` | `cuda` or `cpu` for Demucs                       | auto         |
| `CUEPAD_MODEL`  | Demucs model (`htdemucs`, `htdemucs_ft`…)        | `htdemucs`   |
| `CUEPAD_CACHE`  | cache folder                                     | `./cache`    |

## Controls

Pads follow the numeric keypad layout:

```
 7  8  9        layer 1: cues 1 to 9 (chronological order)
 4  5  6        layer 2 (Shift held):
 1  2  3          7 8 9  loop 1 beat / 2 beats / 1 bar
                  4 5 6  vocals / drums / bass   (mute / unmute)
                  1      instruments
                  2      acapella (vocals only)
                  3      rhythm (drums + bass)
```

| Key | Action |
|---|---|
| <kbd>1</kbd>–<kbd>9</kbd> (keypad or top row) | jump to the cue |
| <kbd>Ctrl</kbd> + <kbd>1</kbd>–<kbd>9</kbd> | place the cue at the current position (snapped to the nearest beat) |
| <kbd>Shift</kbd> + keypad | layer 2 |
| <kbd>+</kbd> (keypad) | lock layer 2 (handy on Windows, where Shift + keypad behaves differently) |
| <kbd>←</kbd> <kbd>→</kbd> | low-pass / high-pass filter (hold) |
| <kbd>↑</kbd> | echo synced to the tempo (hold) |
| <kbd>↓</kbd> | half-beat roll, slip mode (hold) |
| <kbd>0</kbd> / <kbd>Enter</kbd> / <kbd>Space</kbd> | play / pause |
| <kbd>.</kbd> | back to the start |
| <kbd>/</kbd> | quantise: beat → bar → off |
| <kbd>*</kbd> | restore the automatic cues |
| <kbd>Shift</kbd> + <kbd>0</kbd> | reset everything (stems, loops, effects) |

Cues you edit are saved in the browser, per track.

### MIDI

Click "Activer le MIDI" (Chrome / Chromium / Edge). Default mapping: notes 36–44 → cues 1–9, notes 48–56 → layer 2, CC 1 → bipolar filter (left low-pass, right high-pass). "Apprendre" lets you click a pad or an effect, then press a control on your controller to map it.

## How the analysis works

`static/analysis.js`, pure JavaScript, runs in a Web Worker:

1. Mono downmix, decimation to ~22 kHz, STFT (2048 / 256).
2. Onset envelope (log spectral flux), tempo by autocorrelation with a 120 BPM prior.
3. Beat tracking with dynamic programming (Ellis 2007), then a global fit of a regular grid when the track is at a constant tempo.
4. Downbeats: the phase that maximises kick attacks + harmonic changes.
5. Per-bar descriptors (chroma, band energies, rhythmic density) → Foote novelty curve → section boundaries aligned to 4/8-bar phrases.
6. Similar sections grouped (A, B, C…) and labelled by relative energy and position.

Tests on synthetic tracks with known ground truth:

```bash
node tests/test_analysis.js
```

## Limitations of the prototype

- Assumes 4/4. Tracks with a drifting tempo (live drummer) use the tracked beats rather than a regular grid, which is less precise.
- Section labels are heuristics: "Refrain" vs "Drop" can swap depending on the genre.
- YouTube links: for personal use only, and subject to YouTube's terms of service.

## Licence

MIT
