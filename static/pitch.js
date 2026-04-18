/**
 * pitch.js
 * PitchDetector — thin wrapper around the pitch-processor AudioWorklet.
 *
 * All signal processing runs in the audio rendering thread (pitch-processor.js),
 * not the main JS thread. This eliminates DOM/GC jank from the detection path
 * and cuts latency significantly vs. the old ScriptProcessor implementation.
 *
 * Public API (unchanged):
 *   const det = new PitchDetector(audioCtx, { onNote, onSilence });
 *   await det.start();
 *   det.stop();
 *   det.setThreshold(0.01);
 *   det.setExpectedMidi(60);
 */

// Guard against calling addModule more than once per AudioContext lifetime.
// (registerProcessor throws NotSupportedError on the second registration.)
let _workletLoaded = false;

class PitchDetector {
  constructor(ctx, {
    onNote    = () => {},
    onSilence = () => {},
    onLevel   = () => {},
    onDebug   = null,
    threshold = 0.01,
    deviceId  = null,
  } = {}) {
    this._ctx       = ctx;
    this._onNote    = onNote;
    this._onSilence = onSilence;
    this._onLevel   = onLevel;
    this._onDebug   = onDebug;
    this._threshold = threshold;
    this._deviceId  = deviceId;

    this._stream      = null;
    this._source      = null;
    this._workletNode = null;
    this._running     = false;
  }

  setThreshold(v) {
    this._threshold = v;
    this._workletNode?.port.postMessage({ type: 'threshold', value: v });
  }

  setExpectedMidi(midi) {
    this._workletNode?.port.postMessage({
      type: 'expectedMidi',
      value: Number.isFinite(midi) ? midi : null,
    });
  }

  async start() {
    if (this._running) return;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(this._deviceId ? { deviceId: { exact: this._deviceId } } : {}),
        },
      });
    } catch (e) {
      throw new Error('Microphone access denied: ' + e.message);
    }

    if (!_workletLoaded) {
      await this._ctx.audioWorklet.addModule('pitch-processor.js');
      _workletLoaded = true;
    }

    this._workletNode = new AudioWorkletNode(this._ctx, 'pitch-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 0,   // analysis only — no audio output needed
      processorOptions: { threshold: this._threshold },
    });

    this._workletNode.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'note':    this._onNote(data.midi, data); break;
        case 'silence': this._onSilence(); break;
        case 'level':   this._onLevel(data.rms); break;
        case 'debug':   this._onDebug?.(data.text); break;
      }
    };

    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._source.connect(this._workletNode);
    this._running = true;
  }

  stop() {
    if (!this._running) return;
    this._workletNode?.disconnect();
    this._source?.disconnect();
    this._stream?.getTracks().forEach(t => t.stop());
    this._workletNode = null;
    this._source      = null;
    this._stream      = null;
    this._running     = false;
  }
}
