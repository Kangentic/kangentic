/**
 * Unit tests for getFileHistory / parseFileHistoryLog - the git reader behind
 * the Changes panel's per-file history popover.
 *
 * Production source: src/main/git/file-history.ts
 *
 * `getFileHistory` is a thin orchestrator: `git log --follow --max-count=<N>
 * --format=<FILE_HISTORY_FORMAT> -- <path>`, parsed by the pure
 * `parseFileHistoryLog`. Fails SAFE: any git error (untracked file, path
 * never committed, repo error) yields `{ commits: [] }`.
 *
 * No real git process is spawned: simple-git's `git.raw` is mocked, mirroring
 * commit-graph-reader.test.ts's pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockGit } = vi.hoisted(() => {
  const rawFn = vi.fn<(args: string[]) => Promise<string>>();
  return { mockGit: { raw: rawFn } };
});

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

import { getFileHistory, parseFileHistoryLog } from '../../src/main/git/file-history';

// ── Helpers ────────────────────────────────────────────────────────────────

const UNIT = '\x1f';

/** Build one formatted `git log --format` line in the reader's real
 *  FILE_HISTORY_FORMAT shape (%H %h %an %aI %s). */
function line(fields: { hash: string; shortHash: string; author: string; timestamp: string; subject: string }): string {
  return [fields.hash, fields.shortHash, fields.author, fields.timestamp, fields.subject].join(UNIT);
}

// ── Tests: parseFileHistoryLog (pure) ──────────────────────────────────────

describe('parseFileHistoryLog', () => {
  it('parses a single commit line into a commit record', () => {
    const stdout = line({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', timestamp: '2026-07-01T00:00:00Z', subject: 'fix: parser bug' });

    const commits = parseFileHistoryLog(stdout);

    expect(commits).toEqual([
      { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', authorName: 'Ada', authorTimestamp: '2026-07-01T00:00:00Z', subject: 'fix: parser bug' },
    ]);
  });

  it('parses multiple commits in order', () => {
    const stdout = [
      line({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', timestamp: '2026-07-02T00:00:00Z', subject: 'second' }),
      line({ hash: 'b'.repeat(40), shortHash: 'bbbbbbb', author: 'Bea', timestamp: '2026-07-01T00:00:00Z', subject: 'first' }),
    ].join('\n');

    const commits = parseFileHistoryLog(stdout);

    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe('second');
    expect(commits[1].subject).toBe('first');
  });

  it('rejoins a subject containing the unit-separator character defensively', () => {
    // %s never actually contains \x1f, but the parser rejoins trailing fields
    // defensively (mirrors parseCommitGraphLog) so a stray separator never
    // truncates the subject.
    const stdout = `${'a'.repeat(40)}${UNIT}aaaaaaa${UNIT}Ada${UNIT}2026-07-01T00:00:00Z${UNIT}weird${UNIT}subject`;

    const commits = parseFileHistoryLog(stdout);

    expect(commits[0].subject).toBe('weird\x1fsubject');
  });

  it('handles Windows CRLF line endings without leaving a trailing \\r on the subject', () => {
    const stdout = [
      line({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', timestamp: '2026-07-01T00:00:00Z', subject: 'crlf test' }),
    ].join('\r\n');

    const commits = parseFileHistoryLog(stdout);

    expect(commits[0].subject).toBe('crlf test');
  });

  it('skips blank lines', () => {
    const stdout = `\n${line({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', timestamp: '2026-07-01T00:00:00Z', subject: 'only' })}\n\n`;

    const commits = parseFileHistoryLog(stdout);

    expect(commits).toHaveLength(1);
  });

  it('returns an empty array for empty stdout', () => {
    expect(parseFileHistoryLog('')).toEqual([]);
  });
});

// ── Tests: getFileHistory (orchestration) ──────────────────────────────────

describe('getFileHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs git log --follow with the correct argv and parses the result', async () => {
    mockGit.raw.mockResolvedValue(
      line({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', timestamp: '2026-07-01T00:00:00Z', subject: 'touch file' }),
    );

    const result = await getFileHistory({ projectPath: '/project', filePath: 'src/a.ts' });

    expect(mockGit.raw).toHaveBeenCalledWith(['log', '--follow', '--max-count=100', expect.stringMatching(/^--format=/), '--', 'src/a.ts']);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].subject).toBe('touch file');
  });

  it('prefers worktreePath over projectPath as the working directory', async () => {
    mockGit.raw.mockResolvedValue('');
    const simpleGit = (await import('simple-git')).default;

    await getFileHistory({ projectPath: '/project', worktreePath: '/project/.kangentic/worktrees/task', filePath: 'src/a.ts' });

    expect(simpleGit).toHaveBeenCalledWith('/project/.kangentic/worktrees/task');
  });

  it('honors a custom maxCommits', async () => {
    mockGit.raw.mockResolvedValue('');

    await getFileHistory({ projectPath: '/project', filePath: 'src/a.ts', maxCommits: 25 });

    expect(mockGit.raw).toHaveBeenCalledWith(expect.arrayContaining(['--max-count=25']));
  });

  it('fails safe to an empty result on a git error (untracked file, bad path, etc.)', async () => {
    mockGit.raw.mockRejectedValue(new Error('fatal: no such path in HEAD'));

    const result = await getFileHistory({ projectPath: '/project', filePath: 'src/never-committed.ts' });

    expect(result).toEqual({ commits: [] });
  });
});
