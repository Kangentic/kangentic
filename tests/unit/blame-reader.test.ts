/**
 * Unit tests for getBlame / parseBlamePorcelain - the git reader behind the
 * DiffViewer's blame gutter.
 *
 * Production source: src/main/git/blame.ts
 *
 * `getBlame` is a thin orchestrator: `git blame --line-porcelain -- <path>`,
 * parsed by the pure `parseBlamePorcelain`. With `--line-porcelain`, the full
 * commit-metadata block repeats for EVERY line (not just the first line of a
 * same-commit run): a header (`<sha> <origLine> <finalLine>`), then `author `
 * / `author-time ` / ... meta lines, terminated by the tab-prefixed source
 * line. Fails SAFE: any git error (untracked, binary, deleted, repo error)
 * yields `{ lines: [] }`.
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

import { getBlame, parseBlamePorcelain } from '../../src/main/git/blame';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build one `--line-porcelain` block: header + meta lines + tab-prefixed content. */
function porcelainBlock(fields: {
  hash: string;
  origLine: number;
  finalLine: number;
  author: string;
  authorTimeSeconds?: number;
  summary: string;
  content: string;
  filename?: string;
}): string {
  const lines = [
    `${fields.hash} ${fields.origLine} ${fields.finalLine} 1`,
    `author ${fields.author}`,
    'author-mail <author@example.com>',
  ];
  if (fields.authorTimeSeconds !== undefined) lines.push(`author-time ${fields.authorTimeSeconds}`);
  lines.push(
    'author-tz +0000',
    `committer ${fields.author}`,
    'committer-mail <author@example.com>',
    'committer-time 1751328000',
    'committer-tz +0000',
    `summary ${fields.summary}`,
    `filename ${fields.filename ?? 'src/a.ts'}`,
    `\t${fields.content}`,
  );
  return lines.join('\n');
}

// ── Tests: parseBlamePorcelain (pure) ──────────────────────────────────────

describe('parseBlamePorcelain', () => {
  it('parses a single line block into a blame record', () => {
    const stdout = porcelainBlock({
      hash: 'a'.repeat(40),
      origLine: 1,
      finalLine: 1,
      author: 'Ada',
      authorTimeSeconds: 1751328000, // 2025-07-01T00:00:00.000Z
      summary: 'fix: parser bug',
      content: 'const x = 1;',
    });

    const lines = parseBlamePorcelain(stdout);

    expect(lines).toEqual([
      { line: 1, hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', date: '2025-07-01T00:00:00.000Z' },
    ]);
  });

  it('parses multiple repeated blocks (one per line, per --line-porcelain)', () => {
    const stdout = [
      porcelainBlock({ hash: 'a'.repeat(40), origLine: 1, finalLine: 1, author: 'Ada', authorTimeSeconds: 1751328000, summary: 'first', content: 'line one' }),
      porcelainBlock({ hash: 'b'.repeat(40), origLine: 5, finalLine: 2, author: 'Bea', authorTimeSeconds: 1751414400, summary: 'second', content: 'line two' }),
    ].join('\n');

    const lines = parseBlamePorcelain(stdout);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 1, shortHash: 'aaaaaaa', author: 'Ada' });
    expect(lines[1]).toMatchObject({ line: 2, shortHash: 'bbbbbbb', author: 'Bea' });
  });

  it('renders an uncommitted line (all-zero sha) as an "Uncommitted" record with no date', () => {
    const stdout = porcelainBlock({
      hash: '0'.repeat(40),
      origLine: 3,
      finalLine: 3,
      author: 'Not Committed Yet',
      summary: '',
      content: 'const y = 2;',
    });

    const lines = parseBlamePorcelain(stdout);

    expect(lines).toEqual([
      { line: 3, hash: '0'.repeat(40), shortHash: '0000000', author: 'Uncommitted', date: '' },
    ]);
  });

  it('handles Windows CRLF line endings', () => {
    const stdout = porcelainBlock({
      hash: 'a'.repeat(40),
      origLine: 1,
      finalLine: 1,
      author: 'Ada',
      authorTimeSeconds: 1751328000,
      summary: 'crlf test',
      content: 'const z = 3;',
    }).replace(/\n/g, '\r\n');

    const lines = parseBlamePorcelain(stdout);

    expect(lines).toEqual([
      { line: 1, hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Ada', date: '2025-07-01T00:00:00.000Z' },
    ]);
  });

  it('returns an empty array for empty stdout', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });
});

// ── Tests: getBlame (orchestration) ────────────────────────────────────────

describe('getBlame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs git blame --line-porcelain with the correct argv and parses the result', async () => {
    mockGit.raw.mockResolvedValue(
      porcelainBlock({ hash: 'a'.repeat(40), origLine: 1, finalLine: 1, author: 'Ada', authorTimeSeconds: 1751328000, summary: 'touch', content: 'x' }),
    );

    const result = await getBlame({ projectPath: '/project', filePath: 'src/a.ts' });

    expect(mockGit.raw).toHaveBeenCalledWith(['blame', '--line-porcelain', '--', 'src/a.ts']);
    expect(result.lines).toHaveLength(1);
  });

  it('prefers worktreePath over projectPath as the working directory', async () => {
    mockGit.raw.mockResolvedValue('');
    const simpleGit = (await import('simple-git')).default;

    await getBlame({ projectPath: '/project', worktreePath: '/project/.kangentic/worktrees/task', filePath: 'src/a.ts' });

    expect(simpleGit).toHaveBeenCalledWith('/project/.kangentic/worktrees/task');
  });

  it('fails safe to an empty result on a git error (untracked, binary, deleted file, etc.)', async () => {
    mockGit.raw.mockRejectedValue(new Error('fatal: no such path in HEAD'));

    const result = await getBlame({ projectPath: '/project', filePath: 'src/never-committed.ts' });

    expect(result).toEqual({ lines: [] });
  });
});
