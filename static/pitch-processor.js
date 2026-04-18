/**
 * pitch-processor.js
 * AudioWorkletProcessor — runs entirely in the audio rendering thread.
 *
 * Algorithm:
 *   1. Accumulate 128-sample render quanta into a 2048-sample rolling window.
 *   2. Every PROCESS_INTERVAL (256) samples, run YIN + Goertzel octave check.
 *   3. Post to main thread: { type: 'note'|'silence'|'level'|'debug', ... }
 *   Receive from main thread: { type: 'threshold'|'expectedMidi', value }
 */

const MIN_FREQ  = 55;
const MAX_FREQ  = 1760;
const YIN_THRESHOLD      = 0.12;
const MIN_ACCEPTED_CLARITY = 0.40;
const STABLE_CENTS = 35;
const ANALYSIS_SIZE    = 2048;
const PROCESS_INTERVAL = 256;  // analysis every ~5.3 ms @ 48 kHz

const EXPECTED_NOTE_MATCH_BONUS  = 0.18;
const EXPECTED_NOTE_NEAR_BONUS   = 0.10;
const EXPECTED_NOTE_FAR_PENALTY  = 0.08;

function freqToMidi(f) { return Math.round(69 + 12 * Math.log2(f / 440)); }
function centsDiff(a, b) { return (a > 0 && b > 0) ? 1200 * Math.log2(a / b) : Infinity; }

/**
 * Goertzel DFT — amplitude of `freq` in `buf` at sample rate `sr`.
 * O(N): much cheaper than a full FFT for evaluating individual bins.
 */
function goertzelAmp(buf, freq, sr) {
  const N     = buf.length;
  const coeff = 2 * Math.cos(2 * Math.PI * freq * N / sr / N);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - s1 * s2 * coeff) / N;
}

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this._threshold    = opts.threshold ?? 0.01;
    this._expectedMidi = null;

    this._timeBuf = new Float32Array(ANALYSIS_SIZE);
    this._workBuf = new Float32Array(ANALYSIS_SIZE);
    this._diffBuf = new Float32Array(ANALYSIS_SIZE);
    this._cmndf   = new Float32Array(ANALYSIS_SIZE);

    this._accumulated  = 0;
    this._totalSamples = 0;

    // Silence gate
    this._silentFrames  = 0;
    this._silentThresh  = 2;
    this._wasJustSilent = true;

    // Stability (require one consistent frame before firing)
    this._candidateMidi  = -1;
    this._candidateFreq  = 0;
    this._stableCount    = 0;
    this._stableRequired = 1;

    // Dedup state
    this._lastMidi        = -1;
    this._lastFreq        = 0;
    this._lastNoteSamples = 0;

    // ── Cooldown constants ──────────────────────────────────────────────────
    // Cross-note cooldown: NONE. A different note fires as soon as it's stable.
    // Same-note cooldown: suppress re-fires of the same pitch within this window
    // UNLESS a new amplitude onset is detected (re-attack of the same key).
    this._sameCooldownSamples = Math.round(0.08 * sampleRate); // 80 ms

    this.port.onmessage = ({ data }) => {
      if (data.type === 'threshold')    this._threshold    = data.value;
      if (data.type === 'expectedMidi') this._expectedMidi = data.value;
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;

    this._pushChunk(ch);
    this._accumulated  += ch.length;
    this._totalSamples += ch.length;

    if (this._accumulated >= PROCESS_INTERVAL) {
      this._accumulated = 0;
      this._tick();
    }
    return true;
  }

  _pushChunk(chunk) {
    if (this._wasJustSilent) {
      // Zero-fill on onset so YIN doesn't see old silence mixed with new audio.
      this._timeBuf.fill(0);
      this._wasJustSilent = false;
    }
    if (chunk.length >= ANALYSIS_SIZE) {
      this._timeBuf.set(chunk.subarray(chunk.length - ANALYSIS_SIZE));
    } else {
      this._timeBuf.copyWithin(0, chunk.length);
      this._timeBuf.set(chunk, ANALYSIS_SIZE - chunk.length);
    }
  }

  _tick() {
    const rms = this._rms(this._timeBuf);
    this.port.postMessage({ type: 'level', rms });

    if (rms < this._threshold) {
      this._silentFrames++;
      if (this._silentFrames >= this._silentThresh) {
        const hadState = this._lastMidi !== -1 || this._candidateMidi !== -1;
        this._lastMidi = -1;  this._lastFreq = 0;
        this._candidateMidi = -1;  this._candidateFreq = 0;
        this._stableCount   = 0;
        this._wasJustSilent = true;
        if (hadState) this.port.postMessage({ type: 'silence' });
      }
      return;
    }
    this._silentFrames = 0;

    // ── Onset detection ─────────────────────────────────────────────────────
    // Compare the last 128-sample instant RMS to the full-buffer RMS.
    // A new note attack shows up as a short-term amplitude spike (>2× the
    // decaying average). When detected, reset same-note suppression so
    // repeated strikes of the same key are registered.
    const onset = this._detectOnset(rms);
    if (onset) {
      this._lastMidi = -1;
      this._lastFreq = 0;
      this._candidateMidi = -1;
      this._candidateFreq = 0;
      this._stableCount   = 0;
    }

    const result = this._detect();
    if (!result) return;

    const { freq, midi, clarity, yinClarity, goertzelScore } = result;

    this.port.postMessage({
      type: 'debug',
      text: `${this._noteName(midi)} ${freq.toFixed(1)}Hz `
          + `q:${clarity.toFixed(2)} y:${yinClarity.toFixed(2)} g:${goertzelScore.toFixed(4)}`,
    });

    if (clarity < MIN_ACCEPTED_CLARITY) return;
    if (midi < 24 || midi > 108) return;

    // Stability filter — require _stableRequired consecutive consistent frames.
    const matchesCandidate = (
      midi === this._candidateMidi &&
      this._candidateFreq > 0 &&
      Math.abs(centsDiff(freq, this._candidateFreq)) < STABLE_CENTS
    );
    if (matchesCandidate) {
      this._stableCount++;
      this._candidateFreq = this._candidateFreq * 0.65 + freq * 0.35;
    } else {
      this._candidateMidi = midi;
      this._candidateFreq = freq;
      this._stableCount   = 1;
    }
    if (this._stableCount < this._stableRequired) return;

    // ── Dedup ───────────────────────────────────────────────────────────────
    // Different note: fire immediately — no cross-note cooldown.
    //   (The stability filter already prevents spurious detections.)
    // Same note: only suppress within the cooldown window. After that window,
    //   the onset check above will have cleared _lastMidi if the key was
    //   re-attacked, so we won't double-fire on a sustained note.
    const elapsed    = this._totalSamples - this._lastNoteSamples;
    const sameAsLast = (
      midi === this._lastMidi &&
      this._lastFreq > 0 &&
      Math.abs(centsDiff(freq, this._lastFreq)) < STABLE_CENTS
    );
    if (sameAsLast && elapsed < this._sameCooldownSamples) return;

    this._lastMidi        = midi;
    this._lastFreq        = freq;
    this._lastNoteSamples = this._totalSamples;

    this.port.postMessage({ type: 'note', midi, freq, clarity, yin: yinClarity, goertzel: goertzelScore });
  }

  _detect() {
    const windowed = this._window(this._timeBuf);
    const yin = this._yin(windowed);
    if (!yin || yin.clarity < 0.30) return null;

    // ── Octave disambiguation via relative Goertzel amplitudes ──────────────
    // Evaluate {freq/2, freq, freq×2} — whichever has the highest raw amplitude
    // is the true fundamental. This is scale-independent: we only compare the
    // three candidates against each other, so absolute mic volume doesn't matter.
    //
    // Typical errors YIN makes:
    //   ×½ (detects 2nd harmonic instead of fundamental)
    //   ×2 (detects sub-octave due to strong even harmonics in piano timbre)
    const opts = [yin.freq / 2, yin.freq, yin.freq * 2]
      .filter(f => f >= MIN_FREQ && f <= MAX_FREQ)
      .map(f => ({ f, amp: goertzelAmp(windowed, f, sampleRate), midi: freqToMidi(f) }));

    const maxAmp = Math.max(...opts.map(o => o.amp));

    let best = null;
    for (const o of opts) {
      // Score = relative amplitude share + expected-note bias.
      // Multiplying by a constant doesn't change ordering, so we use raw amp.
      let score = o.amp;
      if (this._expectedMidi !== null) {
        const d = Math.abs(o.midi - this._expectedMidi);
        // Bias proportional to the amplitude range so the nudge is meaningful
        // regardless of overall signal level.
        if (d <= 1) score += maxAmp * 0.55;
        else if (d <= 3) score += maxAmp * 0.18;
        else if (d >= 7) score -= maxAmp * 0.28;
      }
      if (!best || score > best.score) best = { ...o, score };
    }

    // ── Confidence ──────────────────────────────────────────────────────────
    // Primary metric: YIN CMNDF clarity (already in [0,1], scale-independent).
    // Apply expected-note bonus/penalty to the final clarity.
    let clarity = yin.clarity;
    if (this._expectedMidi !== null) {
      const d = Math.abs(best.midi - this._expectedMidi);
      if (d <= 1) clarity = Math.min(1, clarity + EXPECTED_NOTE_MATCH_BONUS);
      else if (d <= 3) clarity = Math.min(1, clarity + EXPECTED_NOTE_NEAR_BONUS);
      else if (d >= 7) clarity = Math.max(0, clarity - EXPECTED_NOTE_FAR_PENALTY);
    }

    if (clarity < MIN_ACCEPTED_CLARITY) return null;
    return {
      freq: best.f,
      midi: best.midi,
      clarity,
      yinClarity: yin.clarity,
      goertzelScore: best.amp,
    };
  }

  /** CMNDF-YIN period estimator. Returns { freq, clarity } or null. */
  _yin(buf) {
    const n    = buf.length;
    const sr   = sampleRate;
    const tMin = Math.max(2, Math.floor(sr / MAX_FREQ));
    const tMax = Math.min(Math.floor(sr / MIN_FREQ), n - 2);
    if (tMax <= tMin) return null;

    this._cmndf[0] = 1;
    let runSum = 0;
    for (let tau = tMin; tau <= tMax; tau++) {
      let d = 0;
      for (let i = 0; i < n - tau; i++) {
        const delta = buf[i] - buf[i + tau];
        d += delta * delta;
      }
      this._diffBuf[tau] = d;
      runSum += d;
      this._cmndf[tau] = runSum > 0 ? (d * tau) / runSum : 1;
    }

    let bestTau = -1;
    for (let tau = tMin + 1; tau < tMax; tau++) {
      const v = this._cmndf[tau];
      if (v < YIN_THRESHOLD && v <= this._cmndf[tau - 1] && v < this._cmndf[tau + 1]) {
        bestTau = tau; break;
      }
    }
    if (bestTau === -1) {
      let bv = Infinity;
      for (let tau = tMin; tau <= tMax; tau++) {
        if (this._cmndf[tau] < bv) { bv = this._cmndf[tau]; bestTau = tau; }
      }
      if (bestTau === -1 || this._cmndf[bestTau] > 0.35) return null;
    }

    const refined = this._parabolicInterp(this._cmndf, bestTau, false);
    if (!Number.isFinite(refined) || refined <= 0) return null;
    return { freq: sr / refined, clarity: 1 - Math.min(1, this._cmndf[bestTau]) };
  }

  /** Hann window + DC removal. Writes _workBuf in place and returns it. */
  _window(input) {
    let mean = 0;
    for (let i = 0; i < input.length; i++) mean += input[i];
    mean /= input.length;
    const N = input.length - 1;
    for (let i = 0; i < input.length; i++) {
      this._workBuf[i] = (input[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    }
    return this._workBuf;
  }

  _parabolicInterp(vals, idx, isMax) {
    const l = vals[idx - 1] ?? vals[idx];
    const m = vals[idx];
    const r = vals[idx + 1] ?? vals[idx];
    const d = l - 2 * m + r;
    if (Math.abs(d) < 1e-9) return idx;
    if (!isMax && d < 0) return idx;
    if ( isMax && d > 0) return idx;
    return idx + Math.max(-1, Math.min(1, 0.5 * (l - r) / d));
  }

  /**
   * Onset detector — compares the last 128-sample instant RMS against the
   * full-buffer RMS. A new piano attack shows up as a short amplitude spike.
   * The ratio threshold of 2.0 avoids triggering on gradual crescendos or
   * vibrato while catching the sharp percussive attack of a piano key.
   */
  _detectOnset(fullRms) {
    if (fullRms < this._threshold * 2) return false;  // too quiet to matter
    let s = 0;
    for (let i = ANALYSIS_SIZE - 128; i < ANALYSIS_SIZE; i++) s += this._timeBuf[i] ** 2;
    const instantRms = Math.sqrt(s / 128);
    return instantRms > fullRms * 2.0;
  }

  _rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  _noteName(midi) {
    return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][midi % 12]
         + (Math.floor(midi / 12) - 1);
  }
}

registerProcessor('pitch-processor', PitchProcessor);
