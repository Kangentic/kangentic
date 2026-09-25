import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { EngineSelection } from '../../src/main/transcription/engines/engine-selection';
import type { TranscriptionEngineSession } from '../../src/main/transcription/engines/transcription-engine';
import type { DictationRemoteEndpoint, DictationEngineInfo } from '../../src/shared/types';

/**
 * `engine-build.ts`'s `buildEngine` is the worker-only construction half of
 * the engine-selection/engine-build split (see DESKTOP-X /
 * .claude/rules/dictation-out-of-process.md): it is the ONLY place that
 * translates a resolved `EngineSelection` into concrete `SherpaOnlineEngine`
 * / `ChunkedOfflineEngine` / `SherpaWhisperEngine` / `RemoteOpenAiEngine`
 * construction. `dictation-worker.test.ts` deliberately mocks the whole
 * module away ("no test here touches sherpa-onnx-node"), and the
 * predecessor `engine-registry.ts`'s `.build()` closure was never tested
 * either (`engine-registry-select.test.ts`: "we never call `.build()` in
 * these tests") - so this branching logic has never had direct coverage.
 *
 * The four concrete engine classes are mocked here (not `sherpa-onnx-node`
 * itself) so the real branching in `buildEngine` runs unmodified while the
 * native module is never loaded transitively. `HybridEngine` is left real:
 * it is pure (no sherpa import) and its constructor synchronously calls
 * `slots.live.factory()` / `slots.final.factory()`, which is exactly what
 * makes the slot choice observable via the mock constructor spies.
 */

const spies = vi.hoisted(() => ({
  sherpaOnline: vi.fn(),
  chunkedOffline: vi.fn(),
  sherpaWhisper: vi.fn(),
  remoteOpenAi: vi.fn(),
}));

function stubSession(): TranscriptionEngineSession {
  return {
    push: () => undefined,
    finalize: async () => '',
    cancel: () => undefined,
    dispose: () => undefined,
  };
}

const STUB_ENGINE_INFO: DictationEngineInfo = {
  id: 'stub',
  displayName: 'Mock',
  streaming: true,
  punctuation: true,
  license: 'MIT',
  requiresModelDownload: false,
};

vi.mock('../../src/main/transcription/engines/sherpa-online-engine', () => ({
  SherpaOnlineEngine: class {
    readonly info = STUB_ENGINE_INFO;
    constructor(...args: unknown[]) {
      spies.sherpaOnline(...args);
    }
    async load(): Promise<void> {}
    createSession(): TranscriptionEngineSession {
      return stubSession();
    }
    async dispose(): Promise<void> {}
  },
}));

vi.mock('../../src/main/transcription/engines/chunked-offline-engine', () => ({
  ChunkedOfflineEngine: class {
    readonly info = STUB_ENGINE_INFO;
    constructor(...args: unknown[]) {
      spies.chunkedOffline(...args);
    }
    async load(): Promise<void> {}
    createSession(): TranscriptionEngineSession {
      return stubSession();
    }
    async dispose(): Promise<void> {}
  },
}));

vi.mock('../../src/main/transcription/engines/sherpa-whisper-engine', () => ({
  SherpaWhisperEngine: class {
    readonly info = STUB_ENGINE_INFO;
    constructor(...args: unknown[]) {
      spies.sherpaWhisper(...args);
    }
    async load(): Promise<void> {}
    createSession(): TranscriptionEngineSession {
      return stubSession();
    }
    async dispose(): Promise<void> {}
  },
}));

vi.mock('../../src/main/transcription/engines/remote-openai-engine', () => ({
  RemoteOpenAiEngine: class {
    readonly info = STUB_ENGINE_INFO;
    constructor(...args: unknown[]) {
      spies.remoteOpenAi(...args);
    }
    async load(): Promise<void> {}
    createSession(): TranscriptionEngineSession {
      return stubSession();
    }
    async dispose(): Promise<void> {}
  },
}));

import { buildEngine } from '../../src/main/transcription/engines/engine-build';

function makeSelection(overrides: Partial<EngineSelection> = {}): EngineSelection {
  return {
    id: 'hybrid',
    info: STUB_ENGINE_INFO,
    models: [],
    liveModelId: 'streaming-zipformer-en',
    liveModelKind: 'online-transducer',
    finalModelId: null,
    isRemote: false,
    language: 'en',
    ...overrides,
  };
}

beforeEach(() => {
  spies.sherpaOnline.mockClear();
  spies.chunkedOffline.mockClear();
  spies.sherpaWhisper.mockClear();
  spies.remoteOpenAi.mockClear();
});

describe('buildEngine - live slot routing', () => {
  it('liveModelKind online-transducer builds SherpaOnlineEngine, not ChunkedOfflineEngine', () => {
    buildEngine(makeSelection({ liveModelKind: 'online-transducer' }), undefined);
    expect(spies.sherpaOnline).toHaveBeenCalledTimes(1);
    expect(spies.chunkedOffline).not.toHaveBeenCalled();
  });

  it('a non-transducer liveModelKind builds ChunkedOfflineEngine with the selection language', () => {
    buildEngine(makeSelection({ liveModelKind: 'offline-moonshine', language: 'fr' }), undefined);
    expect(spies.chunkedOffline).toHaveBeenCalledTimes(1);
    expect(spies.chunkedOffline).toHaveBeenCalledWith('fr');
    expect(spies.sherpaOnline).not.toHaveBeenCalled();
  });

  it('offline-whisper and offline-nemo-transducer also route to ChunkedOfflineEngine', () => {
    buildEngine(makeSelection({ liveModelKind: 'offline-whisper' }), undefined);
    buildEngine(makeSelection({ liveModelKind: 'offline-nemo-transducer' }), undefined);
    expect(spies.chunkedOffline).toHaveBeenCalledTimes(2);
    expect(spies.sherpaOnline).not.toHaveBeenCalled();
  });

  it('liveModelId null: neither live engine is constructed (no live slot)', () => {
    // Keep a final slot active so HybridEngine does not throw on both-null.
    buildEngine(makeSelection({ liveModelId: null, liveModelKind: null, finalModelId: 'parakeet-tdt-0.6b-en' }), undefined);
    expect(spies.sherpaOnline).not.toHaveBeenCalled();
    expect(spies.chunkedOffline).not.toHaveBeenCalled();
    expect(spies.sherpaWhisper).toHaveBeenCalledTimes(1);
  });
});

describe('buildEngine - final slot routing', () => {
  it('isRemote true builds RemoteOpenAiEngine for the final slot, not SherpaWhisperEngine', () => {
    buildEngine(makeSelection({ isRemote: true }), undefined);
    expect(spies.remoteOpenAi).toHaveBeenCalledTimes(1);
    expect(spies.sherpaWhisper).not.toHaveBeenCalled();
  });

  it('isRemote true passes the remote endpoint through to RemoteOpenAiEngine', () => {
    const remote: DictationRemoteEndpoint = { url: 'https://api.example.com', apiKey: 'key', model: 'gpt-4o-transcribe' };
    buildEngine(makeSelection({ isRemote: true }), remote);
    expect(spies.remoteOpenAi).toHaveBeenCalledWith(remote);
  });

  it('isRemote true builds RemoteOpenAiEngine even when finalModelId happens to be set', () => {
    // buildEngine branches purely on `selection.isRemote`, not on finalModelId -
    // a stale/inconsistent selection must not silently fall through to the
    // on-device SherpaWhisperEngine path.
    buildEngine(makeSelection({ isRemote: true, finalModelId: 'parakeet-tdt-0.6b-en' }), undefined);
    expect(spies.remoteOpenAi).toHaveBeenCalledTimes(1);
    expect(spies.sherpaWhisper).not.toHaveBeenCalled();
  });

  it('isRemote false with a finalModelId builds SherpaWhisperEngine with the selection language', () => {
    buildEngine(makeSelection({ isRemote: false, finalModelId: 'parakeet-tdt-0.6b-en', language: 'pt' }), undefined);
    expect(spies.sherpaWhisper).toHaveBeenCalledTimes(1);
    expect(spies.sherpaWhisper).toHaveBeenCalledWith('pt');
    expect(spies.remoteOpenAi).not.toHaveBeenCalled();
  });

  it('isRemote false with finalModelId null: no final engine is constructed (live-only hybrid)', () => {
    buildEngine(makeSelection({ isRemote: false, finalModelId: null }), undefined);
    expect(spies.sherpaWhisper).not.toHaveBeenCalled();
    expect(spies.remoteOpenAi).not.toHaveBeenCalled();
    // The live slot (default override) is still active.
    expect(spies.sherpaOnline).toHaveBeenCalledTimes(1);
  });
});

describe('buildEngine - combined selections', () => {
  it('returns a HybridEngine composing both a live and a final engine', () => {
    const engine = buildEngine(
      makeSelection({ liveModelKind: 'online-transducer', isRemote: false, finalModelId: 'parakeet-tdt-0.6b-en' }),
      undefined,
    );
    expect(spies.sherpaOnline).toHaveBeenCalledTimes(1);
    expect(spies.sherpaWhisper).toHaveBeenCalledTimes(1);
    expect(engine.info.id).toBe('hybrid');
  });
});
