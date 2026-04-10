"""
FastAPI server for accompy.

Endpoints:
  GET  /                        → serve the web UI
  GET  /api/scores              → list available scores
  GET  /api/scores/{name}       → score data as JSON
  GET  /api/scores/{name}/sheet → sheet music HTML
  GET  /api/corpus/search?q=    → search music21 corpus
  POST /api/convert             → convert a corpus piece
"""

import os
import re
import tempfile
import subprocess
import importlib.util
from pathlib import Path
from functools import lru_cache
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from src.convert_score import convert_score_source, slugify_score_name
from src.paths import get_scores_dir, get_static_dir

app = FastAPI()


# ── Corpus index (built once on first search) ─────────────────────────────────

@lru_cache(maxsize=1)
def _corpus_index():
    """Return list of {path, composer, title} for all .mxl files in the corpus."""
    from music21 import corpus
    pkg_dir = os.path.dirname(corpus.__file__)
    entries = []
    for p in corpus.getPaths():
        s = str(p)
        if not s.endswith('.mxl'):
            continue
        rel   = os.path.relpath(s, pkg_dir).replace(os.sep, '/').replace('.mxl', '')
        parts = rel.split('/')
        composer = parts[0] if len(parts) >= 2 else ''
        title    = '/'.join(parts[1:]) if len(parts) >= 2 else rel
        entries.append({'path': rel, 'composer': composer, 'title': title})
    return entries

SCORES_DIR = str(get_scores_dir())
STATIC_DIR = str(get_static_dir())
ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg"}
ALLOWED_PDF_SUFFIXES = {".pdf"}

# In-memory score cache: name → (mtime, module)
# Invalidated automatically when the .py file changes on disk.
_score_cache: dict[str, tuple[float, object]] = {}
_measure_cache: dict[str, tuple[float, list[float]]] = {}


def load_score_module(name: str):
    path = os.path.join(SCORES_DIR, f"{name}.py")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Score '{name}' not found")

    mtime = os.path.getmtime(path)
    cached = _score_cache.get(name)
    if cached and cached[0] == mtime:
        return cached[1]

    spec = importlib.util.spec_from_file_location("_score", path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _score_cache[name] = (mtime, mod)
    return mod


def load_measure_beats(name: str) -> list[float]:
    try:
        mod = load_score_module(name)
        if hasattr(mod, "MEASURE_BEATS"):
            return list(mod.MEASURE_BEATS)
    except HTTPException:
        return []

    path = os.path.join(SCORES_DIR, f"{name}.py")
    if not os.path.exists(path):
        return []

    mtime = os.path.getmtime(path)
    cached = _measure_cache.get(name)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        with open(path, "r") as f:
            first_line = f.readline().strip()
    except OSError:
        return []

    prefixes = ("# Auto-generated: ", "# Auto-generated score: ")
    source_ref = None
    for prefix in prefixes:
        if first_line.startswith(prefix):
            source_ref = first_line[len(prefix):].strip()
            break

    if not source_ref:
        return []

    try:
        from music21 import corpus as m21corpus, converter

        if source_ref.startswith("corpus:"):
            score = m21corpus.parse(source_ref[len("corpus:"):])
        else:
            try:
                score = converter.parse(source_ref)
            except Exception:
                # Older generated scores may store a bare music21 corpus path.
                score = m21corpus.parse(source_ref)

        first_part = score.parts[0] if score.parts else score
        measure_beats = [float(m.offset) for m in first_part.getElementsByClass('Measure')]
    except Exception:
        return []

    _measure_cache[name] = (mtime, measure_beats)
    return measure_beats


def invalidate_score_cache(name: str):
    _score_cache.pop(name, None)
    _measure_cache.pop(name, None)


def score_name_from_input(raw: str) -> str:
    return slugify_score_name(raw)


async def save_uploaded_file(upload: UploadFile, directory: Path, index: int) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    stem = score_name_from_input(Path(upload.filename or f"upload_{index}").stem)
    dest = directory / f"{index:02d}_{stem}{suffix}"
    data = await upload.read()
    dest.write_bytes(data)
    await upload.close()
    return dest


def combine_images_to_pdf(image_paths: list[Path], out_path: Path) -> Path:
    import fitz

    doc = fitz.open()
    try:
        for image_path in image_paths:
            img = fitz.open(image_path)
            try:
                pdf_bytes = img.convert_to_pdf()
            finally:
                img.close()
            img_pdf = fitz.open("pdf", pdf_bytes)
            try:
                doc.insert_pdf(img_pdf)
            finally:
                img_pdf.close()
        doc.save(out_path)
    finally:
        doc.close()
    return out_path


def prepare_omr_input(upload_paths: list[Path], work_dir: Path) -> Path:
    suffixes = {path.suffix.lower() for path in upload_paths}
    if suffixes & ALLOWED_PDF_SUFFIXES:
        if len(upload_paths) != 1 or not suffixes <= ALLOWED_PDF_SUFFIXES:
            raise HTTPException(status_code=400, detail="Upload either one PDF or one/more image files, not both.")
        return upload_paths[0]

    if not suffixes or not suffixes <= ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=400, detail="Supported uploads are PDF, PNG, JPG, and JPEG.")

    return combine_images_to_pdf(upload_paths, work_dir / "input.pdf")


def run_audiveris(input_path: Path, output_dir: Path):
    audiveris_bin = os.getenv("AUDIVERIS_BIN", "audiveris")
    command = [
        audiveris_bin,
        "-batch",
        "-transcribe",
        "-export",
        "-output",
        str(output_dir),
        str(input_path),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=True)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="Audiveris is not installed or AUDIVERIS_BIN is not set.",
        ) from exc
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or exc.stdout or "Audiveris failed").strip()
        raise HTTPException(status_code=500, detail=f"Audiveris failed: {message}") from exc
    return completed


def find_musicxml_output(output_dir: Path) -> Path:
    candidates = sorted(
        [
            *output_dir.rglob("*.mxl"),
            *output_dir.rglob("*.musicxml"),
            *output_dir.rglob("*.xml"),
        ],
        key=lambda path: (path.suffix.lower() != ".mxl", -path.stat().st_size, str(path)),
    )
    for candidate in candidates:
        if candidate.name.lower().endswith("opus.xml"):
            continue
        return candidate
    raise HTTPException(status_code=500, detail="Audiveris completed but no MusicXML output was found.")


@app.get("/api/corpus/search")
def search_corpus(q: str = ""):
    index   = _corpus_index()
    q_lower = q.lower().strip()
    if not q_lower:
        # Return a sample: first 5 from each composer
        from collections import defaultdict
        by_composer = defaultdict(list)
        for e in index:
            by_composer[e['composer']].append(e)
        results = []
        for entries in by_composer.values():
            results.extend(entries[:5])
        return {"results": results[:60]}

    results = [
        e for e in index
        if q_lower in e['path'].lower()
        or q_lower in e['composer'].lower()
        or q_lower in e['title'].lower()
    ]
    return {"results": results[:60]}


@app.get("/api/scores")
def list_scores():
    names = sorted(f[:-3] for f in os.listdir(SCORES_DIR) if f.endswith(".py"))
    return {
        "scores": names,
        "items": [
            {
                "name": name,
                "has_sheet": os.path.exists(os.path.join(SCORES_DIR, f"{name}.html")),
            }
            for name in names
        ],
    }


@app.get("/api/scores/{name}")
def get_score(name: str):
    mod = load_score_module(name)
    has_sheet = os.path.exists(os.path.join(SCORES_DIR, f"{name}.html"))

    # New format: PARTS list
    if hasattr(mod, "PARTS"):
        parts = mod.PARTS
    else:
        # Legacy format (e.g. twinkle.py) — wrap in a single part
        parts = [
            {"name": "Melody",        "notes": [[p, b] for p, b in mod.RIGHT_HAND]},
            {"name": "Accompaniment", "notes": [[p, b] for p, b in mod.LEFT_HAND]},
        ]

    return {
        "name":      name,
        "parts":     parts,
        "has_sheet": has_sheet,
        "measure_beats": load_measure_beats(name),
        # keep legacy fields for CLI compatibility
        "right_hand": mod.RIGHT_HAND,
        "left_hand":  mod.LEFT_HAND,
    }


class InstrumentUpdate(BaseModel):
    part_index: int
    instrument: str


@app.patch("/api/scores/{name}/instrument")
def update_instrument(name: str, req: InstrumentUpdate):
    """Persist an instrument change for a part in the score .py file."""
    mod  = load_score_module(name)
    path = os.path.join(SCORES_DIR, f"{name}.py")

    if not hasattr(mod, "PARTS"):
        raise HTTPException(status_code=400, detail="Score has no PARTS (legacy format)")
    parts = mod.PARTS
    if req.part_index < 0 or req.part_index >= len(parts):
        raise HTTPException(status_code=400, detail="Invalid part index")

    parts[req.part_index]["instrument"] = req.instrument

    # Rewrite the file preserving everything, just updating PARTS
    with open(path, "r") as f:
        content = f.read()

    import ast
    # Replace just the PARTS line
    new_parts_line = f"PARTS = {parts!r}"
    lines = content.splitlines()
    new_lines = []
    for line in lines:
        if line.startswith("PARTS = "):
            new_lines.append(new_parts_line)
        else:
            new_lines.append(line)
    with open(path, "w") as f:
        f.write("\n".join(new_lines) + "\n")

    _score_cache.pop(name, None)
    _measure_cache.pop(name, None)
    return {"updated": True}


@app.delete("/api/scores/{name}")
def delete_score(name: str):
    removed = []
    for ext in (".py", ".html"):
        path = os.path.join(SCORES_DIR, f"{name}{ext}")
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    _score_cache.pop(name, None)
    _measure_cache.pop(name, None)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Score '{name}' not found")
    return {"deleted": removed}


@app.get("/api/scores/{name}/meta")
def get_score_meta(name: str):
    path = os.path.join(SCORES_DIR, f"{name}.py")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Score '{name}' not found")
    return {"name": name, "mtime": os.path.getmtime(path)}


@app.get("/api/scores/{name}/sheet")
def get_sheet(name: str):
    path = os.path.join(SCORES_DIR, f"{name}.html")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No sheet music for this score")
    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
    except OSError:
        raise HTTPException(status_code=500, detail="Could not read sheet music")

    # Older generated sheet pages include a print/save heading that looks out of
    # place inside the app iframe. Strip it at serve time so existing scores do
    # not need to be regenerated.
    html = re.sub(r"\s*<h1>.*?</h1>\s*", "\n", html, count=1, flags=re.IGNORECASE | re.DOTALL)
    return HTMLResponse(content=html)


class ConvertRequest(BaseModel):
    corpus_path: str
    name: str


@app.post("/api/convert")
def convert_score(req: ConvertRequest):
    try:
        result = convert_score_source(f"corpus:{req.corpus_path}", name=score_name_from_input(req.name), out_dir=SCORES_DIR)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    invalidate_score_cache(result["name"])
    return {
        "name": result["name"],
        "parts": result["parts_count"],
        "total_notes": result["total_notes"],
        "has_sheet": result["has_sheet"],
    }


@app.post("/api/import")
async def import_score(
    files: list[UploadFile] = File(...),
    name: str = Form(""),
):
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")

    score_name = score_name_from_input(name or Path(files[0].filename or "imported_score").stem)

    with tempfile.TemporaryDirectory(prefix="accompy_import_") as tmp_dir:
        work_dir = Path(tmp_dir)
        uploads_dir = work_dir / "uploads"
        output_dir = work_dir / "audiveris"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        upload_paths = [await save_uploaded_file(upload, uploads_dir, idx) for idx, upload in enumerate(files)]
        omr_input = prepare_omr_input(upload_paths, work_dir)
        run_audiveris(omr_input, output_dir)
        musicxml_path = find_musicxml_output(output_dir)

        try:
            result = convert_score_source(str(musicxml_path), name=score_name, out_dir=SCORES_DIR)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not convert Audiveris output: {exc}") from exc

    invalidate_score_cache(result["name"])
    return {
        "name": result["name"],
        "parts": result["parts_count"],
        "total_notes": result["total_notes"],
        "has_sheet": result["has_sheet"],
    }


# Serve static files and fallback to index.html
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
