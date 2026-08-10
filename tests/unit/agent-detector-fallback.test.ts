/**
 * Unit tests for AgentDetector fallback-path detection (Gap 1).
 *
 * Covers the three-stage detection pipeline when the binary is NOT on
 * PATH (which() throws). These tests exercise the macOS GUI launch fix:
 * stage 3 iterates well-known fallback paths, calls existsSync on each,
 * then attempts extractVersion. The first path that returns a non-null
 * version wins.
 *
 * Separate from claude-detector.test.ts (which covers the happy PATH
 * path and caching/dedup) to keep concern separation clear.
 *
 * Also includes Gap 3: smoke test that ~/.claude/local/claude is the
 * first fallback entry in ClaudeDetector, guarding against accidental
 * reordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// All three mocks must be hoisted before any imports of the modules
// under test. Vitest hoists vi.mock() calls automatically.

vi.mock('which', () => ({
  default: vi.fn().mockRejectedValue(new Error('not found')),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
    },
  };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import fs from 'node:fs';
import which from 'which';
import { AgentDetector, type AgentDetectorConfig } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import { ClaudeDetector } from '../../src/main/agent/adapters/claude';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal AgentDetector with controlled fallback paths so tests
 * do not depend on the real ClaudeDetector config (which enumerates nvm,
 * Homebrew, etc.) and is therefore stable to additions in fallback-paths.ts.
 */
function makeDetector(fallbackPaths: string[]): AgentDetector {
  const config: AgentDetectorConfig = {
    binaryName: 'testcli',
    fallbackPaths,
    parseVersion: (raw) => raw.trim() || null,
  };
  return new AgentDetector(config);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentDetector - fallback path detection (which() fails)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // which() is already set to throw via the module-level vi.mock factory.
    // vi.clearAllMocks() resets call counts but preserves the mock
    // implementation, so which() continues to throw after clearAllMocks().
    // Default: existsSync returns false (no fallback exists)
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Default: execVersion returns empty (no version)
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });
  });

  // ── Stage 3 success path ──────────────────────────────────────────────────

  it('returns found: true with path and version when first existing fallback has a version', async () => {
    const fallbackPath = '/opt/homebrew/bin/testcli';
    const detector = makeDetector([fallbackPath, '/usr/local/bin/testcli']);

    // Only the first fallback exists and returns a version.
    // existsSync is called twice per candidate: once inside the fallback loop
    // and once inside extractVersion. Both must return true for the same path.
    vi.mocked(fs.existsSync).mockImplementation((filePath) => filePath === fallbackPath);
    vi.mocked(execVersion).mockResolvedValue({ stdout: '2.0.1', stderr: '' });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(fallbackPath);
    expect(result.version).toBe('2.0.1');
  });

  it('skips fallback paths that do not exist on disk (existsSync false)', async () => {
    const missingPath = '/opt/homebrew/bin/testcli';
    const existingPath = '/usr/local/bin/testcli';
    const detector = makeDetector([missingPath, existingPath]);

    vi.mocked(fs.existsSync).mockImplementation((filePath) => filePath === existingPath);
    vi.mocked(execVersion).mockResolvedValue({ stdout: '1.5.0', stderr: '' });

    const result = await detector.detect();

    // existsSync called for both paths in the outer fallback loop
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(missingPath);
    expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(existingPath);

    expect(result.found).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.version).toBe('1.5.0');
  });

  it('iterates to next fallback when first existing path returns null version', async () => {
    const firstPath = '/opt/homebrew/bin/testcli';
    const secondPath = '/usr/local/bin/testcli';
    const detector = makeDetector([firstPath, secondPath]);

    // Both paths exist on disk
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // First path's execVersion returns empty (no version); second returns real version.
    // extractVersion calls existsSync once then execVersion once per candidate.
    vi.mocked(execVersion)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })    // firstPath: no version
      .mockResolvedValueOnce({ stdout: '3.0.0', stderr: '' }); // secondPath: success

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(secondPath);
    expect(result.version).toBe('3.0.0');
  });

  it('returns found: false when no fallback paths are configured', async () => {
    const detector = makeDetector([]);

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
    // execVersion should never be called - no paths to probe
    expect(vi.mocked(execVersion)).not.toHaveBeenCalled();
  });

  it('returns found: false when no fallback paths exist on disk', async () => {
    const detector = makeDetector(['/opt/homebrew/bin/testcli', '/usr/local/bin/testcli']);
    // existsSync already defaults to false in beforeEach

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
  });

  it('returns found: false when all existing fallback paths fail version probe', async () => {
    const detector = makeDetector(['/opt/homebrew/bin/testcli', '/usr/local/bin/testcli']);
    // Both paths exist
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // All version probes return empty
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
  });

  it('returns found: false when fallbackPaths is undefined (no config key)', async () => {
    // Construct a detector without a fallbackPaths key at all
    const config: AgentDetectorConfig = {
      binaryName: 'testcli',
      parseVersion: (raw) => raw.trim() || null,
      // fallbackPaths intentionally omitted - defaults to []
    };
    const detector = new AgentDetector(config);

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
    expect(vi.mocked(execVersion)).not.toHaveBeenCalled();
  });

  // ── Override path still wins (stage 1 not affected by fallback changes) ───

  it('override path still wins when which() fails - never reaches fallback', async () => {
    const overridePath = '/custom/path/testcli';
    const detector = makeDetector(['/opt/homebrew/bin/testcli']);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execVersion).mockResolvedValue({ stdout: '9.9.9', stderr: '' });

    const result = await detector.detect(overridePath);

    expect(result.found).toBe(true);
    expect(result.path).toBe(overridePath);
    expect(result.version).toBe('9.9.9');
    // execVersion called exactly once - for the override path only
    expect(vi.mocked(execVersion)).toHaveBeenCalledTimes(1);
  });

  it('parseVersion returning null causes fallback path to be skipped', async () => {
    const firstPath = '/opt/homebrew/bin/testcli';
    const secondPath = '/usr/local/bin/testcli';

    // Use a detector whose parseVersion rejects the first output but accepts
    // the second, to exercise the "version !== null" gate inside the loop.
    const config: AgentDetectorConfig = {
      binaryName: 'testcli',
      fallbackPaths: [firstPath, secondPath],
      parseVersion: (raw) => raw.startsWith('VALID:') ? raw.replace('VALID:', '').trim() : null,
    };
    const detector = new AgentDetector(config);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execVersion)
      .mockResolvedValueOnce({ stdout: 'INVALID_FORMAT', stderr: '' })  // firstPath
      .mockResolvedValueOnce({ stdout: 'VALID: 2.0.0', stderr: '' });   // secondPath

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(secondPath);
    expect(result.version).toBe('2.0.0');
  });
});

// ── Stage 2: PATH candidate loop (binaryAliases fall-through) ─────────────────
//
// The tests above cover Stage 3 (which() rejects for every candidate, so
// detection falls through to fallback paths). These tests cover Stage 2
// itself: the loop that tries `binaryName` first and then each configured
// `binaryAlias`, in order, when `which()` DOES resolve a candidate but that
// candidate's --version output does not belong to this agent (the
// Cursor/Grok shared-shim case - see cursor-grok-binary-collision.test.ts
// for the real-world scenario this guards). A candidate that resolves but
// fails its version probe must fall through to the next candidate rather
// than either (a) stopping the search and reporting the agent missing, or
// (b) reporting the unresolved candidate as found with a null version.

describe('AgentDetector - PATH candidate loop (binaryAliases fall-through)', () => {
  beforeEach(() => {
    // Full reset (not just clearAllMocks) so a persistent mockImplementation
    // set by one test in this block can never leak into the next test, or
    // into the module-level default (which() rejects) other blocks rely on.
    vi.mocked(which).mockReset();
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execVersion).mockReset();
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('falls through to a binaryAlias when the primary candidate resolves via which() but fails its version probe', async () => {
    const primaryPath = '/usr/local/bin/primary-shim';
    const aliasPath = '/usr/local/bin/alias-shim';

    const config: AgentDetectorConfig = {
      binaryName: 'primary',
      binaryAliases: ['alias'],
      parseVersion: (raw) => (raw.startsWith('VALID:') ? raw.replace('VALID:', '').trim() : null),
    };
    const detector = new AgentDetector(config);

    // Both candidates resolve on PATH...
    vi.mocked(which)
      .mockResolvedValueOnce(primaryPath) // resolves for "primary"
      .mockResolvedValueOnce(aliasPath); // resolves for "alias"
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // ...but only the alias's output parses as this agent's version.
    vi.mocked(execVersion)
      .mockResolvedValueOnce({ stdout: 'UNRELATED_TOOL 4.0.0', stderr: '' }) // primaryPath: wrong product
      .mockResolvedValueOnce({ stdout: 'VALID: 9.9.9', stderr: '' }); // aliasPath: this agent

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(aliasPath);
    expect(result.version).toBe('9.9.9');
  });

  it('probes binaryName before any binaryAlias, in configured alias order', async () => {
    const config: AgentDetectorConfig = {
      binaryName: 'primary',
      binaryAliases: ['alias-one', 'alias-two'],
      parseVersion: (raw) => raw.trim() || null,
    };
    const detector = new AgentDetector(config);

    const probedCandidates: string[] = [];
    vi.mocked(which).mockImplementation(async (candidate) => {
      probedCandidates.push(String(candidate));
      throw new Error('not found');
    });

    await detector.detect();

    expect(probedCandidates).toEqual(['primary', 'alias-one', 'alias-two']);
  });

  it('reports not found (never the wrong binary as found) when every candidate resolves but fails its version probe', async () => {
    const primaryPath = '/usr/local/bin/primary-shim';
    const aliasPath = '/usr/local/bin/alias-shim';
    const fallbackPath = '/opt/homebrew/bin/primary';

    const config: AgentDetectorConfig = {
      binaryName: 'primary',
      binaryAliases: ['alias'],
      fallbackPaths: [fallbackPath],
      parseVersion: (raw) => (raw.startsWith('VALID:') ? raw.replace('VALID:', '').trim() : null),
    };
    const detector = new AgentDetector(config);

    vi.mocked(which)
      .mockResolvedValueOnce(primaryPath)
      .mockResolvedValueOnce(aliasPath);
    // Every path the detector can reach exists on disk, so each stage
    // actually runs its version probe instead of being skipped by existsSync.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // No candidate, at any stage, ever produces a valid version.
    vi.mocked(execVersion).mockResolvedValue({ stdout: 'UNRELATED_TOOL 4.0.0', stderr: '' });

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
    // Proves the search actually continued past the PATH candidate loop into
    // the fallback-paths stage, rather than stopping (or wrongly reporting
    // found) as soon as the last PATH candidate resolved-but-failed.
    expect(vi.mocked(execVersion)).toHaveBeenCalledWith(fallbackPath);
  });
});

// ── Gap 3: ClaudeDetector fallback order smoke test ───────────────────────────

describe('ClaudeDetector - fallback path order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('succeeds via ~/.claude/local/claude when only that path exists on disk', async () => {
    // When existsSync returns true ONLY for the official Anthropic installer path,
    // and execVersion returns a valid version, detection must succeed. This proves
    // the path is included in the fallback list and is reachable.
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      return normalized.endsWith('.claude/local/claude');
    });
    vi.mocked(execVersion).mockResolvedValue({ stdout: '1.0.0 (Claude Code)', stderr: '' });

    const detector = new ClaudeDetector();
    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(String(result.path).replace(/\\/g, '/')).toMatch(/\.claude\/local\/claude$/);
    expect(result.version).toBe('1.0.0');
  });

  // standardUnixFallbackPaths returns [] on Windows (Windows doesn't need
  // Homebrew fallbacks). This test only makes sense on non-Windows platforms.
  it.skipIf(process.platform === 'win32')(
    '~/.claude/local/claude is checked before any Homebrew path',
    async () => {
      // Track the order existsSync is called. All return false so we traverse
      // the full fallback list without stopping early.
      const existsSyncCallOrder: string[] = [];
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        existsSyncCallOrder.push(String(filePath).replace(/\\/g, '/'));
        return false;
      });

      const detector = new ClaudeDetector();
      await detector.detect();

      const anthropicIndex = existsSyncCallOrder.findIndex((p) =>
        p.endsWith('.claude/local/claude'),
      );
      const homebrewIndex = existsSyncCallOrder.findIndex((p) =>
        p.includes('homebrew') || (p.includes('/usr/local/bin') && p.endsWith('/claude')),
      );

      expect(anthropicIndex).toBeGreaterThanOrEqual(0);
      expect(homebrewIndex).toBeGreaterThanOrEqual(0);
      // The Anthropic installer path must be checked before any Homebrew path
      expect(anthropicIndex).toBeLessThan(homebrewIndex);
    },
  );
});
