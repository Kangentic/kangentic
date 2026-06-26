import type { DictationEngineInfo, DictationRemoteEndpoint } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';

export const REMOTE_OPENAI_INFO: DictationEngineInfo = {
  id: 'remote-openai',
  displayName: 'Cloud (live preview + remote final)',
  // The local streaming Zipformer drives the live preview (see engine-registry,
  // where Cloud is built as a hybrid), so the cloud path is streaming too.
  streaming: true,
  punctuation: true,
  license: 'remote',
  // The ~70 MB transducer for the live preview is downloaded; the cloud endpoint
  // produces the final.
  requiresModelDownload: true,
};

/** Build a 16 kHz mono 16-bit PCM WAV from the buffered Int16 frames. */
function encodeWav(frames: Int16Array[]): Buffer {
  let total = 0;
  for (const frame of frames) total += frame.length;
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }

  const sampleRate = 16000;
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index++) {
    buffer.writeInt16LE(pcm[index], 44 + index * 2);
  }
  return buffer;
}

/**
 * Remote OpenAI-compatible `/v1/audio/transcriptions` backend. Buffers the
 * utterance, encodes it as a WAV, and POSTs it as multipart/form-data on
 * finalize. No local model. This is also the audio-funnel boundary a future
 * mobile companion will reuse.
 */
export class RemoteOpenAiEngine implements TranscriptionEngine {
  readonly info = REMOTE_OPENAI_INFO;

  constructor(private readonly config?: DictationRemoteEndpoint) {}

  async load(_models: ResolvedModel[]): Promise<void> {
    // No local model to load.
  }

  createSession(_options: CreateSessionOptions): TranscriptionEngineSession {
    const config = this.config;
    let frames: Int16Array[] = [];

    return {
      push(pcm: Int16Array): void {
        frames.push(pcm.slice());
      },
      async finalize(): Promise<string> {
        const captured = frames;
        frames = [];
        if (!config?.url) {
          throw new Error('No cloud endpoint configured. Set it under Settings > Dictation > Cloud.');
        }
        if (captured.length === 0) return '';

        const wav = encodeWav(captured);
        // Copy into a Uint8Array over a plain ArrayBuffer (Buffer's buffer is
        // typed as ArrayBufferLike, which is not a valid BlobPart).
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', config.model ?? 'whisper-1');

        const headers: Record<string, string> = {};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

        const response = await fetch(config.url, { method: 'POST', headers, body: form });
        if (!response.ok) {
          throw new Error(`Cloud transcription failed (${response.status}).`);
        }
        const data = (await response.json()) as { text?: string };
        return (data.text ?? '').trim();
      },
      cancel(): void {
        frames = [];
      },
      dispose(): void {
        frames = [];
      },
    };
  }

  async dispose(): Promise<void> {
    // Nothing to release.
  }
}
