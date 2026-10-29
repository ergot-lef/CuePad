"""CuePad — serveur local optionnel.

Sert l'interface web et ajoute deux fonctions que le navigateur ne peut pas faire seul :
  * séparation en stems (voix / batterie / basse / instruments) avec Demucs ;
  * récupération de l'audio d'un lien YouTube avec yt-dlp.

Lancement :  python server.py   puis ouvrir http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from importlib.util import find_spec
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = Path(os.environ.get("CUEPAD_CACHE", ROOT / "cache"))
SRC_DIR = CACHE / "sources"
STEM_DIR = CACHE / "stems"
for d in (SRC_DIR, STEM_DIR):
    d.mkdir(parents=True, exist_ok=True)

STEMS = ("vocals", "drums", "bass", "other")
DEMUCS_MODEL = os.environ.get("CUEPAD_MODEL", "htdemucs")
DEMUCS_DEVICE = os.environ.get("CUEPAD_DEVICE")  # "cuda", "cpu"… (auto par défaut)

FAKE_STEMS = os.environ.get("CUEPAD_FAKE_STEMS") == "1"  # réservé aux tests
DEMUCS_MISSING = [m for m in ("demucs", "torch", "numpy") if find_spec(m) is None]
HAS_DEMUCS = FAKE_STEMS or not DEMUCS_MISSING
HAS_YTDLP = find_spec("yt_dlp") is not None


def _ensure_ffmpeg() -> bool:
    """Trouve ffmpeg ; à défaut, utilise celui fourni par le paquet pip imageio-ffmpeg.

    Le binaire est copié dans cache/bin sous le nom « ffmpeg » et ce dossier est ajouté
    au PATH du serveur : Demucs et yt-dlp le trouvent alors sans rien installer à la main.
    """
    if shutil.which("ffmpeg"):
        return True
    try:
        import imageio_ffmpeg  # dépendance optionnelle (requirements.txt)
        exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:  # noqa: BLE001
        return False
    bindir = CACHE / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    dest = bindir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not dest.exists() or dest.stat().st_size != exe.stat().st_size:
        shutil.copy2(exe, dest)
        dest.chmod(0o755)
    os.environ["PATH"] = str(bindir) + os.pathsep + os.environ.get("PATH", "")
    return shutil.which("ffmpeg") is not None


HAS_FFMPEG = _ensure_ffmpeg()

app = FastAPI(title="CuePad")

# ----------------------------------------------------------------- jobs
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_stem_pool = ThreadPoolExecutor(max_workers=1)   # une séparation à la fois (mémoire GPU)
_io_pool = ThreadPoolExecutor(max_workers=2)


def _new_job() -> str:
    jid = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[jid] = {"status": "queued", "progress": 0.0, "result": None, "error": None}
    return jid


def _update(jid: str, **kw) -> None:
    with _lock:
        _jobs[jid].update(kw)


def _run(jid: str, fn, *args) -> None:
    _update(jid, status="running")
    try:
        res = fn(jid, *args)
        _update(jid, status="done", progress=1.0, result=res)
    except Exception as exc:  # noqa: BLE001 — l'erreur est renvoyée telle quelle à l'interface
        _update(jid, status="error", error=str(exc))


# -------------------------------------------------------------- sources
def _find_source(source_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{40}", source_id):
        raise HTTPException(400, "Identifiant de source invalide")
    hits = list(SRC_DIR.glob(f"{source_id}.*"))
    if not hits:
        raise HTTPException(404, "Source inconnue : renvoie le fichier")
    return hits[0]


def _store_source(data: bytes, ext: str) -> str:
    sha = hashlib.sha1(data).hexdigest()
    ext = re.sub(r"[^a-z0-9]", "", ext.lower())[:5] or "bin"
    dest = SRC_DIR / f"{sha}.{ext}"
    if not dest.exists():
        dest.write_bytes(data)
    return sha


# ----------------------------------------------------------- endpoints
@app.get("/api/health")
def health():
    return {"server": True, "stems": HAS_DEMUCS and HAS_FFMPEG, "youtube": HAS_YTDLP and HAS_FFMPEG,
            "demucs": HAS_DEMUCS, "yt_dlp": HAS_YTDLP, "ffmpeg": HAS_FFMPEG, "model": DEMUCS_MODEL}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Fichier vide")
    ext = Path(file.filename or "audio.bin").suffix.lstrip(".")
    return {"source_id": _store_source(data, ext)}


class StemsReq(BaseModel):
    source_id: str


def _separate(jid: str, src: Path) -> dict:
    sha = src.stem
    out = STEM_DIR / sha
    if all((out / f"{s}.wav").exists() for s in STEMS):
        return {"stems": {s: f"/files/stems/{sha}/{s}.wav" for s in STEMS}}
    if FAKE_STEMS:  # mode test : faux stems par filtrage ffmpeg (pas de Demucs)
        out.mkdir(parents=True, exist_ok=True)
        filt = {"vocals": "bandpass=f=1500:w=1200", "drums": "highpass=f=3000",
                "bass": "lowpass=f=180", "other": "bandpass=f=600:w=500"}
        for i, s in enumerate(STEMS):
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-af", filt[s],
                            "-ar", "44100", str(out / f"{s}.wav")], check=True)
            _update(jid, progress=(i + 1) / 4)
        return {"stems": {s: f"/files/stems/{sha}/{s}.wav" for s in STEMS}}
    tmp = STEM_DIR / f"_tmp_{sha}"
    shutil.rmtree(tmp, ignore_errors=True)
    cmd = [sys.executable, str(ROOT / "stems_worker.py"), str(src), str(tmp), DEMUCS_MODEL, DEMUCS_DEVICE or ""]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    tail: list[str] = []
    buf = b""
    assert proc.stdout is not None
    while True:
        ch = proc.stdout.read(256)
        if not ch:
            break
        buf += ch
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for line in parts:
            txt = line.decode("utf-8", "replace")
            m = re.search(r"(\d{1,3})%\|", txt)
            if m:
                _update(jid, progress=min(0.99, int(m.group(1)) / 100))
            if txt.strip():
                tail = (tail + [txt])[-15:]
    if proc.wait() != 0:
        raise RuntimeError("Demucs a échoué : " + " | ".join(tail[-4:]))
    produced = tmp
    out.mkdir(parents=True, exist_ok=True)
    for s in STEMS:
        f = produced / f"{s}.wav"
        if not f.exists():
            raise RuntimeError(f"Stem manquant : {s}")
        shutil.move(str(f), out / f"{s}.wav")
    shutil.rmtree(tmp, ignore_errors=True)
    return {"stems": {s: f"/files/stems/{sha}/{s}.wav" for s in STEMS}}


@app.post("/api/stems")
def stems(req: StemsReq):
    if not HAS_DEMUCS:
        raise HTTPException(501, "Demucs n'est pas installé : pip install demucs")
    if not HAS_FFMPEG:
        raise HTTPException(501, "ffmpeg est introuvable")
    src = _find_source(req.source_id)
    jid = _new_job()
    _stem_pool.submit(_run, jid, _separate, src)
    return {"job": jid}


class YtReq(BaseModel):
    url: str


def _youtube(jid: str, url: str) -> dict:
    import yt_dlp  # import tardif : dépendance optionnelle

    tmp = CACHE / "yt" / jid
    tmp.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if d.get("status") == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate")
            if tot:
                _update(jid, progress=min(0.95, d.get("downloaded_bytes", 0) / tot))

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(tmp / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "flac"}],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = list(tmp.glob("*.flac"))
    if not files:
        raise RuntimeError("Aucun fichier audio récupéré")
    sha = _store_source(files[0].read_bytes(), "flac")
    shutil.rmtree(tmp, ignore_errors=True)
    return {"source_id": sha, "title": info.get("title") or "YouTube", "file_url": f"/files/sources/{sha}.flac"}


@app.post("/api/youtube")
def youtube(req: YtReq):
    if not (HAS_YTDLP and HAS_FFMPEG):
        raise HTTPException(501, "yt-dlp ou ffmpeg manquant : pip install yt-dlp")
    if not re.match(r"^https?://", req.url.strip()):
        raise HTTPException(400, "Lien invalide")
    jid = _new_job()
    _io_pool.submit(_run, jid, _youtube, req.url.strip())
    return {"job": jid}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    with _lock:
        j = _jobs.get(jid)
        if not j:
            raise HTTPException(404, "Tâche inconnue")
        return dict(j)


app.mount("/files", StaticFiles(directory=str(CACHE)), name="files")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=str(STATIC)), name="static")


if __name__ == "__main__":
    import uvicorn

    ap = argparse.ArgumentParser(description="Serveur local CuePad")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    ok = lambda b: "oui" if b else "NON"  # noqa: E731
    print(f"CuePad → http://{a.host}:{a.port}\n")
    print(f"  ffmpeg  : {ok(HAS_FFMPEG):3}  (nécessaire pour les stems et YouTube)")
    print(f"  Demucs  : {ok(HAS_DEMUCS):3}  (stems)")
    print(f"  yt-dlp  : {ok(HAS_YTDLP):3}  (liens YouTube)")
    missing = []
    if not HAS_FFMPEG:
        missing.append(f"ffmpeg  → {sys.executable} -m pip install imageio-ffmpeg")
    if not HAS_DEMUCS:
        missing.append(f"Demucs  → {sys.executable} -m pip install " + " ".join(DEMUCS_MISSING))
    if not HAS_YTDLP:
        missing.append(f"yt-dlp  → {sys.executable} -m pip install yt-dlp")
    if missing:
        print("\n  Pour tout activer :")
        for m in missing:
            print("    " + m)
    print("\n  Sans ces outils, l'analyse et les pads marchent quand même avec tes fichiers.\n")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
