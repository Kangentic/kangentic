/**
 * Microphone capture for voice dictation (renderer, greenfield). Opens the mic
 * via `getUserMedia`, runs it through an `AudioWorklet` that downsamples to
 * 16 kHz mono Int16 PCM, and hands each frame to `onFrame`. The caller streams
 * frames to the main-process transcription funnel. Fully torn down on `stop()`.
 */

// `?raw` inlines the worklet source as a string; we register it via a Blob URL.
// This avoids both the data-URL-worklet pitfalls of small `?url` assets and any
// packaged file-path resolution issues, and works identically in dev and prod.
// The processor runs in AudioWorkletGlobalScope and is never part of the module graph.
import workletSource from './pcm-worklet.js?raw';

const WORKLET_PROCESSOR_NAME = 'pcm-downsampler';

export interface AudioCaptureHandle {
  stop: () => void;
}

export async function startAudioCapture(
  onFrame: (pcm: ArrayBuffer) => void,
): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Request 16 kHz; the worklet resamples if the platform forces a higher rate.
  const audioContext = new AudioContext({ sampleRate: 16000 });

  const workletBlobUrl = URL.createObjectURL(
    new Blob([workletSource], { type: 'application/javascript' }),
  );
  try {
    await audioContext.audioWorklet.addModule(workletBlobUrl);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
    throw error;
  } finally {
    URL.revokeObjectURL(workletBlobUrl);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME);
  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    onFrame(event.data);
  };

  // source -> worklet -> destination. The processor writes nothing to its
  // output, so the destination renders silence (no mic echo); routing to the
  // destination keeps the graph pulled so `process()` runs.
  source.connect(workletNode);
  workletNode.connect(audioContext.destination);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      workletNode.port.onmessage = null;
      try {
        source.disconnect();
        workletNode.disconnect();
      } catch {
        // Already disconnected.
      }
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}
