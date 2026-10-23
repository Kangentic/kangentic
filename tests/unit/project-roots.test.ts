/**
 * src/main/shared/project-roots.ts is the ledger Sentry's path redaction reads
 * (src/main/analytics/redact-event-paths.ts). A ledger nothing fills would leave
 * every event as it was while the redaction's own tests stayed green. So this
 * pins the two feeds, the project repository's writes and the boot seed in
 * ProjectRepository.rememberRegisteredRoots, along with the ledger's add-only
 * contract and its repository-folder lookup (DESKTOP-21).
 *
 * The ledger is module-level state shared by every test in this file, and the
 * tests run in order. No assertion depends on what an earlier test left behind.
 * Most use toContain or arrayContaining, and an exact comparison is only ever
 * against a snapshot or a filter taken inside the same test. The folder lookups
 * are async and run one at a time, so a test that needs the chain to be idle
 * remembers a fresh sentinel project and waits for the sentinel's repository
 * folder (settleLookups).
 *
 * Every folder is a real one under the OS temp directory, and a `.git` directory
 * at the scratch root stops every walk inside it. No test stats a drive or a
 * folder outside os.tmpdir(), so a mapped drive that is offline cannot stall a run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const fakeDb = vi.hoisted(() => {
  const state: { all: () => unknown[] } = { all: () => [] };
  return {
    state,
    prepare: () => ({
      run: () => ({ changes: 1 }),
      // The row an update hands back. It never feeds the ledger, so the path is a placeholder.
      get: () => ({ id: 'project-1', name: 'client-app', path: '/mock/moved/client-app' }),
      all: () => state.all(),
    }),
  };
});

vi.mock('../../src/main/db/database', () => ({ getGlobalDb: () => fakeDb }));
vi.mock('../../src/main/db/transaction', () => ({
  writeTransaction: (_db: unknown, body: () => unknown) => body,
}));

import { knownProjectRoots, rememberProjectRoots } from '../../src/main/shared/project-roots';
import { ProjectRepository } from '../../src/main/db/repositories/project-repository';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Every wait for the ledger gets this budget. The default 1 s is too tight under CI load. */
const LOOKUP_TIMEOUT_MS = 5000;
// A test that waits on the chain more than once outlasts vitest's default 5 s test timeout.
vi.setConfig({ testTimeout: 20_000 });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-project-roots-'));
fs.mkdirSync(path.join(scratch, '.git'));

let uniqueCounter = 0;

function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

/** A repository folder holding a real `.git` directory, and a project folder inside it. */
function makeRepositoryWithSubfolder(prefix: string): { repository: string; project: string } {
  const repository = path.join(scratch, uniqueName(prefix));
  const project = path.join(repository, 'packages', 'app');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { repository, project };
}

/** Git writes the paths in a `.git` file with forward slashes, on Windows too. */
function forwardSlashes(target: string): string {
  return target.replace(/\\/g, '/');
}

/** A project folder whose `.git` is a file, written the way git writes it. */
function writeGitFile(project: string, gitdirTarget: string): void {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, '.git'), `gitdir: ${gitdirTarget}\n`);
}

async function waitForRoots(expectedRoots: string[]): Promise<void> {
  await vi.waitFor(
    () => expect(knownProjectRoots()).toEqual(expect.arrayContaining(expectedRoots)),
    { timeout: LOOKUP_TIMEOUT_MS },
  );
}

/**
 * The lookups run one at a time, so once a fresh sentinel project's repository folder is in the
 * ledger, every lookup queued before it has finished. Each call makes its own sentinel because a
 * path is looked up only once.
 */
async function settleLookups(): Promise<void> {
  const sentinel = makeRepositoryWithSubfolder('sentinel');
  rememberProjectRoots([sentinel.project]);
  await waitForRoots([sentinel.repository]);
}

/** Every known root at or below a folder. */
function rootsWithin(directory: string): string[] {
  return knownProjectRoots().filter((root) => root === directory || root.startsWith(directory + path.sep));
}

/** The paths passed to a spied `fs.promises` call. */
function calledPaths(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([target]) => String(target));
}

afterEach(() => {
  fakeDb.state.all = () => [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await settleLookups();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

describe('project roots ledger', () => {
  it('ignores empty paths and keeps each root once', () => {
    const projectPath = path.join(scratch, 'data', 'one');
    rememberProjectRoots(['', projectPath, projectPath]);
    expect(knownProjectRoots().filter((root) => root === projectPath)).toHaveLength(1);
    expect(knownProjectRoots()).not.toContain('');
  });

  it('learns a new project from ProjectRepository.create', () => {
    const projectPath = path.join(scratch, 'work', 'client-app');
    new ProjectRepository().create({ name: 'client-app', path: projectPath });
    expect(knownProjectRoots()).toContain(projectPath);
  });

  it('learns a moved project from updatePath and still knows the old root', () => {
    const oldPath = path.join(scratch, 'work', 'before-move');
    const newPath = path.join(scratch, 'moved', 'client-app');
    new ProjectRepository().create({ name: 'client-app', path: oldPath });
    new ProjectRepository().updatePath('project-1', newPath);
    expect(knownProjectRoots()).toEqual(expect.arrayContaining([oldPath, newPath]));
  });
});

describe('the boot seed, ProjectRepository.rememberRegisteredRoots', () => {
  it('puts every registered project path in the ledger and looks up their repository folders', async () => {
    const registeredOne = path.join(scratch, 'registered', 'one');
    const registeredTwo = path.join(scratch, 'registered', 'two');
    const inRepository = makeRepositoryWithSubfolder('seeded');
    fakeDb.state.all = () => [
      { id: 'project-a', name: 'one', path: registeredOne },
      { id: 'project-b', name: 'two', path: registeredTwo },
      { id: 'project-c', name: 'three', path: inRepository.project },
    ];

    new ProjectRepository().rememberRegisteredRoots();

    expect(knownProjectRoots()).toEqual(
      expect.arrayContaining([registeredOne, registeredTwo, inRepository.project]),
    );
    await waitForRoots([inRepository.repository]);
  });

  // softly() logs a failing operation once per process, so exactly one test makes the read throw.
  it('does not throw, adds nothing and logs once when the read throws', async () => {
    await settleLookups();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakeDb.state.all = () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    };
    const rootsBefore = knownProjectRoots();

    expect(() => new ProjectRepository().rememberRegisteredRoots()).not.toThrow();
    expect(() => new ProjectRepository().rememberRegisteredRoots()).not.toThrow();

    // No await since the snapshot, so a lookup finishing in the background cannot add to this list.
    expect(knownProjectRoots()).toEqual(rootsBefore);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('rememberRegisteredRoots');
  });
});

describe('the boot seed call in src/main/index.ts', () => {
  it('calls rememberRegisteredRoots once, after the global database is readable', () => {
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');
    const readableOffset = /await\s+ensureGlobalDbReadable\s*\(\s*\)/.exec(indexSource)?.index ?? -1;
    const seedOffsets = [...indexSource.matchAll(/\brememberRegisteredRoots\s*\(\s*\)/g)].map(
      (match) => match.index ?? -1,
    );
    expect(readableOffset).toBeGreaterThan(-1);
    expect(seedOffsets).toHaveLength(1);
    expect(seedOffsets[0]).toBeGreaterThan(readableOffset);
  });
});

describe('project roots ledger gates', () => {
  it('learns a relative path as itself and never walks it', async () => {
    await settleLookups();
    const relativeProject = path.join(uniqueName('kangentic-relative-gate'), 'app');
    const statSpy = vi.spyOn(fs.promises, 'stat');

    rememberProjectRoots([relativeProject]);
    await settleLookups();

    expect(path.isAbsolute(relativeProject)).toBe(false);
    expect(calledPaths(statSpy).filter((target) => target.includes('kangentic-relative-gate'))).toEqual([]);
    expect(knownProjectRoots().filter((root) => root.includes('kangentic-relative-gate'))).toEqual([relativeProject]);
    // A walk would resolve the path against the working directory.
    expect(knownProjectRoots()).not.toContain(process.cwd());
  });

  it('looks an absolute path up once however many times it is remembered', async () => {
    const { repository, project } = makeRepositoryWithSubfolder('walked-once');
    const statSpy = vi.spyOn(fs.promises, 'stat');

    rememberProjectRoots([project, project]);
    await waitForRoots([repository]);
    rememberProjectRoots([project]);
    await settleLookups();

    const gitProbes = calledPaths(statSpy).filter((target) => target === path.join(project, '.git'));
    expect(gitProbes).toHaveLength(1);
  });

  it('skips an entry that is not a string and still reads the entries after it', async () => {
    const { repository, project } = makeRepositoryWithSubfolder('after-non-string');

    expect(() =>
      rememberProjectRoots([42 as unknown as string, null as unknown as string, project]),
    ).not.toThrow();
    await waitForRoots([project, repository]);

    expect(knownProjectRoots().every((root) => typeof root === 'string')).toBe(true);
  });

  it('keeps looking up later projects after one lookup fails', async () => {
    await settleLookups();
    const failingRepository = path.join(scratch, uniqueName('failing-repository'));
    const failingProject = path.join(scratch, uniqueName('failing-project'));
    const worktreeGitDirectory = path.join(failingRepository, '.git', 'worktrees', 'wt');
    fs.mkdirSync(worktreeGitDirectory, { recursive: true });
    writeGitFile(failingProject, forwardSlashes(worktreeGitDirectory));
    const failingGitFile = path.join(failingProject, '.git');
    const survivor = makeRepositoryWithSubfolder('after-failure');

    // Fail only the one file this test planted. A queued lookup from an earlier test must still
    // read normally, or it could take the failure instead.
    const originalReadFile = fs.promises.readFile.bind(fs.promises) as unknown as (
      ...readArguments: unknown[]
    ) => Promise<unknown>;
    const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ) => {
      if (target === failingGitFile) return Promise.reject(new Error('EIO: simulated read failure'));
      return originalReadFile(target, ...rest);
    }) as unknown as typeof fs.promises.readFile);

    rememberProjectRoots([failingProject, survivor.project]);
    await waitForRoots([survivor.repository]);

    // The failure happened, so the survivor was learned by a chain that outlived it.
    expect(readFileSpy).toHaveBeenCalledWith(failingGitFile, 'utf8');
    expect(knownProjectRoots()).toContain(failingProject);
    expect(knownProjectRoots()).not.toContain(failingRepository);
  });
});

/**
 * Git names its repository folder in its own errors (`<repository>/.git/index.lock`). For a
 * project in a subfolder of a repository, or at a linked worktree, that folder is not the
 * project root, so the ledger looks it up and remembers it as well. The lookup is async, so each
 * case waits for the ledger to learn the folder.
 */
describe('project roots ledger repository folders', () => {
  it('remembers the repository folder above a project opened in a subfolder of it', async () => {
    const repository = path.join(scratch, 'monorepo');
    const project = path.join(repository, 'apps', 'web');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    rememberProjectRoots([project]);

    await waitForRoots([repository]);
  });

  it('remembers the repository a linked worktree project points into, absolute or relative', async () => {
    const mainRepository = path.join(scratch, 'main-repo');
    fs.mkdirSync(path.join(mainRepository, '.git', 'worktrees', 'feature'), { recursive: true });
    const absoluteProject = path.join(scratch, 'elsewhere', 'feature');
    fs.mkdirSync(absoluteProject, { recursive: true });
    fs.writeFileSync(
      path.join(absoluteProject, '.git'),
      `gitdir: ${forwardSlashes(path.join(mainRepository, '.git', 'worktrees', 'feature'))}\n`,
    );

    const otherRepository = path.join(scratch, 'other-repo');
    fs.mkdirSync(path.join(otherRepository, '.git', 'worktrees', 'side'), { recursive: true });
    const relativeProject = path.join(scratch, 'side');
    fs.mkdirSync(relativeProject, { recursive: true });
    fs.writeFileSync(path.join(relativeProject, '.git'), 'gitdir: ../other-repo/.git/worktrees/side\n');

    rememberProjectRoots([absoluteProject, relativeProject]);

    await waitForRoots([mainRepository, otherRepository]);
  });

  it('remembers the repository for a linked worktree of a normal repository with a commondir file', async () => {
    const repository = path.join(scratch, 'commondir-repo');
    const worktreeGitDirectory = path.join(repository, '.git', 'worktrees', 'feature');
    fs.mkdirSync(worktreeGitDirectory, { recursive: true });
    // Git writes the shared directory relative to the worktree's own, with a trailing newline.
    fs.writeFileSync(path.join(worktreeGitDirectory, 'commondir'), '../..\n');
    const project = path.join(scratch, 'commondir-checkout', 'feature');
    writeGitFile(project, forwardSlashes(worktreeGitDirectory));

    rememberProjectRoots([project]);

    await waitForRoots([project, repository]);
  });

  it('remembers the bare repository itself for a linked worktree of a bare repository', async () => {
    const bareRepository = path.join(scratch, 'client.git');
    const worktreeGitDirectory = path.join(bareRepository, 'worktrees', 'feat');
    fs.mkdirSync(worktreeGitDirectory, { recursive: true });
    // No `.git` segment anywhere in the path, so only the commondir file (trailing newline
    // included) leads from the worktree's directory to the bare repository.
    fs.writeFileSync(path.join(worktreeGitDirectory, 'commondir'), '../..\n');
    const project = path.join(scratch, 'bare-checkout', 'feat');
    writeGitFile(project, forwardSlashes(worktreeGitDirectory));

    rememberProjectRoots([project]);

    await waitForRoots([project, bareRepository]);
    expect(knownProjectRoots()).not.toContain(worktreeGitDirectory);
  });

  it('remembers the superproject folder for a submodule', async () => {
    const superproject = path.join(scratch, 'superproject');
    fs.mkdirSync(path.join(superproject, '.git', 'modules', 'sub'), { recursive: true });
    const submodule = path.join(superproject, 'sub');
    // A submodule's .git file is relative and its git directory has no commondir file.
    writeGitFile(submodule, '../.git/modules/sub');

    rememberProjectRoots([submodule]);

    await waitForRoots([submodule, superproject]);
  });

  it('remembers the separate git directory itself for a --separate-git-dir checkout', async () => {
    const separateGitDirectory = path.join(scratch, 'gitdirs', 'proj');
    fs.mkdirSync(separateGitDirectory, { recursive: true });
    const project = path.join(scratch, 'separate-checkout', 'proj');
    writeGitFile(project, forwardSlashes(separateGitDirectory));

    rememberProjectRoots([project]);

    await waitForRoots([project, separateGitDirectory]);
  });

  it('learns only the project itself from a .git file with no gitdir line', async () => {
    const junkTree = path.join(scratch, 'junk-tree');
    // A repository above the project, so a lookup that kept climbing would find and add it.
    fs.mkdirSync(path.join(junkTree, '.git'), { recursive: true });
    const project = path.join(junkTree, 'apps', 'proj');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, '.git'), 'this is not a gitdir pointer\nsee the .git folder\n');

    rememberProjectRoots([project]);
    await settleLookups();

    expect(rootsWithin(junkTree)).toEqual([project]);
  });
});
