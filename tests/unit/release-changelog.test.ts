/**
 * Unit coverage for scripts/release-changelog.mjs, the CHANGELOG.md entry /release Step 3 writes.
 *
 * The contract:
 * 1. A commit whose only change is docs/code-review-fanout-audit.md, or a single-parent commit that
 *    changes nothing (a review pass's ledger), is skipped. A merge, which lists no files under
 *    --name-only, never is, and neither is a commit that touches the audit doc beside anything else.
 * 2. Subjects sort into Breaking Changes, Features, Fixes and Other by their conventional prefix,
 *    with the old keyword fallback for a subject that has none, and lose the prefix.
 * 3. The entry keeps CHANGELOG.md's shape: the heading, then each non-empty section in that order.
 * 4. The entry goes in after `<!-- releases -->` with one blank line on each side, in the file's own
 *    line endings, and a missing marker or an entry already there for the version is refused.
 * 5. The summary line always says how many commits were skipped, zero included.
 * 6. The command reads the git history of the checkout it lives in. A throwaway repository proves
 *    the dry run writes nothing, --write inserts once and refuses a second time, and an empty range
 *    or a missing marker exits 2. CI's checkout is shallow and has no tags, so the real history
 *    cannot be the fixture.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RELEASES_MARKER,
  REVIEW_AUDIT_DOC,
  parseGitLog,
  isReviewRecord,
  classifySubject,
  buildEntry,
  insertEntry,
  formatSummary,
  formatSkippedCommits,
  localDate,
} from '../../scripts/release-changelog.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');

interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  files: string[];
}

function commitOf(hash: string, subject: string, files: string[], parents: string[] = ['p0000000']): Commit {
  return { hash, parents, subject, files };
}

describe('parseGitLog', () => {
  it('reads each record, its parents and its files, an empty commit and CRLF included', () => {
    const raw = [
      '\x1eaaaa1111\x1fp1111111\x1ffeat(board): add a thing\n\nsrc/a.ts\nsrc/b.ts\n',
      '\x1ebbbb2222\x1fp2222222\x1fchore(review): record refuted findings and decisions\n',
      '\x1ecccc3333\x1fp3333333 p4444444\x1fMerge branch x\r\n',
    ].join('');
    expect(parseGitLog(raw)).toEqual([
      { hash: 'aaaa1111', parents: ['p1111111'], subject: 'feat(board): add a thing', files: ['src/a.ts', 'src/b.ts'] },
      { hash: 'bbbb2222', parents: ['p2222222'], subject: 'chore(review): record refuted findings and decisions', files: [] },
      { hash: 'cccc3333', parents: ['p3333333', 'p4444444'], subject: 'Merge branch x', files: [] },
    ]);
  });
});

describe('isReviewRecord', () => {
  it('skips a commit that only touches the fan-out audit doc', () => {
    expect(isReviewRecord(commitOf('a', 'docs(review): record task 861 pass', [REVIEW_AUDIT_DOC]))).toBe(true);
  });

  it('skips a single-parent commit that changes nothing', () => {
    expect(isReviewRecord(commitOf('a', 'chore(review): record refuted findings and decisions', []))).toBe(true);
  });

  it('keeps a merge, which lists no files', () => {
    expect(isReviewRecord(commitOf('a', 'Merge pull request #1', [], ['p1', 'p2']))).toBe(false);
  });

  it('keeps a commit that touches the audit doc beside anything else', () => {
    expect(isReviewRecord(commitOf('a', 'fix(review): close a gap', [REVIEW_AUDIT_DOC, 'src/a.ts']))).toBe(false);
  });

  it('keeps a commit that touches one other file', () => {
    expect(isReviewRecord(commitOf('a', 'docs: correct a count', ['docs/architecture.md']))).toBe(false);
  });
});

describe('classifySubject', () => {
  it.each([
    ['feat(board): count pills on the view tabs', 'features', 'Count pills on the view tabs'],
    ['fix: keep a reused pid out of a kill', 'fixes', 'Keep a reused pid out of a kill'],
    ['docs(review): record a pass', 'other', 'Record a pass'],
    ['test(e2e): wait for the marker', 'other', 'Wait for the marker'],
    ['feat!: drop the old config', 'breaking', 'Drop the old config'],
    ['fix(api)!: rename a field', 'breaking', 'Rename a field'],
    ['chore: note a BREAKING CHANGE in the subject', 'breaking', 'Note a BREAKING CHANGE in the subject'],
    ['Add a launcher', 'features', 'Add a launcher'],
    ['Fix the crash', 'fixes', 'Fix the crash'],
    ['Resolve the race', 'fixes', 'Resolve the race'],
    // Each of these reaches the keyword fallback through exactly one alternative, so dropping that
    // alternative from the regex moves the subject to Other.
    ['Implement a launcher', 'features', 'Implement a launcher'],
    ['Create a launcher', 'features', 'Create a launcher'],
    ['Improve feature flags', 'features', 'Improve feature flags'],
    ['Squash a bug', 'fixes', 'Squash a bug'],
    ['Tidy up', 'other', 'Tidy up'],
  ])('sorts %j into %s', (subject, section, text) => {
    expect(classifySubject(subject)).toEqual({ section, text });
  });
});

describe('buildEntry', () => {
  const commits: Commit[] = [
    commitOf('aaaa1111', 'docs(review): record task 880 pass', [REVIEW_AUDIT_DOC]),
    commitOf('bbbb2222', 'fix(pty): keep a reused pid out of a kill', ['src/main/pty/kill.ts']),
    commitOf('cccc3333', 'feat(board): count pills on the view tabs', ['src/renderer/ViewToggle.tsx']),
    commitOf('dddd4444', 'chore(review): record refuted findings and decisions', []),
    commitOf('eeee5555', 'test: pin the kill', ['tests/unit/kill.test.ts']),
    commitOf('ffff6666', 'feat: add the second pill', ['src/renderer/Pill.tsx']),
  ];

  it('writes the CHANGELOG.md shape, sections in order, records skipped, log order kept', () => {
    const result = buildEntry({ version: '1.2.0', date: '2026-10-22', commits });
    expect(result.entry).toBe([
      '## [v1.2.0] - 2026-10-22',
      '',
      '### Features',
      '- Count pills on the view tabs (cccc3333)',
      '- Add the second pill (ffff6666)',
      '',
      '### Fixes',
      '- Keep a reused pid out of a kill (bbbb2222)',
      '',
      '### Other',
      '- Pin the kill (eeee5555)',
      '',
    ].join('\n'));
    expect(result.included).toBe(4);
    expect(result.skipped).toBe(2);
    expect(result.skippedCommits.map((commit: Commit) => commit.hash)).toEqual(['aaaa1111', 'dddd4444']);
    expect(result.counts).toEqual({ breaking: 0, features: 2, fixes: 1, other: 1 });
  });

  it('leaves out a section with no entries', () => {
    const result = buildEntry({ version: '1.2.1', date: '2026-10-23', commits: [commitOf('aaaa1111', 'fix: one fix', ['src/a.ts'])] });
    expect(result.entry).toBe('## [v1.2.1] - 2026-10-23\n\n### Fixes\n- One fix (aaaa1111)\n');
  });
});

describe('insertEntry', () => {
  const entry = '## [v1.2.0] - 2026-10-22\n\n### Fixes\n- One fix (aaaa1111)\n';
  const changelog = `# Changelog\n\nIntro.\n\n${RELEASES_MARKER}\n\n## [v1.1.0] - 2026-10-19\n\n### Fixes\n- Older fix (bbbb2222)\n`;

  it('puts the entry after the marker with one blank line on each side', () => {
    expect(insertEntry(changelog, entry, '1.2.0')).toBe(
      `# Changelog\n\nIntro.\n\n${RELEASES_MARKER}\n\n${entry}\n## [v1.1.0] - 2026-10-19\n\n### Fixes\n- Older fix (bbbb2222)\n`,
    );
  });

  it('keeps a CRLF file in CRLF', () => {
    const inserted = insertEntry(changelog.replace(/\n/g, '\r\n'), entry, '1.2.0');
    expect(inserted).toBe(insertEntry(changelog, entry, '1.2.0').replace(/\n/g, '\r\n'));
  });

  it('handles a marker on the last line', () => {
    expect(insertEntry(`# Changelog\n\n${RELEASES_MARKER}`, entry, '1.2.0')).toBe(`# Changelog\n\n${RELEASES_MARKER}\n\n${entry}\n`);
  });

  it('collapses extra blank lines after the marker to one blank line on each side', () => {
    const spaced = `# Changelog\n\nIntro.\n\n${RELEASES_MARKER}\n\n\n\n## [v1.1.0] - 2026-10-19\n\n### Fixes\n- Older fix (bbbb2222)\n`;
    expect(insertEntry(spaced, entry, '1.2.0')).toBe(
      `# Changelog\n\nIntro.\n\n${RELEASES_MARKER}\n\n${entry}\n## [v1.1.0] - 2026-10-19\n\n### Fixes\n- Older fix (bbbb2222)\n`,
    );
  });

  it('refuses a file with no marker', () => {
    expect(() => insertEntry('# Changelog\n', entry, '1.2.0')).toThrow(/no <!-- releases --> marker/);
  });

  it('refuses a second entry for the same version', () => {
    const once = insertEntry(changelog, entry, '1.2.0');
    expect(() => insertEntry(once, entry, '1.2.0')).toThrow(/already has an entry for v1\.2\.0/);
  });
});

describe('localDate', () => {
  // Fixed LOCAL dates, built with the multi-argument Date constructor (months are zero-based), so the
  // result never depends on the clock or on the time zone the test runs in.
  it('zero-pads the month and the day', () => {
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('writes a two-digit month and day as they are, with the month one-based', () => {
    expect(localDate(new Date(2026, 10, 23))).toBe('2026-11-23');
  });
});

describe('formatSummary', () => {
  it('names the skipped count even when it is zero', () => {
    expect(formatSummary({ version: '1.2.0', included: 1, skipped: 0, counts: { breaking: 0, features: 0, fixes: 1, other: 0 } })).toBe(
      'release-changelog: v1.2.0 lists 1 commit (0 breaking, 0 features, 1 fixes, 0 other), skipped 0 review-record commits',
    );
  });

  it('names each skipped commit by hash and subject', () => {
    expect(formatSkippedCommits([commitOf('aaaa1111', 'docs(review): record task 880 pass', [REVIEW_AUDIT_DOC])])).toBe(
      '  skipped aaaa1111 docs(review): record task 880 pass',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The command, against a throwaway repository
// ---------------------------------------------------------------------------------------------

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const scratchDirectory of scratchDirectories.splice(0)) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function git(repository: string, gitArguments: string[]): void {
  execFileSync('git', ['-C', repository, '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.com', '-c', 'commit.gpgsign=false', ...gitArguments], {
    stdio: 'pipe',
  });
}

function commitFile(repository: string, relativePath: string, content: string, subject: string): void {
  fs.mkdirSync(path.dirname(path.join(repository, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(repository, relativePath), content);
  git(repository, ['add', relativePath]);
  git(repository, ['commit', '--no-verify', '-m', subject]);
}

const BASE_CHANGELOG = `# Changelog\n\n${RELEASES_MARKER}\n\n## [v1.1.0] - 2026-10-19\n\n### Fixes\n- Older fix (bbbb2222)\n`;

/**
 * The one repository every test copies from: a copy of the script (it reads the history of the
 * checkout it lives in), a CHANGELOG.md, a v1.1.0 tag, and after the tag one feature, one fix, one
 * audit-doc record and one empty ledger commit. Building it costs about a dozen git processes, so it
 * is built once, in beforeAll, rather than once per test.
 */
let templateRepository = '';

function buildTemplateRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'release-changelog-template-'));
  git(repository, ['init', '--quiet']);
  fs.mkdirSync(path.join(repository, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'release-changelog.mjs'), path.join(repository, 'scripts', 'release-changelog.mjs'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'is-entrypoint.mjs'), path.join(repository, 'scripts', 'lib', 'is-entrypoint.mjs'));
  fs.writeFileSync(path.join(repository, 'CHANGELOG.md'), BASE_CHANGELOG);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--no-verify', '-m', 'chore(release): v1.1.0']);
  git(repository, ['tag', 'v1.1.0']);
  commitFile(repository, 'src/feature.ts', 'export {};\n', 'feat(board): add a pill');
  commitFile(repository, 'src/fix.ts', 'export {};\n', 'fix(pty): keep a pid');
  commitFile(repository, REVIEW_AUDIT_DOC, 'row\n', 'docs(review): record the task 1 pass');
  git(repository, ['commit', '--no-verify', '--allow-empty', '-m', 'chore(review): record refuted findings and decisions']);
  return repository;
}

/**
 * A private copy of the template repository, with `changelog` as its CHANGELOG.md. The script reads
 * CHANGELOG.md from disk, and the range under test (v1.1.0..HEAD) never includes the commit that
 * added it, so overwriting the file in the copy changes what the script sees and nothing else.
 */
function makeRepository(changelog: string): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'release-changelog-'));
  scratchDirectories.push(repository);
  fs.cpSync(templateRepository, repository, { recursive: true });
  fs.writeFileSync(path.join(repository, 'CHANGELOG.md'), changelog);
  return repository;
}

function runScript(repository: string, scriptArguments: string[]): ScriptResult {
  try {
    const stdout = execFileSync('node', [path.join(repository, 'scripts', 'release-changelog.mjs'), ...scriptArguments], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: execError.status ?? -1, stdout: execError.stdout ?? '', stderr: execError.stderr ?? '' };
  }
}

describe('release-changelog command', () => {
  beforeAll(() => {
    templateRepository = buildTemplateRepository();
  }, 60_000);

  afterAll(() => {
    fs.rmSync(templateRepository, { recursive: true, force: true });
  });

  it('prints the entry and the skip count on a dry run, and writes nothing', () => {
    const repository = makeRepository(BASE_CHANGELOG);
    const result = runScript(repository, ['v1.1.0', '1.2.0', '--date', '2026-10-22']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^## \[v1\.2\.0\] - 2026-10-22\n\n### Features\n- Add a pill \([0-9a-f]{8}\)\n\n### Fixes\n- Keep a pid \([0-9a-f]{8}\)\n/);
    expect(result.stdout).toContain('lists 2 commits (0 breaking, 1 features, 1 fixes, 0 other), skipped 2 review-record commits, dry run (nothing written)');
    expect(result.stdout).toMatch(/\n {2}skipped [0-9a-f]{8} chore\(review\): record refuted findings and decisions\n {2}skipped [0-9a-f]{8} docs\(review\): record the task 1 pass\n$/);
    expect(fs.readFileSync(path.join(repository, 'CHANGELOG.md'), 'utf8')).toBe(BASE_CHANGELOG);
  });

  it('inserts the entry with --write and refuses a second --write', () => {
    const repository = makeRepository(BASE_CHANGELOG);
    const first = runScript(repository, ['v1.1.0', '1.2.0', '--write', '--date', '2026-10-22']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(', written to CHANGELOG.md');
    const written = fs.readFileSync(path.join(repository, 'CHANGELOG.md'), 'utf8');
    expect(written.startsWith(`# Changelog\n\n${RELEASES_MARKER}\n\n## [v1.2.0] - 2026-10-22\n\n### Features\n`)).toBe(true);
    expect(written).toContain('\n\n## [v1.1.0] - 2026-10-19\n');

    const second = runScript(repository, ['v1.1.0', '1.2.0', '--write', '--date', '2026-10-22']);
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain('already has an entry for v1.2.0');
    expect(fs.readFileSync(path.join(repository, 'CHANGELOG.md'), 'utf8')).toBe(written);
  });

  it('exits 2 on an empty range and names the tag to pass', () => {
    const repository = makeRepository(BASE_CHANGELOG);
    git(repository, ['tag', 'v1.2.0']);
    const result = runScript(repository, ['v1.2.0', '1.2.0']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('v1.2.0..HEAD holds no commits');
    expect(result.stderr).toContain('the tag Step 0 captured');
  });

  it('exits 2 with --write on a CHANGELOG.md that has no marker', () => {
    const repository = makeRepository('# Changelog\n');
    const result = runScript(repository, ['v1.1.0', '1.2.0', '--write']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no <!-- releases --> marker');
  });

  it.each([
    [['v1.1.0']],
    [['v1.1.0', '1.2.0', 'extra']],
    [['v1.1.0', '1.2.0', '--date']],
    [['v1.1.0', '1.2.0', '--date', '22-10-2026']],
  ])('exits 2 with the usage line for %j', (scriptArguments) => {
    const result = runScript(REPO_ROOT, scriptArguments);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/release-changelog.mjs');
  });

  it('exits 2 for a version written with its v', () => {
    const result = runScript(REPO_ROOT, ['v1.1.0', 'v1.2.0']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('pass it as X.Y.Z, without the v');
  });

  it('exits 2 for a previous tag that starts with a dash, before git sees it as an option', () => {
    // Run in a throwaway repository, not REPO_ROOT. If the guard regressed, `git log --output=x..HEAD`
    // would write a file named `x..HEAD` into the repository the script lives in, and that has to be
    // the scratch copy.
    const repository = makeRepository(BASE_CHANGELOG);
    const result = runScript(repository, ['--output=x', '1.2.0']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('git log would read it as an option');
    expect(fs.existsSync(path.join(repository, 'x..HEAD'))).toBe(false);
  });

  it('exits 2 for a tag the repository does not have', () => {
    const repository = makeRepository(BASE_CHANGELOG);
    const result = runScript(repository, ['v9.9.9', '1.2.0']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('git log v9.9.9..HEAD failed');
  });
});
