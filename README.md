# accompy

A real-time piano accompanist. You play the right-hand melody — accompy follows your tempo and plays the left hand automatically.

## How it works

Play the right-hand melody note by note. As you play, accompy:
- Tracks your position in the score and estimates your tempo using a moving average
- Plays the left-hand accompaniment continuously between your notes at the current tempo
- Pauses the left hand right before your next melody note and waits for you to play it
- Resyncs and adapts when you speed up, slow down, or hesitate

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install rtmidi numpy sounddevice music21
```

## Playing

**Computer keyboard:**
```bash
python main.py --keyboard --score twinkle
```

**MIDI keyboard (e.g. Yamaha P-71 via USB):**
```bash
python main.py --score mozart_k545
```

You'll be prompted for a starting BPM before the piece begins.

### Keyboard layout (3 octaves of white keys)

```
Low  (C3–B3):  z x c v b n m
Mid  (C4–B4):  a s d f g h j
High (C5–B5):  q w e r t y u   i = C6
```

## Scores

List available scores:
```bash
python main.py --list
```

See the notes and keyboard keys for a score:
```bash
python convert_score.py --show twinkle
python convert_score.py --show mozart_k545
```

## Adding new pieces

Pieces are stored as Python files in the `scores/` folder. Convert any MusicXML file or use the built-in music21 corpus:

```bash
# From the built-in corpus (no download needed)
python convert_score.py corpus:mozart/k545/movement1_exposition --name mozart_k545
python convert_score.py corpus:bach/bwv1.6 --name bach_bwv1

# From a downloaded MusicXML file
python convert_score.py ~/Downloads/mysong.mxl --name mysong
```

Sources for free MusicXML files:
- **music21 corpus** — included, no download needed (`corpus:composer/piece`)
- **IMSLP** — [imslp.org](https://imslp.org), public domain scores with MusicXML downloads
- **Flat.io** — free online score editor with MusicXML export

## Project structure

```
main.py            # Entry point — handles input (keyboard or MIDI) and score selection
tracker.py         # Tracks position in the score and estimates tempo
accompanist.py     # Left-hand scheduler — follows tempo clock, waits at sync points
synth.py           # Software synthesizer — mixes voices into a single audio stream
score.py           # Legacy score file (kept for compatibility)
convert_score.py   # Converts MusicXML to a scores/*.py file
scores/            # Saved pieces (one .py file per piece)
```
