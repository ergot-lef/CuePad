# CuePad

[English](README.md) · **Français**

Un pad de remix piloté au pavé numérique. Tu déposes un morceau, CuePad l'analyse (tempo, temps, mesures, sections) et place tout seul **9 hot cues** sur les moments intéressants : intro, couplets, montées, drops, breaks… Ensuite tu joues au pavé, comme les touches 1 à 9 de YouTube, mais en rythme.

![CuePad](docs/capture.png)

## Ce que ça fait

- **Analyse automatique** directement dans le navigateur : BPM, grille des temps, premiers temps des mesures, découpage et nom des sections (Intro, Couplet, Refrain, Montée, Drop, Break, Pont, Outro).
- **9 hot cues** placés sur les débuts de sections et de phrases, colorés selon le type de section.
- **Sauts quantifiés** : quand tu tapes un pad, le saut attend le prochain temps (ou la prochaine mesure). Ça tombe toujours juste.
- **Deux couches de pads** : les cues, et avec <kbd>Maj</kbd> enfoncée les boucles et les stems.
- **Effets aux flèches** (à maintenir) : passe-bas, passe-haut, écho synchronisé au tempo, roll en mode « slip » (le morceau reprend là où il en serait).
- **Stems** (voix / batterie / basse / instruments) avec [Demucs](https://github.com/facebookresearch/demucs), via le serveur local.
- **Liens YouTube** avec [yt-dlp](https://github.com/yt-dlp/yt-dlp), via le serveur local.
- **MIDI** : branche un contrôleur à pads ; un mode « Apprendre » permet d'assigner tes commandes.

## Lancer CuePad

### Navigateur seul (sans stems ni YouTube)

Ouvre `static/index.html` dans Chrome, Chromium, Edge ou Firefox, puis charge un fichier MP3, FLAC, WAV, OGG ou M4A.

### Avec le serveur local (stems + YouTube)

Il faut Python 3.10 ou plus récent.

**1. Installer les dépendances**

```bash
python -m pip install -r requirements.txt   # serveur, yt-dlp et ffmpeg
python -m pip install demucs                # stems (installe PyTorch, gros téléchargement)
```

Pas besoin d'installer ffmpeg à part : s'il n'est pas déjà sur ta machine, le serveur utilise celui fourni par le paquet `imageio-ffmpeg`.

Avec une carte graphique NVIDIA, installe d'abord PyTorch avec CUDA (voir [pytorch.org](https://pytorch.org/get-started/locally/)), sinon Demucs tourne sur le processeur.

**2. Démarrer**

```bash
python server.py
```

Puis ouvre <http://127.0.0.1:8765>. Au démarrage, le serveur indique ce qui est actif et la commande à taper pour ce qui manque.

La première séparation télécharge le modèle Demucs (environ 80 Mo). Compte 10 à 30 s par morceau sur carte NVIDIA, quelques minutes sur processeur. Les résultats sont gardés dans `cache/` : un morceau déjà traité se recharge tout de suite.

Réglages (variables d'environnement) :

| Variable        | Rôle                                            | Défaut       |
|-----------------|-------------------------------------------------|--------------|
| `CUEPAD_DEVICE` | `cuda` ou `cpu` pour Demucs                     | automatique  |
| `CUEPAD_MODEL`  | modèle Demucs (`htdemucs`, `htdemucs_ft`…)      | `htdemucs`   |
| `CUEPAD_CACHE`  | dossier du cache                                | `./cache`    |

## Commandes

Les pads reprennent la disposition du pavé numérique :

```
 7  8  9        couche 1 : cues 1 à 9 (ordre chronologique)
 4  5  6        couche 2 (Maj enfoncée) :
 1  2  3          7 8 9  boucle 1 temps / 2 temps / 1 mesure
                  4 5 6  voix / batterie / basse   (couper / remettre)
                  1      instruments
                  2      acapella (voix seule)
                  3      rythmique (batterie + basse)
```

| Touche | Action |
|---|---|
| <kbd>1</kbd>–<kbd>9</kbd> (pavé ou rangée du haut) | sauter au cue |
| <kbd>Ctrl</kbd> + <kbd>1</kbd>–<kbd>9</kbd> | placer le cue à la position actuelle (calé sur le temps le plus proche) |
| <kbd>Maj</kbd> + pavé | couche 2 |
| <kbd>+</kbd> (pavé) | verrouiller la couche 2 |
| <kbd>←</kbd> <kbd>→</kbd> | filtre passe-bas / passe-haut (maintenir) |
| <kbd>↑</kbd> | écho calé sur le tempo (maintenir) |
| <kbd>↓</kbd> | roll d'un demi-temps, mode slip (maintenir) |
| <kbd>0</kbd> / <kbd>Entrée</kbd> / <kbd>Espace</kbd> | lecture / pause |
| <kbd>.</kbd> | retour au début |
| <kbd>/</kbd> | quantification : temps → mesure → aucune |
| <kbd>*</kbd> | rétablir les cues automatiques |
| <kbd>Maj</kbd> + <kbd>0</kbd> | tout rétablir (stems, boucles, effets) |

**Sous Windows**, <kbd>Maj</kbd> + pavé numérique se comporte mal (Windows relâche Maj en douce). Utilise plutôt <kbd>+</kbd> du pavé pour verrouiller la couche 2, ou <kbd>Maj</kbd> + les chiffres de la rangée du haut.

Les cues que tu modifies sont enregistrés dans le navigateur, morceau par morceau.

### MIDI

Clique sur « Activer le MIDI » (Chrome, Chromium ou Edge). Assignation par défaut : notes 36 à 44 → cues 1 à 9, notes 48 à 56 → couche 2, CC 1 → filtre (à gauche passe-bas, à droite passe-haut). « Apprendre » : clique un pad ou un effet, puis actionne une commande de ton contrôleur.

## Comment marche l'analyse

`static/analysis.js`, en JavaScript pur, tourne dans un Web Worker :

1. Passage en mono, réduction à ~22 kHz, transformée de Fourier glissante (fenêtre 2048, pas 256).
2. Courbe d'attaques (flux spectral logarithmique), tempo par autocorrélation avec une préférence autour de 120 BPM.
3. Suivi des temps par programmation dynamique (méthode d'Ellis, 2007), puis ajustement d'une grille régulière sur tout le morceau quand le tempo est constant.
4. Premier temps de la mesure : la position qui maximise les coups de grosse caisse et les changements d'accord.
5. Description de chaque mesure (chroma, énergie par bande, densité rythmique) → courbe de nouveauté de Foote → frontières de sections alignées sur des phrases de 4 ou 8 mesures.
6. Regroupement des sections qui se ressemblent (A, B, C…) et nommage selon l'énergie et la position dans le morceau.

Tests sur des morceaux synthétiques dont on connaît la structure :

```bash
node tests/test_analysis.js
```

## Limites du prototype

- Suppose une mesure à 4 temps. Les morceaux au tempo flottant (batteur live) utilisent les temps suivis plutôt qu'une grille régulière, c'est moins précis.
- Le nom des sections reste une estimation : « Refrain » et « Drop » peuvent s'inverser selon le style.
- Liens YouTube : pour un usage personnel, dans le respect des conditions d'utilisation de YouTube.

## Licence

MIT
