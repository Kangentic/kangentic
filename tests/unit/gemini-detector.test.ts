/**
 * Unit tests for GeminiDetector - verifies detection, caching,
 * in-flight deduplication, and cache invalidation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/bin/gemini'),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
    setTimeout(() => cb(null, { stdout: '1.2.3\n' }), 10);
  }),
}));

import { GeminiDetector } from '../../src/main/agent/gemini-detector';
import { execFile } from 'node:child_process';

describe('GeminiDetector', () => {
  let detector: GeminiDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new GeminiDetector();
  });

  it('detects gemini binary and version', async () => {
    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe('/usr/bin/gemini');
    expect(result.version).toBe('1.2.3');
  });

  it('5 concurrent detect() calls invoke execFile exactly once', async () => {
    const results = await Promise.all([
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
    ]);

    for (const result of results) {
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/gemini');
    }

    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('cached result is returned without new execFile call', async () => {
    await detector.detect();
    vi.mocked(execFile).mockClear();

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('invalidateCache clears cache - next detect runs fresh', async () => {
    await detector.detect();
    detector.invalidateCache();
    vi.mocked(execFile).mockClear();

    const result = await detector.detect();
    expect(result.found).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('overridePath is used instead of which lookup', async () => {
    const which = (await import('which')).default;

    const result = await detector.detect('/custom/gemini');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/custom/gemini');
    expect(which).not.toHaveBeenCalled();
  });
});
