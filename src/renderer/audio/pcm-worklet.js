// AudioWorkletProcessor that downsamples microphone input to 16 kHz mono
// Int16 PCM and posts fixed-size frames to the main thread. Authored as a
// classic worklet module (runs in AudioWorkletGlobalScope, no imports, not part
// of the TS module graph). Loaded via `audioWorklet.addModule(new URL(...))` in
// audio-capture.ts; Vite emits it as a separate hashed asset that resolves in
// both dev and the packaged build.
//
// The capture AudioContext requests 16 kHz, but some OS/driver stacks force a
// higher rate (commonly 48 kHz), so this processor resamples from whatever the
// real `sampleRate` is down to 16 kHz with linear interpolation. Speech is
// narrowband, so linear interpolation is more than adequate.

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TARGET_SAMPLE_RATE = 16000;
// 20 ms frame at 16 kHz = 320 samples (~640 bytes). Small enough that backpressure
// is a non-issue; large enough to avoid IPC chatter.
const FRAME_SAMPLES = 320;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples consumed per output sample (>= 1 when downsampling).
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameIndex = 0;
    // Fractional read position within the current input block.
    this.readPosition = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    for (; this.readPosition < channel.length; this.readPosition += this.ratio) {
      const baseIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - baseIndex;
      const sample0 = channel[baseIndex];
      const sample1 = baseIndex + 1 < channel.length ? channel[baseIndex + 1] : sample0;
      const interpolated = sample0 + (sample1 - sample0) * fraction;

      const clamped = interpolated < -1 ? -1 : interpolated > 1 ? 1 : interpolated;
      this.frame[this.frameIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.frameIndex += 1;

      if (this.frameIndex === FRAME_SAMPLES) {
        // Copy so our working buffer keeps living; transfer the copy's buffer.
        const out = this.frame.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.frameIndex = 0;
      }
    }

    // Carry the fractional remainder into the next block so resampling is
    // continuous across block boundaries.
    this.readPosition -= channel.length;
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
