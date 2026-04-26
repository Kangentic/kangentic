/**
 * Unit tests for QwenDetector - verifies detection, caching,
 * in-flight deduplication, and cache invalidation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/bin/qwen'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn().mockResolvedValue({ stdout: '0.0.14\n', stderr: '' }),
}));

import { QwenDetector } from '../../src/main/agent/adapters/qwen-code';
import { execVersion } from '../../src/main/agent/shared';

describe('QwenDetector', () => {
  let detector: QwenDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new QwenDetector();
  });

  it('detects qwen binary and version', async () => {
    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe('/usr/bin/qwen');
    expect(result.version).toBe('0.0.14');
  });

  it('5 concurrent detect() calls invoke execVersion exactly once', async () => {
    const results = await Promise.all([
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
      detector.detect(),
    ]);

    for (const result of results) {
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/qwen');
    }

    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('cached result is returned without new execVersion call', async () => {
    await detector.detect();
    vi.mocked(execVersion).mockClear();

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(execVersion).not.toHaveBeenCalled();
  });

  it('invalidateCache clears cache - next detect runs fresh', async () => {
    await detector.detect();
    detector.invalidateCache();
    vi.mocked(execVersion).mockClear();

    const result = await detector.detect();
    expect(result.found).toBe(true);
    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('overridePath is used instead of which lookup', async () => {
    const which = (await import('which')).default;

    const result = await detector.detect('/custom/qwen');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/custom/qwen');
    expect(which).not.toHaveBeenCalled();
  });
});
