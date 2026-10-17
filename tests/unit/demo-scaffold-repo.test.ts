/**
 * scripts/lib/demo-scaffold-repo.mjs turns a scaffold folder (scripts/demo-repos/<name>) plus its
 * commit plan (commits.json) into a real git repository with a real history, pinned so the same
 * plan produces the same blob and commit hashes on every machine. That determinism is the reason
 * the web demo can ship a baked history fixture (tests/captures/fixtures/demo/history/*.json)
 * instead of recomputing git log output at build time. This test builds the real contoso-web
 * scaffold and checks the result against that fixture with git itself, so a scaffold or plan edit
 * that forgets to re-run scripts/capture-demo-history.mjs is caught here rather than shipping a
 * stale fixture, and it proves the hashes reproduce on a different OS than the one that captured
 * them (the fixture was captured on Windows; this file also runs on CI's Linux).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScaffoldRepo, readCommitPlan, stageScaffoldRefresh } from '../../scripts/lib/demo-scaffold-repo.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAFFOLD_DIR = path.join(REPO_ROOT, 'scripts/demo-repos/contoso-web');
const HISTORY_FIXTURE_PATH = path.join(
  REPO_ROOT,
  'tests/captures/fixtures/demo/history/contoso-web.json',
);

interface CommitPlanAuthor {
  name: string;
  email: string;
}

interface CommitPlanCommit {
  subject: string;
  date: string;
  paths: string[];
}

interface CommitPlan {
  author: CommitPlanAuthor;
  commits: CommitPlanCommit[];
}

interface HistoryFixtureCommit {
  hash: string;
  subject: string;
}

interface HistoryFixture {
  tipHash: string;
  commits: HistoryFixtureCommit[];
}

function readHistoryFixture(): HistoryFixture {
  const raw = JSON.parse(fs.readFileSync(HISTORY_FIXTURE_PATH, 'utf8')) as HistoryFixture;
  return raw;
}

function runGit(targetDirectory: string, args: string[]): string {
  return execFileSync('git', ['-C', targetDirectory, ...args], { encoding: 'utf8' });
}

function runGitLines(targetDirectory: string, args: string[]): string[] {
  return runGit(targetDirectory, args)
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Every real file the scaffold ships, forward-slashed, excluding the plan file itself. */
function listScaffoldFiles(scaffoldDirectory: string, prefix = ''): string[] {
  const relativePaths: string[] = [];
  for (const entry of fs.readdirSync(scaffoldDirectory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'commits.json') {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      relativePaths.push(...listScaffoldFiles(path.join(scaffoldDirectory, entry.name), relativePath));
    } else {
      relativePaths.push(relativePath);
    }
  }
  return relativePaths;
}

/** Writes a tiny synthetic scaffold (a handful of files plus a commits.json plan) for the error-path tests. */
function writeSyntheticScaffold(
  scaffoldDirectory: string,
  files: Record<string, string>,
  plan: unknown,
): void {
  fs.mkdirSync(scaffoldDirectory, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(scaffoldDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  if (plan !== undefined) {
    fs.writeFileSync(path.join(scaffoldDirectory, 'commits.json'), JSON.stringify(plan));
  }
}

describe('demo-scaffold-repo', () => {
  let tempRoot: string;
  let scaffoldTargetDir: string;
  let builtAuthor: CommitPlanAuthor;

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-scaffold-test-'));
    scaffoldTargetDir = path.join(tempRoot, 'contoso-web');
    builtAuthor = buildScaffoldRepo(SCAFFOLD_DIR, scaffoldTargetDir) as CommitPlanAuthor;
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('hash reproducibility and fixture currency', () => {
    it('reproduces the tip hash baked into the history fixture', () => {
      const headHash = runGit(scaffoldTargetDir, ['rev-parse', 'HEAD']).trim();
      const historyFixture = readHistoryFixture();
      expect(headHash).toBe(historyFixture.tipHash);
    });

    it('reproduces the fixture commit hashes, newest first', () => {
      const historyFixture = readHistoryFixture();
      const builtHashes = runGitLines(scaffoldTargetDir, ['log', '--format=%H']);
      // Vacuity guard: an empty commits array on both sides would satisfy the equality below
      // without ever exercising a real commit.
      expect(builtHashes.length).toBeGreaterThan(0);
      expect(builtHashes).toEqual(historyFixture.commits.map((commit) => commit.hash));
    });

    it('reproduces the plan subjects, oldest first in the plan and newest first in the log', () => {
      const commitPlan = readCommitPlan(SCAFFOLD_DIR) as CommitPlan | null;
      expect(commitPlan).not.toBeNull();
      const builtSubjects = runGitLines(scaffoldTargetDir, ['log', '--format=%s']);
      const planSubjectsNewestFirst = [...(commitPlan as CommitPlan).commits]
        .map((commit) => commit.subject)
        .reverse();
      expect(builtSubjects).toEqual(planSubjectsNewestFirst);
    });
  });

  describe('the gpgsign pin', () => {
    it('still reproduces the fixture tip hash when ambient git config asks for a signature', () => {
      // GIT_CONFIG_COUNT/KEY_0/VALUE_0 is git's environment-based config, which outranks a
      // machine's gitconfig files but is itself outranked by a command-line -c. This stands in
      // for a developer machine whose global gitconfig sets commit.gpgsign=true; the module's own
      // '-c', 'commit.gpgsign=false' on every git call must still win, or this build would either
      // throw (no signing key configured) or produce a signed, differently-hashed commit.
      const ambientGpgSignEnv: Record<string, string> = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'true',
      };
      const previousValues: Record<string, string | undefined> = {};
      for (const key of Object.keys(ambientGpgSignEnv)) {
        previousValues[key] = process.env[key];
        process.env[key] = ambientGpgSignEnv[key];
      }
      try {
        const gpgSignTargetDir = path.join(tempRoot, 'contoso-web-gpgsign');
        buildScaffoldRepo(SCAFFOLD_DIR, gpgSignTargetDir);
        const headHash = runGit(gpgSignTargetDir, ['rev-parse', 'HEAD']).trim();
        const historyFixture = readHistoryFixture();
        expect(headHash).toBe(historyFixture.tipHash);
      } finally {
        for (const key of Object.keys(ambientGpgSignEnv)) {
          if (previousValues[key] === undefined) delete process.env[key];
          else process.env[key] = previousValues[key];
        }
      }
    });
  });

  describe('the last commit sweeps every remaining file', () => {
    it('commits every real scaffold file, and drops the plan file rather than committing it', () => {
      const trackedFiles = runGitLines(scaffoldTargetDir, ['ls-files']).sort();
      const scaffoldFiles = listScaffoldFiles(SCAFFOLD_DIR).sort();
      // The real contoso-web plan happens to name every one of its files explicitly, so this
      // pins currency (the tracked tree matches the scaffold today) without alone proving the
      // sweep fired; the synthetic test below names a file the plan never mentions and proves
      // the sweep is what lands it.
      expect(trackedFiles).toEqual(scaffoldFiles);
      // buildScaffoldRepo copies the plan file alongside the scaffold and then removes that
      // copy before committing; this is the one assertion that pins that removal step.
      expect(fs.existsSync(path.join(scaffoldTargetDir, 'commits.json'))).toBe(false);
    });

    it('lands a scaffold file the plan never names in the last commit', () => {
      const scaffoldDirectory = path.join(tempRoot, 'sweep-unnamed');
      writeSyntheticScaffold(
        scaffoldDirectory,
        {
          'named.txt': 'named',
          'never-named.txt': 'swept',
          'nested/also-unnamed.txt': 'swept too',
        },
        {
          author: { name: 'Dev', email: 'dev@example.com' },
          commits: [
            { subject: 'First', date: '2026-01-01T00:00:00Z', paths: ['named.txt'] },
            { subject: 'Last', date: '2026-01-02T00:00:00Z', paths: [] },
          ],
        },
      );
      const targetDirectory = path.join(tempRoot, 'sweep-unnamed-target');
      buildScaffoldRepo(scaffoldDirectory, targetDirectory);

      expect(runGitLines(targetDirectory, ['ls-files']).sort()).toEqual([
        'named.txt',
        'nested/also-unnamed.txt',
        'never-named.txt',
      ]);
      // The two files neither commit named landed in the LAST commit specifically, proving the
      // sweep (not just an accident of history) is what committed them. Without the sweep, the
      // "Last" commit's paths.filter would leave staged empty and the module's own "adds
      // nothing" guard would throw before this assertion is ever reached.
      expect(
        runGitLines(targetDirectory, ['show', '--name-only', '--format=', 'HEAD']).sort(),
      ).toEqual(['nested/also-unnamed.txt', 'never-named.txt']);
    });
  });

  describe('error paths', () => {
    it('throws naming a path a commit lists that the scaffold does not have', () => {
      const scaffoldDirectory = path.join(tempRoot, 'error-unknown-path');
      writeSyntheticScaffold(
        scaffoldDirectory,
        { 'file-a.txt': 'a', 'file-b.txt': 'b' },
        {
          author: { name: 'Dev', email: 'dev@example.com' },
          commits: [
            {
              subject: 'First',
              date: '2026-01-01T00:00:00Z',
              paths: ['file-a.txt', 'missing-file.txt'],
            },
          ],
        },
      );
      const targetDirectory = path.join(tempRoot, 'error-unknown-path-target');
      expect(() => buildScaffoldRepo(scaffoldDirectory, targetDirectory)).toThrow(
        /missing-file\.txt/,
      );
    });

    it('throws when a non-last commit lists only a path an earlier commit already took', () => {
      const scaffoldDirectory = path.join(tempRoot, 'error-already-took');
      writeSyntheticScaffold(
        scaffoldDirectory,
        { 'file-a.txt': 'a', 'file-b.txt': 'b' },
        {
          author: { name: 'Dev', email: 'dev@example.com' },
          commits: [
            { subject: 'First', date: '2026-01-01T00:00:00Z', paths: ['file-a.txt'] },
            { subject: 'Second', date: '2026-01-02T00:00:00Z', paths: ['file-a.txt'] },
            { subject: 'Third', date: '2026-01-03T00:00:00Z', paths: ['file-b.txt'] },
          ],
        },
      );
      const targetDirectory = path.join(tempRoot, 'error-already-took-target');
      expect(() => buildScaffoldRepo(scaffoldDirectory, targetDirectory)).toThrow(
        /already took/,
      );
    });

    it('returns null from readCommitPlan when the scaffold ships no commits.json', () => {
      const scaffoldDirectory = path.join(tempRoot, 'no-plan');
      fs.mkdirSync(scaffoldDirectory, { recursive: true });
      fs.writeFileSync(path.join(scaffoldDirectory, 'file-a.txt'), 'a');
      expect(readCommitPlan(scaffoldDirectory)).toBeNull();
    });

    it('throws from readCommitPlan when the plan has no author', () => {
      const scaffoldDirectory = path.join(tempRoot, 'no-author');
      writeSyntheticScaffold(scaffoldDirectory, { 'file-a.txt': 'a' }, {
        commits: [{ subject: 'First', date: '2026-01-01T00:00:00Z', paths: ['file-a.txt'] }],
      });
      expect(() => readCommitPlan(scaffoldDirectory)).toThrow(
        /needs an author and a non-empty commits list/,
      );
    });

    it('throws from readCommitPlan when the plan has an empty commits list', () => {
      const scaffoldDirectory = path.join(tempRoot, 'empty-commits');
      writeSyntheticScaffold(scaffoldDirectory, { 'file-a.txt': 'a' }, {
        author: { name: 'Dev', email: 'dev@example.com' },
        commits: [],
      });
      expect(() => readCommitPlan(scaffoldDirectory)).toThrow(
        /needs an author and a non-empty commits list/,
      );
    });
  });

  describe('author identity', () => {
    it('returns the plan author, and the built repo agrees', () => {
      const commitPlan = readCommitPlan(SCAFFOLD_DIR) as CommitPlan | null;
      expect(commitPlan).not.toBeNull();
      const planAuthor = (commitPlan as CommitPlan).author;
      expect(builtAuthor).toEqual(planAuthor);

      const authorLines = runGit(scaffoldTargetDir, ['log', '-1', '--format=%an%n%ae'])
        .trim()
        .split('\n');
      expect(authorLines).toEqual([planAuthor.name, planAuthor.email]);
    });
  });
});

/**
 * stageScaffoldRefresh stages the scratch clone the capture matrix refreshed from its scaffold, for
 * the commit that follows: every change, but never `.kangentic/`. An `mcp` capture runs in a task
 * worktree under that folder, and a leftover one is a git repository of its own, which a plain
 * `git add -A` stages as a gitlink and the next commit then bakes into the scaffold's history.
 * Each test below builds its repository from scratch under os.tmpdir() and reads the index with
 * `git diff --cached --name-only`. The last test stages the identical fixture with a plain
 * `git add -A` and expects the leftover worktree in the index, which proves the exclusion earns
 * its place on the git this runs on rather than passing because nothing would have been staged.
 */
describe('stageScaffoldRefresh', () => {
  let refreshRoot: string;

  /** Runs git with an identity and signing pinned on the command line, as the module pins its own calls. */
  function runPinnedGit(targetDirectory: string, args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c', 'user.name=Dev',
        '-c', 'user.email=dev@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.autocrlf=false',
        '-C', targetDirectory,
        ...args,
      ],
      // Piped stderr keeps git's "adding embedded git repository" warning out of the test output.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  function writeFileUnder(rootDirectory: string, relativePath: string, content: string): void {
    const filePath = path.join(rootDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  function stagedPaths(repository: string): string[] {
    return runPinnedGit(repository, ['diff', '--cached', '--name-only'])
      .split('\n')
      .filter((line) => line.length > 0)
      .sort();
  }

  /**
   * A scratch clone as the matrix leaves it before the refresh commit: one committed file the
   * refresh then changes, a file it adds, a leftover task worktree that is a repository with a
   * commit of its own (the shape `git add -A` records as a gitlink), and a plain runtime file.
   */
  function buildRefreshFixture(name: string): string {
    const repository = path.join(refreshRoot, name);
    fs.mkdirSync(repository, { recursive: true });
    runPinnedGit(repository, ['init', '-q', '-b', 'main']);
    writeFileUnder(repository, 'tracked.txt', 'version one\n');
    writeFileUnder(repository, 'untouched.txt', 'never changes\n');
    runPinnedGit(repository, ['add', '--', 'tracked.txt', 'untouched.txt']);
    runPinnedGit(repository, ['commit', '-q', '-m', 'Initial import']);

    writeFileUnder(repository, 'tracked.txt', 'version two\n');
    writeFileUnder(repository, 'src/new-file.txt', 'added by the refresh\n');

    const leftoverWorktree = path.join(repository, '.kangentic', 'worktrees', 'x');
    fs.mkdirSync(leftoverWorktree, { recursive: true });
    runPinnedGit(leftoverWorktree, ['init', '-q', '-b', 'main']);
    writeFileUnder(leftoverWorktree, 'work.txt', 'the task agent\'s work\n');
    runPinnedGit(leftoverWorktree, ['add', '--', 'work.txt']);
    runPinnedGit(leftoverWorktree, ['commit', '-q', '-m', 'Task work']);

    writeFileUnder(repository, '.kangentic/sessions/s1/status.json', '{}\n');
    return repository;
  }

  beforeAll(() => {
    refreshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-scaffold-refresh-test-'));
  });

  afterAll(() => {
    fs.rmSync(refreshRoot, { recursive: true, force: true });
  });

  it('stages the changed file and the new file, and nothing else', () => {
    const repository = buildRefreshFixture('stage-changes');
    // Vacuity guard: nothing is staged before the call, so the list below is the call's doing.
    expect(stagedPaths(repository)).toEqual([]);

    stageScaffoldRefresh(repository);

    expect(stagedPaths(repository)).toEqual(['src/new-file.txt', 'tracked.txt']);
  });

  it('stages nothing under .kangentic, neither a leftover task worktree repository nor a plain file', () => {
    const repository = buildRefreshFixture('stage-excludes-kangentic');

    stageScaffoldRefresh(repository);

    expect(stagedPaths(repository).filter((stagedPath) => stagedPath.startsWith('.kangentic'))).toEqual([]);
    expect(runPinnedGit(repository, ['ls-files', '--stage', '--', '.kangentic'])).toBe('');
  });

  it('is the exclusion that keeps the leftover worktree out: a plain git add -A stages it as a gitlink', () => {
    const repository = buildRefreshFixture('plain-add-all');

    runPinnedGit(repository, ['add', '-A']);

    expect(stagedPaths(repository)).toEqual([
      '.kangentic/sessions/s1/status.json',
      '.kangentic/worktrees/x',
      'src/new-file.txt',
      'tracked.txt',
    ]);
    // Mode 160000 is a gitlink: the entry is the nested repository's commit, not its files.
    expect(runPinnedGit(repository, ['ls-files', '--stage', '--', '.kangentic/worktrees/x'])).toMatch(/^160000 /);
  });
});
