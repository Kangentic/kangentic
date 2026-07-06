/**
 * Unit tests for getCommitGraph - the git reader behind the task-detail Graph
 * pane.
 *
 * Production source: src/main/git/commit-graph.ts
 *
 * The function is a thin orchestrator, structurally identical to
 * getBranchSummary (see tests/unit/branch-summary.test.ts, which this file
 * mirrors):
 *   1. readWorktreeHead(workingDirectory) -> { branch, sha }
 *   2. Resolve the base ref: try `git merge-base origin/<base> HEAD` +
 *      `git rev-parse origin/<base>` first, then fall back to the local
 *      `<base>` variant of both if the origin candidate throws.
 *   3. `git log` with a 3-attempt degrade chain (widest range with a
 *      mergeBase~N floor, then drop the floor, then HEAD only), each
 *      requesting `--max-count=<maxCommits + 1>` so the reader can detect
 *      truncation.
 *
 * Any top-level git error yields an all-empty result so the Graph pane shows
 * an empty state rather than surfacing an error; a log-only failure (every
 * attempt throws) still reports the resolved tipHash/currentBranch.
 *
 * No real git process is spawned: simple-git's `git.raw` and
 * `readWorktreeHead` are both mocked, following branch-summary.test.ts's
 * pattern exactly.
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

// Mock simple-git so no real git process is spawned. The mock object is
// shared and configured per-test via mockResolvedValueOnce / mockRejectedValueOnce.
vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

// Mock readWorktreeHead so we can drive tipHash/currentBranch independently of git.
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: mockReadWorktreeHead,
}));

import { getCommitGraph } from '../../src/main/git/commit-graph';

// ── Helpers ────────────────────────────────────────────────────────────────

const UNIT = '\x1f';

/** Build one formatted `git log --format` line in the reader's real COMMIT_FORMAT shape (%H %h %P %an %aI %s). */
function line(fields: {
  hash: string;
  shortHash: string;
  parents: string;
  author: string;
  timestamp: string;
  subject: string;
}): string {
  return [fields.hash, fields.shortHash, fields.parents, fields.author, fields.timestamp, fields.subject].join(UNIT);
}

/** Default working readWorktreeHead that returns a real branch and sha. */
function setDefaultWorktreeHead(branch: string | null = 'feat/graph-pane', sha: string | null = 'tiphash1234') {
  mockReadWorktreeHead.mockResolvedValue({ branch, sha });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getCommitGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── base-ref resolution preference order ─────────────────────────────────

  describe('base-ref resolution: origin/<base> first, then local <base>', () => {
    it('uses origin/<base> when both merge-base and rev-parse resolve, and baseHash/mergeBaseHash come from it', async () => {
      setDefaultWorktreeHead();
      const logStdout = line({
        hash: 'c1'.repeat(10),
        shortHash: 'c1c1c1c',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-03T12:00:00Z',
        subject: 'feat: origin base attempt',
      });
      mockGit.raw
        .mockResolvedValueOnce('originmergebasehash\n') // merge-base origin/main
        .mockResolvedValueOnce('originbasehash\n') // rev-parse origin/main
        .mockResolvedValueOnce(logStdout); // log attempt1 (widest range succeeds)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(mockGit.raw).toHaveBeenNthCalledWith(1, ['merge-base', 'origin/main', 'HEAD']);
      expect(mockGit.raw).toHaveBeenNthCalledWith(2, ['rev-parse', 'origin/main']);
      const calledArgs = mockGit.raw.mock.calls.map((callArgs) => callArgs[0]);
      expect(calledArgs).not.toContainEqual(['merge-base', 'main', 'HEAD']);
      expect(result.baseHash).toBe('originbasehash');
      expect(result.mergeBaseHash).toBe('originmergebasehash');
      expect(result.commits).toHaveLength(1);
    });

    it('falls back to local <base> when origin/<base> throws', async () => {
      setDefaultWorktreeHead();
      const logStdout = line({
        hash: 'c2'.repeat(10),
        shortHash: 'c2c2c2c',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-03T12:00:00Z',
        subject: 'feat: local base attempt',
      });
      mockGit.raw
        .mockRejectedValueOnce(new Error('fatal: unknown revision origin/main')) // merge-base origin/main
        .mockResolvedValueOnce('localmergebasehash\n') // merge-base main
        .mockResolvedValueOnce('localbasehash\n') // rev-parse main
        .mockResolvedValueOnce(logStdout); // log attempt1

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(mockGit.raw).toHaveBeenNthCalledWith(1, ['merge-base', 'origin/main', 'HEAD']);
      expect(mockGit.raw).toHaveBeenNthCalledWith(2, ['merge-base', 'main', 'HEAD']);
      expect(mockGit.raw).toHaveBeenNthCalledWith(3, ['rev-parse', 'main']);
      expect(result.baseHash).toBe('localbasehash');
      expect(result.mergeBaseHash).toBe('localmergebasehash');
    });

    it('BUG PIN (C1): abandons a candidate whose merge-base resolves but rev-parse rejects, and does not leak the stale mergeBaseHash when the fallback candidate also fails', async () => {
      // Regression coverage for a real bug: the base-ref loop used to assign
      // `mergeBaseHash` immediately after `merge-base` resolved, THEN call
      // `rev-parse`. If rev-parse then threw (e.g. a concurrent `fetch --prune`
      // removed the ref between the two calls), the candidate was abandoned via
      // `continue` but `mergeBaseHash` was already set - so a later, wholly
      // unresolved candidate loop still returned that stale hash as the trim
      // arg's base, with a null baseRef. The fix assigns both outer refs only
      // after BOTH calls for the SAME candidate succeed.
      setDefaultWorktreeHead('feat/graph-pane', 'tiphash-c1');
      const logStdout = line({
        hash: 'e1'.repeat(10),
        shortHash: 'e1e1e1e',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-05T12:00:00Z',
        subject: 'feat: HEAD-only attempt after both base candidates fail',
      });
      mockGit.raw
        .mockResolvedValueOnce('originmergebasehash\n') // merge-base origin/main RESOLVES
        .mockRejectedValueOnce(new Error('fatal: unknown revision origin/main')) // rev-parse origin/main REJECTS
        .mockRejectedValueOnce(new Error('fatal: unknown revision main')) // merge-base main REJECTS (local candidate also abandoned)
        .mockResolvedValueOnce(logStdout); // log attempt1 (HEAD only - baseRef/mergeBaseHash both left unresolved)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      // The origin candidate must be abandoned as a whole: baseHash/mergeBaseHash
      // are null, NEVER the stale mergeBaseHash captured before rev-parse threw.
      expect(result.mergeBaseHash).toBeNull();
      expect(result.baseHash).toBeNull();

      // The log-degrade chain still runs (with no --not trim arg and no baseRef,
      // since both stayed unresolved) and still returns commits plus the
      // resolved tipHash/currentBranch from readWorktreeHead.
      const logArgs = mockGit.raw.mock.calls[3][0];
      expect(logArgs).not.toContain('--not');
      expect(logArgs).not.toContain('origin/main');
      expect(logArgs).toContain('HEAD');
      expect(result.commits).toHaveLength(1);
      expect(result.tipHash).toBe('tiphash-c1');
      expect(result.currentBranch).toBe('feat/graph-pane');
    });
  });

  // ── baseContextCount trim value ──────────────────────────────────────────

  describe('trim value: --not <mergeBaseHash>~<baseContextCount>', () => {
    it('trims to mergeBaseHash~5 (the default baseContextCount) when the merge base resolves', async () => {
      setDefaultWorktreeHead();
      const logStdout = line({
        hash: 'f1'.repeat(10),
        shortHash: 'f1f1f1f',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-06T12:00:00Z',
        subject: 'feat: default baseContextCount trim',
      });
      mockGit.raw
        .mockResolvedValueOnce('mergebase1\n') // merge-base origin/main
        .mockResolvedValueOnce('basehash1\n') // rev-parse origin/main
        .mockResolvedValueOnce(logStdout); // log attempt1 (widest range succeeds)

      await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      const attempt1Args = mockGit.raw.mock.calls[2][0];
      expect(attempt1Args).toContain('--not');
      expect(attempt1Args).toContain('mergebase1~5');
    });

    it('trims to mergeBaseHash~<explicit baseContextCount> when one is passed', async () => {
      setDefaultWorktreeHead();
      const logStdout = line({
        hash: 'f2'.repeat(10),
        shortHash: 'f2f2f2f',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-06T12:00:00Z',
        subject: 'feat: explicit baseContextCount trim',
      });
      mockGit.raw
        .mockResolvedValueOnce('mergebase1\n') // merge-base origin/main
        .mockResolvedValueOnce('basehash1\n') // rev-parse origin/main
        .mockResolvedValueOnce(logStdout); // log attempt1 (widest range succeeds)

      await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main', baseContextCount: 3 });

      const attempt1Args = mockGit.raw.mock.calls[2][0];
      expect(attempt1Args).toContain('--not');
      expect(attempt1Args).toContain('mergebase1~3');
    });

    it('disables the trim entirely when baseContextCount is 0, even though the merge base resolved', async () => {
      setDefaultWorktreeHead();
      const logStdout = line({
        hash: 'f3'.repeat(10),
        shortHash: 'f3f3f3f',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-06T12:00:00Z',
        subject: 'feat: zero baseContextCount disables trim',
      });
      mockGit.raw
        .mockResolvedValueOnce('mergebase1\n') // merge-base origin/main
        .mockResolvedValueOnce('basehash1\n') // rev-parse origin/main
        .mockResolvedValueOnce(logStdout); // log attempt1 (no --not, since baseContextCount disables it)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main', baseContextCount: 0 });

      // The merge base DID resolve (mergeBaseHash is populated), but the `> 0`
      // guard must still keep --not out of every log attempt.
      const calledArgs = mockGit.raw.mock.calls.map((callArgs) => callArgs[0]);
      for (const args of calledArgs) {
        expect(args).not.toContain('--not');
      }
      expect(result.mergeBaseHash).toBe('mergebase1');
    });
  });

  // ── 3-attempt degrade chain ───────────────────────────────────────────────

  describe('log range degrades on failure: widest range -> drop --not -> HEAD only', () => {
    it('falls back to dropping --not when the widest range (with mergeBase~N) fails', async () => {
      setDefaultWorktreeHead();
      const attempt2Stdout = line({
        hash: 'd2'.repeat(10),
        shortHash: 'd2d2d2d',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-03T12:00:00Z',
        subject: 'feat: dropped --not attempt',
      });
      mockGit.raw
        .mockResolvedValueOnce('mergebase1\n') // merge-base origin/main
        .mockResolvedValueOnce('basehash1\n') // rev-parse origin/main
        .mockRejectedValueOnce(new Error('fatal: bad revision mergebase1~5')) // log attempt1 (widest)
        .mockResolvedValueOnce(attempt2Stdout); // log attempt2 (dropped --not)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].subject).toBe('feat: dropped --not attempt');

      const attempt1Args = mockGit.raw.mock.calls[2][0];
      expect(attempt1Args).toContain('--not');
      const attempt2Args = mockGit.raw.mock.calls[3][0];
      expect(attempt2Args).not.toContain('--not');
      expect(attempt2Args).toContain('origin/main');
      expect(attempt2Args).toContain('HEAD');
    });

    it('falls back to HEAD only when both the widest range and the dropped-not range fail', async () => {
      setDefaultWorktreeHead();
      const attempt3Stdout = line({
        hash: 'd3'.repeat(10),
        shortHash: 'd3d3d3d',
        parents: '',
        author: 'Dev',
        timestamp: '2026-07-03T12:00:00Z',
        subject: 'feat: HEAD only attempt',
      });
      mockGit.raw
        .mockResolvedValueOnce('mergebase2\n') // merge-base origin/main
        .mockResolvedValueOnce('basehash2\n') // rev-parse origin/main
        .mockRejectedValueOnce(new Error('attempt1 fail')) // log attempt1 (widest)
        .mockRejectedValueOnce(new Error('attempt2 fail')) // log attempt2 (dropped --not)
        .mockResolvedValueOnce(attempt3Stdout); // log attempt3 (HEAD only)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].subject).toBe('feat: HEAD only attempt');

      const attempt3Args = mockGit.raw.mock.calls[4][0];
      expect(attempt3Args).not.toContain('--not');
      expect(attempt3Args).not.toContain('origin/main');
      expect(attempt3Args).toContain('HEAD');
      // commonArgs (log, --topo-order, --max-count, --format) + HEAD, nothing else.
      expect(attempt3Args).toHaveLength(5);
    });

    it('reports the resolved tipHash/currentBranch but an empty commit list when every log attempt fails', async () => {
      setDefaultWorktreeHead('feat/no-log', 'tiphashabc');
      mockGit.raw.mockRejectedValue(new Error('git log unavailable'));

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result.commits).toEqual([]);
      expect(result.baseHash).toBeNull();
      expect(result.mergeBaseHash).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.tipHash).toBe('tiphashabc');
      expect(result.currentBranch).toBe('feat/no-log');
    });
  });

  // ── truncation ─────────────────────────────────────────────────────────

  describe('truncation: requests maxCommits + 1, truncates the tail', () => {
    it('truncates when git log returns more than maxCommits records', async () => {
      setDefaultWorktreeHead();
      const stdout = [
        line({ hash: 'c3', shortHash: 'c3', parents: 'c2', author: 'Dev', timestamp: 't3', subject: 'third' }),
        line({ hash: 'c2', shortHash: 'c2', parents: 'c1', author: 'Dev', timestamp: 't2', subject: 'second' }),
        line({ hash: 'c1', shortHash: 'c1', parents: '', author: 'Dev', timestamp: 't1', subject: 'first' }),
      ].join('\n');
      mockGit.raw
        .mockRejectedValueOnce(new Error('no origin/main')) // merge-base origin/main
        .mockRejectedValueOnce(new Error('no local main')) // merge-base main
        .mockResolvedValueOnce(stdout); // log attempt1 (baseRef unresolved, so all 3 attempts are identical)

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main', maxCommits: 2 });

      const logArgs = mockGit.raw.mock.calls[2][0];
      expect(logArgs).toContain('--max-count=3');
      expect(result.truncated).toBe(true);
      expect(result.commits).toHaveLength(2);
      expect(result.commits.map((commit) => commit.hash)).toEqual(['c3', 'c2']);
    });

    it('does not truncate when git log returns at most maxCommits records', async () => {
      setDefaultWorktreeHead();
      const stdout = [
        line({ hash: 'c2', shortHash: 'c2', parents: 'c1', author: 'Dev', timestamp: 't2', subject: 'second' }),
        line({ hash: 'c1', shortHash: 'c1', parents: '', author: 'Dev', timestamp: 't1', subject: 'first' }),
      ].join('\n');
      mockGit.raw
        .mockRejectedValueOnce(new Error('no origin/main'))
        .mockRejectedValueOnce(new Error('no local main'))
        .mockResolvedValueOnce(stdout);

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main', maxCommits: 3 });

      const logArgs = mockGit.raw.mock.calls[2][0];
      expect(logArgs).toContain('--max-count=4');
      expect(result.truncated).toBe(false);
      expect(result.commits).toHaveLength(2);
      expect(result.commits.map((commit) => commit.hash)).toEqual(['c2', 'c1']);
    });
  });

  // ── fail-safe: all-empty result on top-level errors ───────────────────────

  describe('fail-safe: returns the all-empty result on unexpected git errors', () => {
    it('returns the all-empty result when readWorktreeHead throws', async () => {
      mockReadWorktreeHead.mockRejectedValue(new Error('worktree gone'));
      // No raw mocks needed: the outer try/catch should catch before any raw call.

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result).toEqual({
        commits: [],
        tipHash: null,
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: null,
        truncated: false,
      });
    });

    it('returns the all-empty result when simpleGit itself throws synchronously', async () => {
      const { default: simpleGit } = await import('simple-git');
      vi.mocked(simpleGit).mockImplementationOnce(() => {
        throw new Error('not a git repository');
      });
      setDefaultWorktreeHead();

      const result = await getCommitGraph({ projectPath: '/mock/project', baseBranch: 'main' });

      expect(result).toEqual({
        commits: [],
        tipHash: null,
        baseHash: null,
        mergeBaseHash: null,
        currentBranch: null,
        truncated: false,
      });
    });
  });
});
