import { describe, it, expect } from 'vitest';
import { parseCommitGraphLog } from '../../src/main/git/commit-graph';

// Unit coverage for the pure `git log --format` parser (src/main/git/commit-graph.ts),
// which uses the ASCII unit separator (\x1f) between fields so a commit subject
// can never collide with the delimiter. No git spawn; hand-built log output.

const UNIT = '\x1f';

/** Build one formatted log line: %H %h %P %an %aI %s joined by the unit separator. */
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

describe('parseCommitGraphLog', () => {
  it('parses a single commit with one parent', () => {
    const stdout = line({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      parents: 'b'.repeat(40),
      author: 'Ada Lovelace',
      timestamp: '2026-07-03T12:00:00-04:00',
      subject: 'feat: add commit graph',
    });
    const commits = parseCommitGraphLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      parents: ['b'.repeat(40)],
      authorName: 'Ada Lovelace',
      authorTimestamp: '2026-07-03T12:00:00-04:00',
      subject: 'feat: add commit graph',
    });
  });

  it('splits multiple parents on a merge commit', () => {
    const stdout = line({
      hash: 'm',
      shortHash: 'mmmmmmm',
      parents: 'p1 p2 p3',
      author: 'Dev',
      timestamp: '2026-07-03T12:00:00Z',
      subject: 'Merge three branches',
    });
    const commits = parseCommitGraphLog(stdout);
    expect(commits[0].parents).toEqual(['p1', 'p2', 'p3']);
  });

  it('returns an empty parents array for a root commit', () => {
    const stdout = line({
      hash: 'r',
      shortHash: 'rrrrrrr',
      parents: '',
      author: 'Dev',
      timestamp: '2026-07-03T12:00:00Z',
      subject: 'initial commit',
    });
    const commits = parseCommitGraphLog(stdout);
    expect(commits[0].parents).toEqual([]);
  });

  it('returns no commits for empty or whitespace-only output', () => {
    expect(parseCommitGraphLog('')).toEqual([]);
    expect(parseCommitGraphLog('\n  \n')).toEqual([]);
  });

  it('parses multiple commits, newest first, skipping blank lines', () => {
    const stdout = [
      line({ hash: 'c2', shortHash: 'c2', parents: 'c1', author: 'A', timestamp: 't2', subject: 'second' }),
      line({ hash: 'c1', shortHash: 'c1', parents: '', author: 'A', timestamp: 't1', subject: 'first' }),
      '',
    ].join('\n');
    const commits = parseCommitGraphLog(stdout);
    expect(commits.map((commit) => commit.hash)).toEqual(['c2', 'c1']);
    expect(commits[1].parents).toEqual([]);
  });

  it('splits on CRLF line endings without leaving a trailing \\r on the subject', () => {
    // Windows git can emit CRLF-terminated log output. The parser must split on
    // /\r?\n/ (not '\n') so the \r never gets folded into the last field
    // (subject) of the line it terminates. A trailing '\r\n' after the final
    // record (the shape real git output takes) corrupts BOTH lines under a
    // plain '\n' split, since the split leaves a stray '\r' at the end of
    // every segment that was followed by a CRLF terminator.
    const stdout =
      [
        line({ hash: 'c2', shortHash: 'c2', parents: 'c1', author: 'A', timestamp: 't2', subject: 'feat: add graph' }),
        line({ hash: 'c1', shortHash: 'c1', parents: '', author: 'A', timestamp: 't1', subject: 'chore: init' }),
      ].join('\r\n') + '\r\n';

    const commits = parseCommitGraphLog(stdout);

    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe('feat: add graph');
    expect(commits[1].hash).toBe('c1');
    expect(commits[1].subject).toBe('chore: init');
  });

  it('preserves a subject that itself contains a separator character', () => {
    // Defensive: %s never contains \x1f in practice, but if it did the parser
    // rejoins trailing fields rather than truncating the subject.
    const stdout = ['h', 'hh', '', 'A', 't', 'weird', 'subject'].join(UNIT);
    const commits = parseCommitGraphLog(stdout);
    expect(commits[0].subject).toBe(`weird${UNIT}subject`);
  });
});
