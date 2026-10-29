"""CuePad — séparation en stems avec Demucs, sans passer par son outil en ligne de commande.

Pourquoi : selon les versions, la commande `demucs` dépend de ffprobe et de torchaudio
(qui réclame en plus torchcodec pour écrire les fichiers). Ici on décode l'audio avec
ffmpeg, on sépare avec l'API Python de Demucs et on écrit les WAV avec la bibliothèque
standard : seuls torch, demucs, numpy et ffmpeg sont nécessaires.

Usage : python stems_worker.py <entrée> <dossier_sortie> [modèle] [cpu|cuda]
La progression s'affiche sous la forme « 42%| » (lue par server.py).
"""
from __future__ import annotations

import os
import subprocess
import sys
import wave
from pathlib import Path


def decode(path: str, sr: int, channels: int):
    import numpy as np

    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vn",
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=False)
    if raw.returncode != 0 or not raw.stdout:
        raise RuntimeError("ffmpeg n'a pas pu lire le fichier : " + raw.stderr.decode("utf-8", "replace")[-300:])
    data = np.frombuffer(raw.stdout, dtype=np.float32)
    return data.reshape(-1, channels).T.copy()  # (canaux, échantillons)


def write_wav(path: Path, audio, sr: int) -> None:
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.T.tobytes())


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, out = sys.argv[1], Path(sys.argv[2])
    model_name = sys.argv[3] if len(sys.argv) > 3 else "htdemucs"
    device = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None

    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    if not device:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Modèle {model_name} sur {device}", flush=True)
    model = get_model(model_name)
    model.eval()
    sr, nch = model.samplerate, model.audio_channels

    wav = torch.from_numpy(decode(src, sr, nch))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    std = std if std > 1e-8 else torch.tensor(1.0)
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], device=device,
                              split=True, overlap=0.25, progress=True)[0]
    sources = sources * std + mean

    out.mkdir(parents=True, exist_ok=True)
    for name, audio in zip(model.sources, sources):
        write_wav(out / f"{name}.wav", audio.cpu().numpy(), sr)
        print(f"écrit : {name}.wav", flush=True)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main())
