/**
 * Unit tests for countLocalOnlyCommits -- the merge/remote-aware count behind
 * the Done-move probe. It reports only commits the move would actually destroy:
 * commits that exist solely on this local branch and nowhere recoverable (not
 * pushed, not merged into the base by content, not in a merged PR).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The helper builds a simple-git instance and drives everything through raw().
const mockGit = {
  raw: vi.fn<(args: string[]) => Promise<string>>(),
};

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

// The squash signal calls the PR connector registry; mock it so no `gh` spawns.
const mockResolvePRByNumber = vi.fn<(repoCwd: string, prNumber: number) => Promise<{ state: string } | null>>();
vi.mock('../../src/main/pr/pr-registry', () => ({
  resolvePRByNumber: (repoCwd: string, prNumber: number) => mockResolvePRByNumber(repoCwd, prNumber),
}));

import { countLocalOnlyCommits } from '../../src/main/git/local-only-commits';

/**
 * Wire git.raw responses by subcommand. `cherry` may be a string (returned for
 * any upstream) or a map keyed by the upstream ref (for the ladder test); an
 * Error value (or a missing key) makes that `git cherry` invocation throw.
 */
function setGit(options: {
  revList: string;
  base?: string | Error;
  cherry?: string | Error | Record<string, string | Error>;
}): void {
  mockGit.raw.mockImplementation(async (args: string[]) => {
    const subcommand = args[0];
    if (subcommand === 'rev-list') return options.revList;
    if (subcommand === 'config') {
      if (options.base instanceof Error || options.base === undefined) throw new Error('key not set');
      return options.base;
    }
    if (subcommand === 'cherry') {
      const upstream = args[2];
      let value: string | Error | undefined = options.cherry as string | Error | undefined;
      if (options.cherry && typeof options.cherry === 'object' && !(options.cherry instanceof Error)) {
        value = options.cherry[upstream];
      }
      if (value === undefined || value instanceof Error) throw new Error(`no upstream ${upstream}`);
      return value;
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  });
}

/** Build `git cherry -v` output lines: '-' = present upstream by patch-id, '+' = absent. */
function cherryLines(entries: Array<{ sign: '+' | '-'; sha: string }>): string {
  return entries.map((entry) => `${entry.sign} ${entry.sha} some subject`).join('\n');
}

describe('countLocalOnlyCommits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePRByNumber.mockResolvedValue(null);
  });

  it('returns 0 for a rebase-merged branch (commits present upstream by patch-id)', async () => {
    // The repro: the pre-rebase commits are unreachable from the remote by SHA,
    // but their rebased copies live on origin/main, so `git cherry` marks them -.
    setGit({
      revList: 'sha1\nsha2\nsha3',
      base: 'main',
      cherry: cherryLines([
        { sign: '-', sha: 'sha1' },
        { sign: '-', sha: 'sha2' },
        { sign: '-', sha: 'sha3' },
      ]),
    });

    const count = await countLocalOnlyCommits('/mock/worktree');

    expect(count).toBe(0);
    expect(mockResolvePRByNumber).not.toHaveBeenCalled();
  });

  it('counts genuinely unmerged local commits (all absent upstream)', async () => {
    setGit({
      revList: 'sha1\nsha2',
      base: 'main',
      cherry: cherryLines([
        { sign: '+', sha: 'sha1' },
        { sign: '+', sha: 'sha2' },
      ]),
    });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(2);
  });

  it('counts only the commits absent upstream in a mixed branch', async () => {
    setGit({
      revList: 'sha1\nsha2\nsha3',
      base: 'main',
      cherry: cherryLines([
        { sign: '-', sha: 'sha1' },
        { sign: '+', sha: 'sha2' },
        { sign: '+', sha: 'sha3' },
      ]),
    });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(2);
  });

  it('returns 0 and never runs git cherry when nothing is local-only', async () => {
    setGit({ revList: '', base: 'main' });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(0);
    const cherryCalls = mockGit.raw.mock.calls.filter((call) => call[0][0] === 'cherry');
    expect(cherryCalls).toHaveLength(0);
  });

  it('falls back to the base ladder when origin/<base> is missing', async () => {
    setGit({
      revList: 'sha1',
      base: 'main',
      cherry: {
        'origin/main': new Error('no such ref'),
        main: cherryLines([{ sign: '-', sha: 'sha1' }]),
      },
    });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(0);
  });

  it('defaults the base to main when kangentic.baseBranch is unset', async () => {
    setGit({
      revList: 'sha1',
      base: new Error('unset'),
      cherry: {
        'origin/main': cherryLines([{ sign: '-', sha: 'sha1' }]),
      },
    });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(0);
  });

  it('treats a squash-merge as clean when the stored PR state is merged (no gh call)', async () => {
    // Squash collapses the commits into one whose patch-id matches none of them,
    // so cherry still marks them +; the linked PR's merged state is the signal.
    setGit({
      revList: 'sha1\nsha2',
      base: 'main',
      cherry: cherryLines([
        { sign: '+', sha: 'sha1' },
        { sign: '+', sha: 'sha2' },
      ]),
    });

    const count = await countLocalOnlyCommits('/mock/worktree', { prNumber: 42, prState: 'merged' });

    expect(count).toBe(0);
    expect(mockResolvePRByNumber).not.toHaveBeenCalled();
  });

  it('resolves a fresh PR state when the stored state is stale (merged just now)', async () => {
    setGit({
      revList: 'sha1\nsha2',
      base: 'main',
      cherry: cherryLines([
        { sign: '+', sha: 'sha1' },
        { sign: '+', sha: 'sha2' },
      ]),
    });
    mockResolvePRByNumber.mockResolvedValue({ state: 'merged' });

    const count = await countLocalOnlyCommits('/mock/worktree', { prNumber: 42, prState: 'open' });

    expect(count).toBe(0);
    expect(mockResolvePRByNumber).toHaveBeenCalledWith('/mock/worktree', 42);
  });

  it('keeps the count when the linked PR is open / not merged', async () => {
    setGit({
      revList: 'sha1\nsha2',
      base: 'main',
      cherry: cherryLines([
        { sign: '+', sha: 'sha1' },
        { sign: '+', sha: 'sha2' },
      ]),
    });
    mockResolvePRByNumber.mockResolvedValue({ state: 'open' });

    expect(await countLocalOnlyCommits('/mock/worktree', { prNumber: 42, prState: 'open' })).toBe(2);
  });

  it('falls back to the local-only count when git cherry fails entirely', async () => {
    // No content filtering possible -> never hide work: count all local-only.
    setGit({
      revList: 'sha1\nsha2',
      base: 'main',
      cherry: new Error('cherry blew up'),
    });

    expect(await countLocalOnlyCommits('/mock/worktree')).toBe(2);
  });

  it('keeps the count when the fresh PR lookup throws (gh missing / offline)', async () => {
    setGit({
      revList: 'sha1',
      base: 'main',
      cherry: cherryLines([{ sign: '+', sha: 'sha1' }]),
    });
    mockResolvePRByNumber.mockRejectedValue(new Error('gh not found'));

    expect(await countLocalOnlyCommits('/mock/worktree', { prNumber: 9, prState: 'open' })).toBe(1);
  });
});
