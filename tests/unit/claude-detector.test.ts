/**
 * Unit tests for ClaudeDetector - verifies in-flight deduplication
 * so concurrent detect() calls share a single shell execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock which, fs, and execFile before importing ClaudeDetector
vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/bin/claude'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
    setTimeout(() => cb(null, { stdout: 'claude 1.0.0\n' }), 10);
  }),
}));

import { ClaudeDetector } from '../../src/main/agent/claude-detector';
import { execFile } from 'node:child_process';

describe('ClaudeDetector', () => {
  let detector: ClaudeDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new ClaudeDetector();
  });

  it('5 concurrent detect() calls invoke execFile exactly once', async () => {
    const results = await Promise.all([
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
    ]);

    // All 5 should return the same result
    for (const result of results) {
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/claude');
      expect(result.version).toBe('claude 1.0.0');
    }

    // execFile should have been called exactly once
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('cached result is returned without new execFile call', async () => {
    await detector.detect();
    vi.mocked(execFile).mockClear();

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('invalidateCache clears in-flight promise - next detect runs fresh', async () => {
    const firstResult = await detector.detect();
    expect(firstResult.found).toBe(true);

    detector.invalidateCache();
    vi.mocked(execFile).mockClear();

    const secondResult = await detector.detect();
    expect(secondResult.found).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('overridePath is used instead of which lookup', async () => {
    const which = (await import('which')).default;

    const result = await detector.detect('/custom/claude');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/custom/claude');
    expect(which).not.toHaveBeenCalled();
  });
});
