import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteOpenAiEngine } from '../../src/main/transcription/engines/remote-openai-engine';
import type { CreateSessionOptions } from '../../src/main/transcription/engines/transcription-engine';

/**
 * RemoteOpenAiEngine unit tests - external-input parser boundary.
 *
 * The engine POSTs a WAV to the OpenAI-compatible `/v1/audio/transcriptions`
 * endpoint and reads `(await response.json()) as { text?: string }`. This is
 * an external-input parser: it dispatches on the `text` field of the JSON
 * response. Any shape change in that field silently drops the transcript unless
 * we have a real-shape fixture test that exercises the complete parse path.
 *
 * `fetch` is the global browser/Node fetch API (Node 18+). Tests stub it
 * with `vi.stubGlobal` so no real network traffic is emitted.
 */

const SESSION_OPTIONS: CreateSessionOptions = {
  sampleRate: 16000,
  language: 'en',
  punctuation: true,
  onPartial: () => {},
};

/** One 16-sample PCM frame (silence). Enough to satisfy the frames-empty guard. */
const SILENCE_FRAME = new Int16Array(16);

function buildMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteOpenAiEngine.finalize - URL guard', () => {
  it('throws when no URL is configured (even with no frames)', async () => {
    const engine = new RemoteOpenAiEngine({}); // url is absent
    const session = engine.createSession(SESSION_OPTIONS);
    // The URL check fires before the empty-frames guard.
    await expect(session.finalize()).rejects.toThrow('No cloud endpoint configured');
  });

  it('throws when config is undefined', async () => {
    const engine = new RemoteOpenAiEngine(undefined);
    const session = engine.createSession(SESSION_OPTIONS);
    await expect(session.finalize()).rejects.toThrow('No cloud endpoint configured');
  });
});

describe('RemoteOpenAiEngine.finalize - empty frames', () => {
  it('returns empty string immediately when no audio was pushed', async () => {
    // frames is empty; the early-return fires before building the WAV or
    // calling fetch. The mock fetch should never be called.
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    const result = await session.finalize();
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('RemoteOpenAiEngine.finalize - normal response', () => {
  it('returns the trimmed text from a { text } JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(200, { text: '  hello world  ' })));
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    const result = await session.finalize();
    expect(result).toBe('hello world');
  });

  it('returns empty string when text field is absent from the response', () => {
    // Missing `text` -> `(data.text ?? '').trim()` -> ''. This is the
    // projection failure case: the server returned a non-standard shape.
    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(200, {})));
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    return session.finalize().then((result) => {
      expect(result).toBe('');
    });
  });
});

describe('RemoteOpenAiEngine.finalize - error status', () => {
  it('throws on a 400 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(400, { error: 'bad request' })));
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    await expect(session.finalize()).rejects.toThrow('400');
  });

  it('throws on a 401 Unauthorized response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(401, { error: 'unauthorized' })));
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions', apiKey: 'bad-key' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    await expect(session.finalize()).rejects.toThrow('401');
  });

  it('throws on a 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(500, {})));
    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    await expect(session.finalize()).rejects.toThrow('500');
  });
});

describe('RemoteOpenAiEngine.finalize - real-shape fixture', () => {
  it('extracts text correctly from a real-shaped OpenAI transcription response', async () => {
    // Fixture is a sanitized copy of the actual /v1/audio/transcriptions JSON
    // shape documented by the OpenAI API. Uses the `text` field (the only
    // field the engine reads) plus representative extra fields that OpenAI
    // returns in production. If OpenAI changes the response schema (e.g.
    // moves `text` to a nested key), this test fails and surfaces the drift.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'openai-transcription-response.json');
    const fixtureBody = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { text?: string };

    vi.stubGlobal('fetch', vi.fn(async () => buildMockResponse(200, fixtureBody)));

    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    const result = await session.finalize();

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // The fixture contains {"text":"Hello, world.",...}
    expect(result).toBe('Hello, world.');
  });
});

describe('RemoteOpenAiEngine.finalize - API key header', () => {
  it('sends Authorization: Bearer header when apiKey is set', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return buildMockResponse(200, { text: 'ok' });
    }));

    const engine = new RemoteOpenAiEngine({
      url: 'https://example.test/v1/audio/transcriptions',
      apiKey: 'sk-test-key',
    });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    await session.finalize();

    expect(capturedHeaders?.Authorization).toBe('Bearer sk-test-key');
  });

  it('sends no Authorization header when apiKey is absent', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return buildMockResponse(200, { text: 'ok' });
    }));

    const engine = new RemoteOpenAiEngine({ url: 'https://example.test/v1/audio/transcriptions' });
    const session = engine.createSession(SESSION_OPTIONS);
    session.push(SILENCE_FRAME);
    await session.finalize();

    expect(capturedHeaders?.Authorization).toBeUndefined();
  });
});
