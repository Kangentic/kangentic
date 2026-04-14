/**
 * Unit tests for CopilotDetector - version string parsing, detection,
 * caching, in-flight deduplication, and cache invalidation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/local/bin/copilot'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn().mockResolvedValue({
    stdout: 'GitHub Copilot CLI 1.0.24.\nRun \'copilot update\' to check for updates.\n',
    stderr: '',
  }),
}));

import { CopilotDetector } from '../../src/main/agent/adapters/copilot';
import { execVersion } from '../../src/main/agent/shared/exec-version';

describe('CopilotDetector', () => {
  let detector: CopilotDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new CopilotDetector();
  });

  // ── Version string parsing ───────────────────────────────────────────────

  describe('version string parsing', () => {
    it('strips "GitHub Copilot CLI " prefix and trailing period', async () => {
      const result = await detector.detect('/usr/local/bin/copilot');
      expect(result.version).toBe('1.0.24');
    });

    it('takes only the first line of multi-line version output', async () => {
      vi.mocked(execVersion).mockResolvedValueOnce({
        stdout: 'GitHub Copilot CLI 2.1.0.\nRun \'copilot update\' to check for updates.\n',
        stderr: '',
      });
      const result = await detector.detect('/usr/local/bin/copilot');
      expect(result.version).toBe('2.1.0');
    });

    it('handles version output without trailing period', async () => {
      vi.mocked(execVersion).mockResolvedValueOnce({
        stdout: 'GitHub Copilot CLI 1.0.0',
        stderr: '',
      });
      const result = await detector.detect('/usr/local/bin/copilot');
      expect(result.version).toBe('1.0.0');
    });

    it('handles version output with trailing period and whitespace', async () => {
      vi.mocked(execVersion).mockResolvedValueOnce({
        stdout: 'GitHub Copilot CLI 1.5.2.  \n',
        stderr: '',
      });
      const result = await detector.detect('/usr/local/bin/copilot');
      expect(result.version).toBe('1.5.2');
    });

    it('is case-insensitive for the prefix', async () => {
      vi.mocked(execVersion).mockResolvedValueOnce({
        stdout: 'github copilot cli 1.0.24.',
        stderr: '',
      });
      const result = await detector.detect('/usr/local/bin/copilot');
      expect(result.version).toBe('1.0.24');
    });

    it('returns null when version output is completely unexpected', async () => {
      vi.mocked(execVersion).mockResolvedValueOnce({
        stdout: '\n\n',
        stderr: '',
      });
      const freshDetector = new CopilotDetector();
      const result = await freshDetector.detect('/usr/local/bin/copilot');
      expect(result.version).toBeNull();
    });
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await detector.detect('/custom/copilot');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/copilot');
      expect(result.version).toBe('1.0.24');
    });

    it('falls back to which when no override path', async () => {
      const result = await detector.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/local/bin/copilot');
    });

    it('returns found: false when which fails', async () => {
      const which = (await import('which')).default;
      vi.mocked(which).mockRejectedValueOnce(new Error('not found'));

      const freshDetector = new CopilotDetector();
      const result = await freshDetector.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: false with the override path when --version fails', async () => {
      // When the user configures an explicit override path and --version fails,
      // the detector reports {found: false, path: <override>} so the user can
      // see WHICH configured path failed. Shared via AgentDetector base class.
      vi.mocked(execVersion).mockRejectedValueOnce(new Error('command not found'));
      const freshDetector = new CopilotDetector();
      const result = await freshDetector.detect('/custom/copilot');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/copilot');
      expect(result.version).toBeNull();
    });
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('caches detection result - execVersion called once', async () => {
      const first = await detector.detect('/custom/copilot');
      const second = await detector.detect('/custom/copilot');

      expect(first).toBe(second);
      expect(execVersion).toHaveBeenCalledTimes(1);
    });

    it('5 concurrent detect() calls invoke execVersion exactly once', async () => {
      const results = await Promise.all([
        detector.detect('/custom/copilot'),
        detector.detect('/custom/copilot'),
        detector.detect('/custom/copilot'),
        detector.detect('/custom/copilot'),
        detector.detect('/custom/copilot'),
      ]);

      for (const result of results) {
        expect(result.found).toBe(true);
        expect(result.path).toBe('/custom/copilot');
      }
      expect(execVersion).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache clears the cache - next detect runs fresh', async () => {
      await detector.detect('/custom/copilot');
      detector.invalidateCache();
      vi.mocked(execVersion).mockClear();

      const result = await detector.detect('/custom/copilot');
      expect(result.found).toBe(true);
      expect(execVersion).toHaveBeenCalledTimes(1);
    });
  });
});
