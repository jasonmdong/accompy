/**
 * Real-time piano-oriented pitch detector.
 *
 * The detector blends:
 *   - a YIN-style time-domain period estimate for precise frequency tracking
 *   - live FFT harmonic scoring to reject piano overtones and octave errors
 *
 * Usage:
 *   const det = new PitchDetector(audioCtx, { onNote, onSilence });
 *   det.start();
 *   det.stop();
 *   det.setThreshold(0.01);
 */

const MIN_FREQ = 55;
const MAX_FREQ = 1760;
const YIN_THRESHOLD = 0.12;
const MIN_ACCEPTED_CLARITY = 0.42;
const FAST_ACCEPT_CLARITY = 0.64;
const MERGE_CANDIDATE_CENTS = 30;
const STABLE_CENTS = 35;
const EXPECTED_NOTE_MATCH_BONUS = 0.18;
const EXPECTED_NOTE_NEAR_BONUS = 0.10;
const EXPECTED_NOTE_FAR_PENALTY = 0.08;

class PitchDetector {
  constructor(ctx, {
    onNote,
    onSilence,
    onLevel,
    onDebug,
    threshold = 0.01,
    bufSize = 1024,
    analysisSize = 2048,
    fftSize = 4096,
    deviceId = null,
  } = {}) {
    this._ctx          = ctx;
    this._onNote       = onNote    || (() => {});
    this._onSilence    = onSilence || (() => {});
    this._onLevel      = onLevel   || (() => {});
    this._onDebug      = onDebug   || null;
    this._threshold    = threshold;
    this._bufSize      = bufSize;
    this._analysisSize = analysisSize;
    this._fftSize      = fftSize;
    this._deviceId     = deviceId;

    this._stream       = null;
    this._source       = null;
    this._analyser     = null;
    this._scriptNode   = null;
    this._silentSink   = null;
    this._freqBuf      = null;
    this._running      = false;

    this._timeBuf      = new Float32Array(this._analysisSize);
    this._workBuf      = new Float32Array(this._analysisSize);
    this._diffBuf      = new Float32Array(this._analysisSize);
    this._cmndfBuf     = new Float32Array(this._analysisSize);

    this._lastMidi       = -1;
    this._lastFreq       = 0;
    this._lastDebugText  = '—';
    this._candidateMidi  = -1;
    this._candidateFreq  = 0;
    this._stableCount    = 0;
    this._stableRequired = 2;
    this._silentFrames   = 0;
    this._silentThresh   = 2;
    this._lastNoteTime   = 0;
    this._noteCooldownMs = 90;
    this._onsetFrames    = 0;
    this._onsetSkip      = 0;
    this._expectedMidi   = null;
  }

  setThreshold(v) {
    this._threshold = v;
  }

  setExpectedMidi(midi) {
    this._expectedMidi = Number.isFinite(midi) ? midi : null;
  }

  async start() {
    if (this._running) return;
    try {
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(this._deviceId ? { deviceId: { exact: this._deviceId } } : {}),
      };
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (e) {
      throw new Error('Microphone access denied: ' + e.message);
    }

    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = this._fftSize;
    this._analyser.minDecibels = -100;
    this._analyser.maxDecibels = -10;
    this._analyser.smoothingTimeConstant = 0;

    this._scriptNode = this._ctx.createScriptProcessor(this._bufSize, 1, 1);
    this._freqBuf = new Float32Array(this._analyser.frequencyBinCount);
    this._silentSink = this._ctx.createGain();
    this._silentSink.gain.value = 0;

    this._scriptNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this._pushChunk(input);
      this._analyser.getFloatFrequencyData(this._freqBuf);
      this._process(this._timeBuf, this._freqBuf);
    };

    this._source.connect(this._analyser);
    this._analyser.connect(this._scriptNode);
    this._scriptNode.connect(this._silentSink);
    this._silentSink.connect(this._ctx.destination);
    this._running = true;
  }

  stop() {
    if (!this._running) return;
    this._scriptNode?.disconnect();
    this._analyser?.disconnect();
    this._source?.disconnect();
    this._silentSink?.disconnect();
    this._stream?.getTracks().forEach(track => track.stop());
    this._running = false;
  }

  _pushChunk(chunk) {
    if (chunk.length >= this._analysisSize) {
      this._timeBuf.set(chunk.subarray(chunk.length - this._analysisSize));
      return;
    }
    this._timeBuf.copyWithin(0, chunk.length);
    this._timeBuf.set(chunk, this._analysisSize - chunk.length);
  }

  _process(buf, freqData) {
    const rms = this._rms(buf);
    this._onLevel(rms);

    if (rms < this._threshold) {
      this._silentFrames++;
      if (this._silentFrames >= this._silentThresh) {
        const hadState = this._lastMidi !== -1 || this._candidateMidi !== -1;
        this._lastMidi = -1;
        this._lastFreq = 0;
        this._candidateMidi = -1;
        this._candidateFreq = 0;
        this._stableCount = 0;
        if (hadState) this._onSilence();
        this._onsetFrames = 0;
      }
      return;
    }

    if (this._silentFrames >= this._silentThresh || this._onsetFrames < this._onsetSkip) {
      this._onsetFrames++;
      this._silentFrames = 0;
      return;
    }
    this._silentFrames = 0;

    const result = this._detectPitch(buf, freqData);
    if (!result) {
      this._onDebug?.(this._lastDebugText);
      return;
    }

    const { freq, midi, clarity, yinClarity, fftConfidence } = result;
    this._lastDebugText =
      `${pitchName(midi)} ${freq.toFixed(1)}Hz q:${clarity.toFixed(2)} y:${yinClarity.toFixed(2)} fft:${fftConfidence.toFixed(2)}`;
    this._onDebug?.(this._lastDebugText);

    if (clarity < MIN_ACCEPTED_CLARITY) return;
    if (midi < 24 || midi > 108) return;

    const stablePitch = (
      midi === this._candidateMidi &&
      this._candidateFreq > 0 &&
      Math.abs(this._centsDiff(freq, this._candidateFreq)) < STABLE_CENTS
    );

    if (stablePitch) {
      this._stableCount++;
      this._candidateFreq = this._candidateFreq * 0.65 + freq * 0.35;
    } else {
      this._candidateMidi = midi;
      this._candidateFreq = freq;
      this._stableCount = 1;
    }

    const requiredStable = clarity >= FAST_ACCEPT_CLARITY ? 1 : this._stableRequired;
    if (this._stableCount < requiredStable) return;

    const now = performance.now();
    const repeatedSameNote = (
      midi === this._lastMidi &&
      this._lastFreq > 0 &&
      Math.abs(this._centsDiff(freq, this._lastFreq)) < STABLE_CENTS
    );
    if (repeatedSameNote) return;
    if (now - this._lastNoteTime < this._noteCooldownMs) return;

    this._lastMidi = midi;
    this._lastFreq = freq;
    this._lastNoteTime = now;
    this._onNote(midi, { freq, clarity, yin: yinClarity, spectral: fftConfidence, rms });
  }

  _detectPitch(input, freqData) {
    const prepared = this._prepareBuffer(input);
    const yin = this._yin(prepared);
    const fft = this._spectralFundamental(freqData);

    if (!yin && !fft) return null;

    if (yin && fft && Math.abs(this._centsDiff(yin.freq, fft.freq)) < 35) {
      const freq = yin.freq * 0.72 + fft.freq * 0.28;
      const clarity = Math.min(
        1,
        this._candidateSpectrumScore(freq, freqData) * 0.45 +
        yin.clarity * 0.35 +
        fft.confidence * 0.20
      );
      return {
        freq,
        midi: this._freqToMidi(freq),
        clarity,
        yinClarity: yin.clarity,
        fftConfidence: fft.confidence,
      };
    }

    const candidates = [];
    const addCandidate = (freq) => {
      if (!Number.isFinite(freq) || freq < MIN_FREQ || freq > MAX_FREQ) return;
      for (const existing of candidates) {
        if (Math.abs(this._centsDiff(freq, existing)) < MERGE_CANDIDATE_CENTS) return;
      }
      candidates.push(freq);
    };

    if (yin) {
      addCandidate(yin.freq);
      addCandidate(yin.freq / 2);
      addCandidate(yin.freq * 2);
    }
    if (fft) {
      addCandidate(fft.freq);
      addCandidate(fft.freq / 2);
      addCandidate(fft.freq * 2);
    }

    let best = null;
    for (const freq of candidates) {
      const spectralScore = this._candidateSpectrumScore(freq, freqData);
      let score = spectralScore * 0.58;
      const midi = this._freqToMidi(freq);

      if (yin) {
        const cents = Math.abs(this._centsDiff(freq, yin.freq));
        if (cents < 35) score += yin.clarity * 0.30;
        else if (Math.abs(cents - 1200) < 45) score += yin.clarity * (freq < yin.freq ? 0.22 : 0.10);
      }

      if (fft) {
        const cents = Math.abs(this._centsDiff(freq, fft.freq));
        if (cents < 35) score += fft.confidence * 0.22;
        else if (Math.abs(cents - 1200) < 45) score += fft.confidence * (freq < fft.freq ? 0.12 : 0.05);
      }

      if (this._expectedMidi !== null) {
        const distance = Math.abs(midi - this._expectedMidi);
        if (distance <= 1) score += EXPECTED_NOTE_MATCH_BONUS;
        else if (distance <= 3) score += EXPECTED_NOTE_NEAR_BONUS;
        else if (distance >= 7) score -= EXPECTED_NOTE_FAR_PENALTY;
      }

      if (!best || score > best.score) {
        best = { freq, midi, score, spectralScore };
      }
    }

    if (!best || best.score < MIN_ACCEPTED_CLARITY) return null;

    return {
      freq: best.freq,
      midi: best.midi,
      clarity: Math.min(1, best.score),
      yinClarity: yin?.clarity ?? 0,
      fftConfidence: fft?.confidence ?? 0,
    };
  }

  _prepareBuffer(input) {
    let mean = 0;
    for (let i = 0; i < input.length; i++) mean += input[i];
    mean /= input.length;

    const denom = Math.max(1, input.length - 1);
    for (let i = 0; i < input.length; i++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
      this._workBuf[i] = (input[i] - mean) * window;
    }
    return this._workBuf;
  }

  _yin(buf) {
    const n = buf.length;
    const sampleRate = this._ctx.sampleRate;
    const tauMin = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const tauMax = Math.min(Math.floor(sampleRate / MIN_FREQ), n - 2);
    if (tauMax <= tauMin) return null;

    this._cmndfBuf[0] = 1;
    let runningSum = 0;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let diff = 0;
      for (let i = 0; i < n - tau; i++) {
        const delta = buf[i] - buf[i + tau];
        diff += delta * delta;
      }
      this._diffBuf[tau] = diff;
      runningSum += diff;
      this._cmndfBuf[tau] = runningSum > 0 ? (diff * tau) / runningSum : 1;
    }

    let bestTau = -1;
    for (let tau = tauMin + 1; tau < tauMax; tau++) {
      const value = this._cmndfBuf[tau];
      if (
        value < YIN_THRESHOLD &&
        value <= this._cmndfBuf[tau - 1] &&
        value < this._cmndfBuf[tau + 1]
      ) {
        bestTau = tau;
        break;
      }
    }

    if (bestTau === -1) {
      let bestValue = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (this._cmndfBuf[tau] < bestValue) {
          bestValue = this._cmndfBuf[tau];
          bestTau = tau;
        }
      }
      if (bestTau === -1 || this._cmndfBuf[bestTau] > 0.35) return null;
    }

    const refinedTau = this._refineExtremum(this._cmndfBuf, bestTau, false);
    if (!Number.isFinite(refinedTau) || refinedTau <= 0) return null;

    return {
      freq: sampleRate / refinedTau,
      clarity: 1 - Math.min(1, this._cmndfBuf[bestTau]),
    };
  }

  _spectralFundamental(freqData) {
    const binHz = this._ctx.sampleRate / this._fftSize;
    const minBin = Math.max(2, Math.ceil(MIN_FREQ / binHz));
    const maxBin = Math.min(Math.floor(MAX_FREQ / binHz), freqData.length - 2);

    let bestBin = -1;
    let bestScore = -Infinity;
    let secondScore = -Infinity;

    for (let bin = minBin; bin <= maxBin; bin++) {
      const score = this._candidateSpectrumScore(bin * binHz, freqData);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestBin = bin;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    if (bestBin === -1 || bestScore < 0.34) return null;

    const refinedBin = this._refineExtremum(freqData, bestBin, true);
    const confidence = Math.max(
      0,
      Math.min(1, bestScore * 0.75 + Math.max(0, bestScore - secondScore) * 0.90)
    );

    return {
      freq: refinedBin * binHz,
      confidence,
    };
  }

  _candidateSpectrumScore(freq, freqData) {
    const harmonicWeights = [1.8, 1.0, 0.72, 0.52, 0.38];
    const nyquist = this._ctx.sampleRate / 2;

    let harmonicSum = 0;
    let weightSum = 0;
    let fundamental = 0;

    for (let harmonic = 1; harmonic <= harmonicWeights.length; harmonic++) {
      const harmonicFreq = freq * harmonic;
      if (harmonicFreq >= nyquist) break;
      const amp = this._dbToUnit(this._peakDbAt(harmonicFreq, freqData, harmonic === 1 ? 2 : 1));
      const weight = harmonicWeights[harmonic - 1];
      harmonicSum += amp * weight;
      weightSum += weight;
      if (harmonic === 1) fundamental = amp;
    }

    if (!weightSum) return 0;

    const average = harmonicSum / weightSum;
    const subharmonic = freq / 2 >= MIN_FREQ
      ? this._dbToUnit(this._peakDbAt(freq / 2, freqData, 1))
      : 0;

    return Math.max(0, Math.min(1, average * 0.60 + fundamental * 0.40 - subharmonic * 0.12));
  }

  _peakDbAt(freq, freqData, radius = 1) {
    const binHz = this._ctx.sampleRate / this._fftSize;
    const center = Math.round(freq / binHz);
    let best = -120;
    for (let offset = -radius; offset <= radius; offset++) {
      const idx = center + offset;
      if (idx > 0 && idx < freqData.length) best = Math.max(best, freqData[idx]);
    }
    return best;
  }

  _dbToUnit(db) {
    return Math.max(0, Math.min(1, (db + 100) / 90));
  }

  _refineExtremum(values, index, isMaximum) {
    const left = values[index - 1] ?? values[index];
    const mid = values[index];
    const right = values[index + 1] ?? values[index];
    const denom = left - 2 * mid + right;
    if (Math.abs(denom) < 1e-9) return index;

    let delta = 0.5 * (left - right) / denom;
    if (!isMaximum && denom < 0) return index;
    if (isMaximum && denom > 0) return index;
    delta = Math.max(-1, Math.min(1, delta));
    return index + delta;
  }

  _rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  _freqToMidi(freq) {
    return Math.round(69 + 12 * Math.log2(freq / 440));
  }

  _centsDiff(a, b) {
    if (a <= 0 || b <= 0) return Infinity;
    return 1200 * Math.log2(a / b);
  }
}
