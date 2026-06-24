/**
 * Unit tests for getBranchSummary - the Changes-panel header context probe.
 *
 * Production source: src/main/git/branch-summary.ts
 *
 * The function is a thin orchestrator over:
 *   1. readWorktreeHead(workingDirectory)  -> { branch }
 *   2. git.raw(['rev-list','--left-right','--count','<base>...HEAD'])
 *      Output: "<behind>\t<ahead>" (tab or whitespace separated)
 *   3. git.raw(['log','-1','--format=%h%x1f%s%x1f%cI'])
 *      Output: "<hash>\x1f<subject>\x1f<timestamp>"
 *
 * The base-ref loop tries `origin/<baseBranch>` first; when that raw call
 * rejects it falls back to the local `<baseBranch>`.  Any top-level git
 * error yields an all-empty summary so the Changes-panel header omits the
 * context instead of surfacing an error.
 *
 * This file also satisfies the "external-input parsers need a real-shape
 * fixture test" rule: the parser for the rev-list and log outputs is exercised
 * with real-shape strings (including edge cases) rather than generated stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Use vi.hoisted so mock factories can reference these variables even though
// vi.mock() calls are hoisted to the top of the module.
const { mockGit, mockReadWorktreeHead } = vi.hoisted(() => {
  const rawFn = vi.fn<(args: string[]) => Promise<string>>();
  const readHeadFn = vi.fn<(worktreePath: string) => Promise<{ branch: string | null; sha: string | null }>>();
  return {
    mockGit: { raw: rawFn },
    mockReadWorktreeHead: readHeadFn,
  };
});

// Mock simple-git so no real git process is spawned.  The mock object is
// shared and configured per-test via mockReturnValue / mockRejectedValue.
vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

// Mock readWorktreeHead so we can drive currentBranch independently of git.
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: mockReadWorktreeHead,
}));

import { getBranchSummary } from '../../src/main/git/branch-summary';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Default working readWorktreeHead that returns a real branch name. */
function setDefaultWorktreeHead(branch: string | null = 'feat/my-feature') {
  mockReadWorktreeHead.mockResolvedValue({ branch, sha: 'abc123' });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getBranchSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── ahead/behind parsing ─────────────────────────────────────────────────

  describe('ahead/behind parsing from rev-list --left-right --count', () => {
    it('parses tab-separated "<behind>\\t<ahead>" correctly (1 behind, 3 ahead)', async () => {
      setDefaultWorktreeHead();
      // origin/main succeeds first
      mockGit.raw
        .mockResolvedValueOnce('1\t3\n')   // rev-list for origin/main...HEAD
        .mockResolvedValueOnce('\n');       // log -1 (empty -> lastCommit null)

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(1);
      expect(result.ahead).toBe(3);
    });

    it('parses ahead=5 with behind=0 ("0\\t5")', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockResolvedValueOnce('0\t5\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(0);
      expect(result.ahead).toBe(5);
    });

    it('parses behind=3 with ahead=0 ("3\\t0")', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockResolvedValueOnce('3\t0\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(3);
      expect(result.ahead).toBe(0);
    });

    it('also handles single-space-separated output (some git versions emit spaces)', async () => {
      setDefaultWorktreeHead();
      // The split uses /\s+/ so both tabs and spaces are accepted.
      mockGit.raw
        .mockResolvedValueOnce('2 7\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(2);
      expect(result.ahead).toBe(7);
    });
  });

  // ── base-ref fallback ────────────────────────────────────────────────────

  describe('base-ref fallback: origin/<base> first, then local <base>', () => {
    it('calls rev-list with origin/<base> first, then stops when it succeeds', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockResolvedValueOnce('0\t2\n')   // origin/main succeeds
        .mockResolvedValueOnce('\n');       // log -1

      await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      // First raw call must be the origin variant
      expect(mockGit.raw).toHaveBeenCalledWith([
        'rev-list', '--left-right', '--count', 'origin/main...HEAD',
      ]);
      // The local fallback must NOT have been called
      const calls = mockGit.raw.mock.calls.map((callArgs) => callArgs[0]);
      expect(calls).not.toContainEqual([
        'rev-list', '--left-right', '--count', 'main...HEAD',
      ]);
    });

    it('falls back to local <base> when origin/<base> rejects', async () => {
      setDefaultWorktreeHead();
      // origin/develop does not exist -> reject
      // local develop -> resolves with real counts
      mockGit.raw
        .mockRejectedValueOnce(new Error('fatal: unknown revision origin/develop'))
        .mockResolvedValueOnce('1\t4\n')   // local develop...HEAD
        .mockResolvedValueOnce('\n');       // log -1

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'develop' });

      // Both candidates were tried in order
      expect(mockGit.raw).toHaveBeenCalledWith([
        'rev-list', '--left-right', '--count', 'origin/develop...HEAD',
      ]);
      expect(mockGit.raw).toHaveBeenCalledWith([
        'rev-list', '--left-right', '--count', 'develop...HEAD',
      ]);
      // The fallback values are used in the result
      expect(result.behind).toBe(1);
      expect(result.ahead).toBe(4);
    });

    it('returns ahead=0 behind=0 when both origin and local refs fail', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockRejectedValueOnce(new Error('fatal: unknown revision origin/main'))
        .mockRejectedValueOnce(new Error('fatal: unknown revision main'))
        .mockResolvedValueOnce('\n'); // log -1

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(0);
      expect(result.ahead).toBe(0);
    });
  });

  // ── last-commit parsing ──────────────────────────────────────────────────

  describe('last-commit parsing from log -1 --format=%h%x1f%s%x1f%cI', () => {
    it('parses hash, subject, and timestamp from the unit-separator delimited output', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockResolvedValueOnce('0\t1\n')   // rev-list
        .mockResolvedValueOnce('a1b2c3\x1ffeat: add button\x1f2024-01-15T10:30:00Z\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.lastCommit).toEqual({
        hash: 'a1b2c3',
        subject: 'feat: add button',
        timestamp: '2024-01-15T10:30:00Z',
      });
    });

    it('parses a subject that contains spaces without breaking on space-split (proves \\x1f separator)', async () => {
      // A subject like "fix: resolve the thing with spaces and more spaces" would
      // split wrongly on ' ' but the x1f separator keeps it intact.
      setDefaultWorktreeHead();
      const subject = 'fix: resolve the thing with spaces   and more    spaces';
      mockGit.raw
        .mockResolvedValueOnce('0\t1\n')
        .mockResolvedValueOnce(`d3adb33f\x1f${subject}\x1f2025-06-15T08:00:00+00:00\n`);

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.lastCommit?.subject).toBe(subject);
      expect(result.lastCommit?.hash).toBe('d3adb33f');
    });

    it('parses a subject containing a literal tab character correctly', async () => {
      // A commit subject could contain a tab - prove the x1f separator handles it.
      setDefaultWorktreeHead();
      const subjectWithTab = 'refactor:\tadd\ttabs';
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockResolvedValueOnce(`cafebabe\x1f${subjectWithTab}\x1f2025-01-01T00:00:00Z\n`);

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.lastCommit?.subject).toBe(subjectWithTab);
    });

    it('leaves lastCommit null when log output is empty (unborn branch)', async () => {
      setDefaultWorktreeHead();
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockResolvedValueOnce('');  // no commits

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.lastCommit).toBeNull();
    });

    it('leaves lastCommit null when git log throws (unborn branch error path)', async () => {
      setDefaultWorktreeHead();
      // rev-list succeeds, log throws
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockRejectedValueOnce(new Error("fatal: your current branch 'main' does not have any commits yet"));

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      // Unborn branch: lastCommit is null but the rest of the summary is still populated.
      expect(result.lastCommit).toBeNull();
      // ahead/behind still come through from the successful rev-list call above.
      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
    });
  });

  // ── currentBranch from readWorktreeHead ──────────────────────────────────

  describe('currentBranch from readWorktreeHead', () => {
    it('surfaces the branch returned by readWorktreeHead', async () => {
      setDefaultWorktreeHead('feat/awesome-feature');
      mockGit.raw
        .mockResolvedValueOnce('0\t1\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.currentBranch).toBe('feat/awesome-feature');
    });

    it('propagates null from readWorktreeHead when on a detached HEAD', async () => {
      setDefaultWorktreeHead(null);
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.currentBranch).toBeNull();
    });

    it('uses worktreePath when provided, falling back to projectPath when absent', async () => {
      setDefaultWorktreeHead('feat/worktree-branch');
      mockGit.raw
        .mockResolvedValueOnce('0\t1\n')
        .mockResolvedValueOnce('\n');

      await getBranchSummary({
        projectPath: '/mock/project',
        worktreePath: '/mock/project/.kangentic/worktrees/feat-branch',
        baseBranch: 'main',
      });

      expect(mockReadWorktreeHead).toHaveBeenCalledWith(
        '/mock/project/.kangentic/worktrees/feat-branch',
      );
    });

    it('uses projectPath when worktreePath is absent', async () => {
      setDefaultWorktreeHead('main');
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockResolvedValueOnce('\n');

      await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(mockReadWorktreeHead).toHaveBeenCalledWith('/mock/project');
    });
  });

  // ── fail-safe: all-empty summary on any git error ─────────────────────────

  describe('fail-safe: returns all-empty summary on unexpected git errors', () => {
    it('returns the all-empty summary when readWorktreeHead throws', async () => {
      mockReadWorktreeHead.mockRejectedValue(new Error('worktree gone'));
      // No raw mocks needed: the outer try/catch should catch before any raw call.

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result).toEqual({
        currentBranch: null,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      });
    });

    it('returns the all-empty summary when simpleGit itself throws synchronously', async () => {
      // simpleGit() constructor can throw if the path is badly formed on some platforms.
      const { default: simpleGit } = await import('simple-git');
      vi.mocked(simpleGit).mockImplementationOnce(() => {
        throw new Error('not a git repository');
      });
      setDefaultWorktreeHead('main');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result).toEqual({
        currentBranch: null,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      });
    });

    it('all-empty summary shape matches GitBranchSummaryResult exactly', async () => {
      mockReadWorktreeHead.mockRejectedValue(new Error('error'));

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      // All four fields present with their zero/null defaults.
      expect(Object.keys(result).sort()).toEqual(
        ['ahead', 'behind', 'currentBranch', 'lastCommit'].sort(),
      );
      expect(result.currentBranch).toBeNull();
      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
      expect(result.lastCommit).toBeNull();
    });
  });

  // ── real-shape fixture tests (external-input parser rule) ─────────────────

  describe('real-shape fixture: parser correctness with actual git output shapes', () => {
    it('handles rev-list output with a trailing newline (actual git output format)', async () => {
      setDefaultWorktreeHead('main');
      // git rev-list --left-right --count always emits "<N>\t<N>\n"
      mockGit.raw
        .mockResolvedValueOnce('2\t8\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.behind).toBe(2);
      expect(result.ahead).toBe(8);
    });

    it('handles log output with a realistic ISO 8601 timestamp including timezone offset', async () => {
      setDefaultWorktreeHead('main');
      mockGit.raw
        .mockResolvedValueOnce('0\t1\n')
        .mockResolvedValueOnce('f1e2d3c4\x1fchore: bump deps\x1f2026-06-15T14:22:07+05:30\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.lastCommit?.timestamp).toBe('2026-06-15T14:22:07+05:30');
    });

    it('handles a rev-list output of "0\\t0" (already on base, no divergence)', async () => {
      setDefaultWorktreeHead('main');
      mockGit.raw
        .mockResolvedValueOnce('0\t0\n')
        .mockResolvedValueOnce('\n');

      const result = await getBranchSummary({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
    });
  });
});
