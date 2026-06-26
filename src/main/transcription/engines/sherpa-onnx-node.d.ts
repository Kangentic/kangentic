/**
 * Ambient type declarations for sherpa-onnx-node (1.13.x), which ships no
 * TypeScript types. Covers only the surface the dictation engines use:
 * streaming (OnlineRecognizer), offline whisper (OfflineRecognizer), and
 * punctuation. Recognizer config objects are passed straight through to the
 * native addon and are declared `unknown` (the typescript-style rule bans
 * `any`); construct them inside the engines where the concrete shape is known.
 */
declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface RecognizerResult {
    text: string;
  }

  export class OnlineStream {
    acceptWaveform(waveform: Waveform): void;
    inputFinished(): void;
  }

  export class OnlineRecognizer {
    constructor(config: unknown);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): RecognizerResult;
  }

  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: unknown);
    static createAsync(config: unknown): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<RecognizerResult>;
    getResult(stream: OfflineStream): RecognizerResult;
  }

  export class OfflinePunctuation {
    constructor(config: unknown);
    addPunct(text: string): string;
  }

  export class OnlinePunctuation {
    constructor(config: unknown);
    addPunct(text: string): string;
  }

  export function readWave(filename: string): Waveform;
}
