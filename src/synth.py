"""
Software synthesizer with instrument presets.
All voices mix in a single OutputStream callback — no conflicting sd.play() calls.

Supported instruments:
  piano, violin, viola, cello, strings,
  flute, clarinet, oboe
"""

import threading
import numpy as np
import sounddevice as sd

SAMPLE_RATE = 44100
BLOCK_SIZE  = 256   # ~5.8 ms latency


def midi_to_hz(pitch: int) -> float:
    return 440.0 * (2.0 ** ((pitch - 69) / 12.0))


def _render_note(pitch: int, velocity: int, instrument: str = "piano") -> np.ndarray:
    hz  = midi_to_hz(pitch)
    amp = (velocity / 127.0) * 0.35
    instr = instrument.lower()

    if instr in ("violin", "viola"):
        return _render_strings(hz, amp, duration=1.5, brightness=1.0)
    elif instr == "cello":
        return _render_strings(hz, amp, duration=1.8, brightness=0.7)
    elif instr in ("strings", "string ensemble"):
        return _render_strings(hz, amp * 0.8, duration=1.8, brightness=0.8)
    elif instr == "flute":
        return _render_flute(hz, amp, duration=1.4)
    elif instr == "clarinet":
        return _render_clarinet(hz, amp, duration=1.4)
    elif instr == "oboe":
        return _render_oboe(hz, amp, duration=1.3)
    else:
        return _render_piano(hz, amp)


def _render_piano(hz: float, amp: float) -> np.ndarray:
    duration = 1.2
    n = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n, endpoint=False)
    wave = (
        np.sin(2 * np.pi * hz * t) * 0.7
        + np.sin(2 * np.pi * hz * 2 * t) * 0.2
        + np.sin(2 * np.pi * hz * 3 * t) * 0.1
    )
    attack = int(SAMPLE_RATE * 0.008)
    env = np.exp(-3.5 * t)
    env[:attack] = np.linspace(0, 1, attack)
    return (wave * env * amp).astype(np.float32)


def _render_strings(hz: float, amp: float, duration: float, brightness: float) -> np.ndarray:
    """Bowed string sound: sawtooth-like harmonics, slow attack, vibrato."""
    n = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n, endpoint=False)

    # Sawtooth approximation via harmonics (more = brighter)
    harmonics = 8
    wave = np.zeros(n)
    for k in range(1, harmonics + 1):
        wave += (np.sin(2 * np.pi * hz * k * t) / k) * (brightness ** (k - 1))

    # Vibrato: ~6 Hz, 0.3% depth
    vibrato = 1.0 + 0.003 * np.sin(2 * np.pi * 6.0 * t)
    wave_v = np.zeros(n)
    for k in range(1, harmonics + 1):
        wave_v += (np.sin(2 * np.pi * hz * k * vibrato * t) / k) * (brightness ** (k - 1))
    # Blend in vibrato after attack
    vib_onset = int(SAMPLE_RATE * 0.15)
    blend = np.zeros(n)
    blend[vib_onset:] = np.linspace(0, 1, n - vib_onset)
    wave = wave * (1 - blend) + wave_v * blend

    # Envelope: slow bow attack, long sustain, short release
    attack_s  = int(SAMPLE_RATE * 0.06)
    release_s = int(SAMPLE_RATE * 0.2)
    env = np.ones(n)
    env[:attack_s]  = np.linspace(0, 1, attack_s)
    env[-release_s:] = np.linspace(1, 0, release_s)

    return (wave * env * amp * 0.3).astype(np.float32)


def _render_flute(hz: float, amp: float, duration: float) -> np.ndarray:
    """Flute: mostly sine with a touch of breathiness (noise), soft attack."""
    n = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n, endpoint=False)

    wave = (
        np.sin(2 * np.pi * hz * t) * 0.85
        + np.sin(2 * np.pi * hz * 2 * t) * 0.12
        + np.sin(2 * np.pi * hz * 3 * t) * 0.03
    )
    # Breath noise: band-pass-ish via filtered white noise
    noise = np.random.randn(n) * 0.04
    wave = wave + noise

    attack_s  = int(SAMPLE_RATE * 0.04)
    release_s = int(SAMPLE_RATE * 0.15)
    env = np.ones(n)
    env[:attack_s]   = np.linspace(0, 1, attack_s)
    env[-release_s:] = np.linspace(1, 0, release_s)
    env *= np.exp(-0.4 * t)

    return (wave * env * amp * 0.8).astype(np.float32)


def _render_clarinet(hz: float, amp: float, duration: float) -> np.ndarray:
    """Clarinet: odd harmonics dominant (cylindrical bore characteristic)."""
    n = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n, endpoint=False)

    wave = (
        np.sin(2 * np.pi * hz * t) * 0.7       # 1st
        + np.sin(2 * np.pi * hz * 3 * t) * 0.25  # 3rd
        + np.sin(2 * np.pi * hz * 5 * t) * 0.08  # 5th
        + np.sin(2 * np.pi * hz * 7 * t) * 0.03  # 7th
    )

    attack_s  = int(SAMPLE_RATE * 0.025)
    release_s = int(SAMPLE_RATE * 0.12)
    env = np.ones(n)
    env[:attack_s]   = np.linspace(0, 1, attack_s)
    env[-release_s:] = np.linspace(1, 0, release_s)
    env *= np.exp(-0.5 * t)

    return (wave * env * amp * 0.6).astype(np.float32)


def _render_oboe(hz: float, amp: float, duration: float) -> np.ndarray:
    """Oboe: nasal, rich in harmonics, reedy tone."""
    n = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n, endpoint=False)

    wave = (
        np.sin(2 * np.pi * hz * t) * 0.5
        + np.sin(2 * np.pi * hz * 2 * t) * 0.3
        + np.sin(2 * np.pi * hz * 3 * t) * 0.15
        + np.sin(2 * np.pi * hz * 4 * t) * 0.05
    )

    attack_s  = int(SAMPLE_RATE * 0.02)
    release_s = int(SAMPLE_RATE * 0.1)
    env = np.ones(n)
    env[:attack_s]   = np.linspace(0, 1, attack_s)
    env[-release_s:] = np.linspace(1, 0, release_s)
    env *= np.exp(-0.6 * t)

    return (wave * env * amp * 0.65).astype(np.float32)


# ── Mixer ──────────────────────────────────────────────────────────────────────
_voices: list[list] = []
_lock   = threading.Lock()


def _callback(outdata, frames, time_info, status):
    mixed = np.zeros(frames, dtype=np.float32)
    with _lock:
        alive = []
        for voice in _voices:
            samples, pos = voice
            remaining = len(samples) - pos
            if remaining <= 0:
                continue
            n = min(frames, remaining)
            mixed[:n] += samples[pos : pos + n]
            voice[1] = pos + n
            if voice[1] < len(samples):
                alive.append(voice)
        _voices[:] = alive

    peak = np.max(np.abs(mixed))
    if peak > 1.0:
        mixed /= peak
    outdata[:, 0] = mixed


_stream = sd.OutputStream(
    samplerate=SAMPLE_RATE,
    channels=1,
    dtype="float32",
    blocksize=BLOCK_SIZE,
    callback=_callback,
)
_stream.start()


# ── Public API ─────────────────────────────────────────────────────────────────

def play_note(pitch: int, velocity: int = 80, instrument: str = "piano"):
    samples = _render_note(pitch, velocity, instrument)
    with _lock:
        _voices.append([samples, 0])


def play_chord(pitches: list, velocity: int = 64, instrument: str = "piano"):
    if not pitches:
        return
    for pitch in pitches:
        samples = _render_note(pitch, velocity, instrument)
        with _lock:
            _voices.append([samples, 0])
