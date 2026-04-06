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
import importlib.util
from functools import lru_cache
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

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

SCORES_DIR = "scores"


def load_score_module(name: str):
    path = os.path.join(SCORES_DIR, f"{name}.py")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Score '{name}' not found")
    spec = importlib.util.spec_from_file_location("_score", path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
    names = sorted(
        f[:-3] for f in os.listdir(SCORES_DIR) if f.endswith(".py")
    )
    return {"scores": names}


@app.get("/api/scores/{name}")
def get_score(name: str):
    mod = load_score_module(name)
    has_sheet = os.path.exists(os.path.join(SCORES_DIR, f"{name}.html"))
    return {
        "name":       name,
        "right_hand": mod.RIGHT_HAND,
        "left_hand":  mod.LEFT_HAND,
        "has_sheet":  has_sheet,
    }


@app.get("/api/scores/{name}/sheet")
def get_sheet(name: str):
    path = os.path.join(SCORES_DIR, f"{name}.html")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No sheet music for this score")
    return FileResponse(path, media_type="text/html")


class ConvertRequest(BaseModel):
    corpus_path: str
    name: str


@app.post("/api/convert")
def convert_score(req: ConvertRequest):
    import re
    from music21 import corpus as m21corpus
    from music21 import converter, note, chord

    name = re.sub(r"[^a-zA-Z0-9_]+", "_", req.name).strip("_").lower()
    out_py   = os.path.join(SCORES_DIR, f"{name}.py")
    out_html = os.path.join(SCORES_DIR, f"{name}.html")

    try:
        mxl_path = str(m21corpus.getWork(req.corpus_path))
        score    = m21corpus.parse(req.corpus_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    def midi_pitch(element):
        if isinstance(element, note.Note):
            return element.pitch.midi
        if isinstance(element, chord.Chord):
            return max(n.pitch.midi for n in element.notes)
        return None

    right, left = [], []
    parts = score.parts
    if len(parts) < 1:
        raise HTTPException(status_code=400, detail="No parts found in score")

    for el in parts[0].flatten().notesAndRests:
        p = midi_pitch(el)
        if p is not None:
            right.append([p, float(el.offset)])

    if len(parts) >= 2:
        for el in parts[1].flatten().notesAndRests:
            if isinstance(el, note.Note):
                left.append([[el.pitch.midi], float(el.offset)])
            elif isinstance(el, chord.Chord):
                left.append([sorted(n.pitch.midi for n in el.notes), float(el.offset)])

    right.sort(key=lambda x: x[1])
    left.sort(key=lambda x: x[1])

    # Write .py
    lines = [
        f'# Auto-generated: {req.corpus_path}',
        f'RIGHT_HAND = {right!r}',
        f'LEFT_HAND  = {left!r}',
        f'LEFT_HAND.sort(key=lambda x: x[1])',
    ]
    with open(out_py, "w") as f:
        f.write("\n".join(lines) + "\n")

    # Write .html via verovio
    try:
        import verovio
        tk = verovio.toolkit()
        tk.setOptions({"pageWidth": 2100, "pageHeight": 2970,
                       "spacingSystem": 12, "adjustPageHeight": 0, "footer": "none"})
        tk.loadFile(mxl_path)
        svgs = [tk.renderToSVG(i + 1) for i in range(tk.getPageCount())]
        page_divs = "\n".join(f'<div class="page">{s}</div>' for s in svgs)
        html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{{margin:0;background:#eee}} .page{{background:white;width:210mm;margin:1rem auto;box-shadow:0 2px 6px rgba(0,0,0,.3)}} .page svg{{width:100%;height:auto;display:block}}
  @media print{{body{{background:white}} .page{{margin:0;box-shadow:none;width:100%}}}}
</style></head><body>{page_divs}</body></html>"""
        with open(out_html, "w") as f:
            f.write(html)
    except Exception:
        pass

    return {"name": name, "right_hand_notes": len(right),
            "left_hand_events": len(left), "has_sheet": os.path.exists(out_html)}


# Serve static files and fallback to index.html
app.mount("/", StaticFiles(directory="static", html=True), name="static")
