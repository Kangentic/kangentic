/**
 * Spare worktree pool lifecycle (#958): how the per-project build loop starts,
 * parks, stops and quits, and what `discardProjectSpares` does to the spares a
 * project delete or relocate leaves.
 *
 * Drives the REAL `SpareWorktreePool`, `WorktreeManager` and git against a temp
 * repo with a bare origin, and a real init script that records each run and can
 * be told to fail or block inside a spare. A second script blocks on a control
 * file and runs through the real `runInitScript`, standing in for a task's own
 * Post-Worktree Script, which is what parks the pool's loop. Only the IPC
 * context, the task rows and the shutdown flag are stubs. The claim side of the
 * pool lives in spare-worktree-claim.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpareWorktreePool, isSpareWorktreeFolder, spareRecordsRootFor } from '../../src/main/git/spare-worktree';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { isAnyInitScriptRunning, runInitScript } from '../../src/main/git/run-init-script';
import { tryHoldWorktreeCreation } from '../../src/main/git/worktree-creation-registry';
import { spareInputsFor, spareHooksFor, discardProjectSpares } from '../../src/main/ipc/helpers/spare-worktrees';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { Task } from '../../src/shared/types';

// The module has a setter and no reset, so the flag is mocked: a test raises
// it for the quit case and the cleanup lowers it again.
const { shutdown } = vi.hoisted(() => ({ shutdown: { inProgress: false } }));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shutdown.inProgress,
  setShuttingDown: () => { shutdown.inProgress = true; },
}));

// Real git and real child processes: give the file room under a loaded run.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/** How long a stop or a quit may take to resolve when nothing should hold it. */
const PROMPT_BOUND_MS = 5_000;
/** How long a stop or a quit may take when it kills a script tree and moves a folder aside. */
const BUILD_STOP_BOUND_MS = 30_000;
/**
 * A negative assertion cannot poll for "nothing happens". These budgets are the
 * intentional fixed waits: long enough for a wrongly started build to show its
 * first file or call, short enough not to slow the file.
 */
const NEGATIVE_BUDGET_MS = 500;

let workspace: string;
let projectPath: string;
let controlDirectory: string;
let initScript: string;
let holdScriptCommand: string;
let pool: SpareWorktreePool;
let context: IpcContext;
let warnSpy: ReturnType<typeof vi.spyOn>;

/**
 * The fake install a spare build runs. Records the run in the control
 * directory, writes a node_modules marker, and inside a spare folder can fail
 * (`fail-spare`) or block until the file is removed (`block-spare`). A cold run
 * (no marker yet) is slow and a warm one is fast.
 */
const INSTALL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const control = process.argv[2];
const cwd = process.cwd();
const name = path.basename(cwd);
const cold = !fs.existsSync(path.join(cwd, 'node_modules', 'installed.txt'));
fs.appendFileSync(path.join(cwd, '.install-runs'), 'run\\n');
fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'node_modules', 'installed.txt'), name);
fs.appendFileSync(path.join(control, 'runs.log'), name + '\\n');
const isSpare = name.startsWith('spare_');
if (isSpare && fs.existsSync(path.join(control, 'fail-spare'))) {
  process.stderr.write('spare install failed');
  process.exit(1);
}
if (isSpare && fs.existsSync(path.join(control, 'block-spare'))) {
  fs.writeFileSync(path.join(control, name + '.started'), '');
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'block-spare'))) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 25);
} else {
  setTimeout(() => process.exit(0), cold ? 1000 : 0);
}
`;

/**
 * Stands in for a task's Post-Worktree Script: marks that it runs, then holds
 * until the release file appears. The long timer is a backstop so a run that
 * dies before it can release the script leaves no process behind.
 */
const HOLD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const control = process.argv[2];
fs.writeFileSync(path.join(control, 'task-script-running'), '');
const timer = setInterval(() => {
  if (fs.existsSync(path.join(control, 'release-task-script'))) {
    clearInterval(timer);
    process.exit(0);
  }
}, 25);
setTimeout(() => process.exit(0), 120000);
`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

function commit(cwd: string, message: string): void {
  // A developer's global `commit.gpgsign` would prompt or fail with no key here.
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

beforeAll(() => {
  // The real path: git prints a worktree's real path (macOS's `/var` is
  // `/private/var`, and a Windows temp dir can be an 8.3 short name), and
  // `registeredWorktrees()` compares against it.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-spare-lifecycle-')));
  const originPath = path.join(workspace, 'origin.git');
  projectPath = path.join(workspace, 'project');
  controlDirectory = path.join(workspace, 'control');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(controlDirectory);
  git(workspace, ['init', '-q', '--bare', '-b', 'main', originPath]);
  git(projectPath, ['init', '-q', '-b', 'main']);
  git(projectPath, ['config', 'user.email', 'dev@example.com']);
  git(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\n.install-runs\nnode_modules/\nlocal.env\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  git(projectPath, ['add', '-A']);
  commit(projectPath, 'initial');
  git(projectPath, ['remote', 'add', 'origin', originPath]);
  git(projectPath, ['push', '-q', '-u', 'origin', 'main']);
  const installScriptPath = path.join(workspace, 'install.js');
  fs.writeFileSync(installScriptPath, INSTALL_SCRIPT);
  initScript = `"${process.execPath}" "${installScriptPath}" "${controlDirectory}"`;
  const holdScriptPath = path.join(workspace, 'hold.js');
  fs.writeFileSync(holdScriptPath, HOLD_SCRIPT);
  holdScriptCommand = `"${process.execPath}" "${holdScriptPath}" "${controlDirectory}"`;
});

afterAll(async () => {
  clearFetchCache();
  fs.rmSync(path.join(controlDirectory, 'block-spare'), { force: true });
  fs.rmSync(path.join(controlDirectory, 'release-task-script'), { force: true });
  // A discard hands its folder to the batched deleter, which may still be
  // emptying it, so the removal retries.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function removeControlFiles(): void {
  for (const name of fs.readdirSync(controlDirectory)) {
    fs.rmSync(path.join(controlDirectory, name), { force: true });
  }
}

beforeEach(() => {
  shutdown.inProgress = false;
  clearFetchCache();
  removeControlFiles();
  fs.rmSync(path.join(spareRecordsRootFor(projectPath), 'no-saving.json'), { force: true });
  fs.writeFileSync(path.join(projectPath, 'local.env'), 'VALUE=1\n');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  pool = new SpareWorktreePool();
  context = makeContext(pool);
});

afterEach(async () => {
  // The flag first: a flag left up would make every later loop exit at once
  // and the tests after it would pass without testing anything.
  shutdown.inProgress = false;
  // The control files go last: a build still blocked by `block-spare` must be
  // aborted here, not let finish into a ready spare.
  pool.abortAllBuilds();
  await pool.stop(projectPath);
  await pool.sweep(projectPath, null, () => new Set());
  removeControlFiles();
  vi.restoreAllMocks();
});

const worktreesRoot = () => path.join(projectPath, '.kangentic', 'worktrees');

function spareFolders(): string[] {
  if (!fs.existsSync(worktreesRoot())) return [];
  return fs.readdirSync(worktreesRoot()).filter((name) => isSpareWorktreeFolder(name)).sort();
}

/** The spare's ready records on disk, by file name. */
function spareRecordFiles(): string[] {
  const root = spareRecordsRootFor(projectPath);
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith('spare_')).sort() : [];
}

function readySpareFolders(): string[] {
  return spareFolders().filter((folder) => fs.existsSync(path.join(spareRecordsRootFor(projectPath), `${folder}.json`)));
}

function registeredWorktrees(): string[] {
  return git(projectPath, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

/** Every install run so far, by folder name, oldest first. */
function installRunLog(): string[] {
  const file = path.join(controlDirectory, 'runs.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function makeContext(forPool: SpareWorktreePool): IpcContext {
  const config = {
    agent: { execution: {} },
    git: {
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
      copyFiles: ['local.env'],
      linkNodeModules: false,
      initScript,
    },
  };
  return {
    currentProjectPath: projectPath,
    configManager: { getEffectiveConfig: () => config },
    boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
    projectRepo: { list: () => [] },
    mainWindow: null,
    spareWorktrees: forPool,
  } as unknown as IpcContext;
}

type TaskRows = Pick<TaskRepository, 'list' | 'listArchived'>;

/** The slice of the task repository the pool reads, over fixed rows. */
function makeTaskRows(rows: Array<Partial<Pick<Task, 'worktree_folder' | 'worktree_path'>>> = []): TaskRows {
  return {
    list: () => rows as unknown as Task[],
    listArchived: () => [] as Task[],
  } as unknown as TaskRows;
}

function makeHooks() {
  return spareHooksFor(context, projectPath, makeTaskRows());
}

/** Build one ready spare directly, the way the pool's loop does. */
async function buildSpare(): Promise<string> {
  const before = new Set(readySpareFolders());
  const inputs = spareInputsFor(context, projectPath);
  if (!inputs) throw new Error('the fixture project should have spare inputs');
  expect(await pool.build(projectPath, inputs, new AbortController().signal)).toBe(true);
  const built = readySpareFolders().filter((folder) => !before.has(folder));
  expect(built).toHaveLength(1);
  return built[0];
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** True when `promise` settles, either way, within `boundMs`. */
async function settlesWithin(promise: Promise<unknown>, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), boundMs); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function pollUntil(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** True when `condition` holds at any poll within `budgetMs`. For a negative assertion's fixed budget. */
async function becomesTrueWithin(condition: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(25);
  }
  return condition();
}

/** The folder of the first spare build whose script has started and is not in `seen`. */
async function waitForStartedSpare(seen: Set<string>): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const started = fs.readdirSync(controlDirectory)
      .filter((name) => name.endsWith('.started'))
      .map((name) => name.slice(0, -'.started'.length))
      .find((folder) => !seen.has(folder));
    if (started) return started;
    await delay(25);
  }
  throw new Error('no spare build started its script');
}

/**
 * Run the stand-in task script through the real `runInitScript`, so the pool's
 * loop sees an init script running. `release` ends it and awaits its settling,
 * and is safe to call twice: a script left counted would park every later
 * loop in the file.
 */
async function startTaskInitScript(): Promise<{ release: () => Promise<void> }> {
  const controller = new AbortController();
  const finished = runInitScript(holdScriptCommand, workspace, { timeoutMs: 120_000, signal: controller.signal })
    .then(() => undefined, () => undefined);
  await pollUntil(() => fs.existsSync(path.join(controlDirectory, 'task-script-running')), 30_000, 'the task init script to start');
  expect(isAnyInitScriptRunning()).toBe(true);
  return {
    release: async () => {
      fs.writeFileSync(path.join(controlDirectory, 'release-task-script'), '');
      if (!(await settlesWithin(finished, 15_000))) controller.abort();
      await finished;
    },
  };
}

describe('stop', () => {
  it('resolves while a task init script still runs, with the parked loop ended and no spare built', async () => {
    const taskScript = await startTaskInitScript();
    try {
      const buildSpy = vi.spyOn(pool, 'build');
      pool.request(projectPath, makeHooks());
      // The loop is parked on the running script, not finished: a loop that had
      // already returned would make the stop below prove nothing. A budget,
      // because "still waiting" cannot be polled for.
      expect(await settlesWithin(pool.idle(projectPath), NEGATIVE_BUDGET_MS)).toBe(false);

      expect(await settlesWithin(pool.stop(projectPath), PROMPT_BOUND_MS)).toBe(true);
      expect(isAnyInitScriptRunning()).toBe(true);
      expect(await settlesWithin(pool.idle(projectPath), PROMPT_BOUND_MS)).toBe(true);
      expect(buildSpy).not.toHaveBeenCalled();
      expect(spareFolders()).toEqual([]);
      expect(installRunLog()).toEqual([]);

      // The script ending does not wake the stopped loop into a build.
      await taskScript.release();
      expect(isAnyInitScriptRunning()).toBe(false);
      expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 0 || spareFolders().length > 0, NEGATIVE_BUDGET_MS)).toBe(false);
    } finally {
      await taskScript.release();
    }
  });

  it('leaves the project able to build: the next request runs a fresh loop that is not already aborted', async () => {
    const taskScript = await startTaskInitScript();
    try {
      pool.request(projectPath, makeHooks());
      expect(await settlesWithin(pool.stop(projectPath), PROMPT_BOUND_MS)).toBe(true);
    } finally {
      await taskScript.release();
    }

    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    await pool.idle(projectPath);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(readySpareFolders()).toHaveLength(1);
  });

  it('aborts a build in progress, discards its half-built folder and record, and starts no new build', async () => {
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    const started = await waitForStartedSpare(new Set());
    // Mid-build: the folder exists and has no ready record yet.
    expect(spareFolders()).toEqual([started]);
    expect(spareRecordFiles()).toEqual([]);

    expect(await settlesWithin(pool.stop(projectPath), BUILD_STOP_BOUND_MS)).toBe(true);
    expect(await settlesWithin(pool.idle(projectPath), PROMPT_BOUND_MS)).toBe(true);
    expect(spareFolders()).toEqual([]);
    expect(spareRecordFiles()).toEqual([]);
    expect(registeredWorktrees()).not.toContain(path.resolve(worktreesRoot(), started));

    // With the block lifted, a build that wrongly started again would finish.
    fs.rmSync(path.join(controlDirectory, 'block-spare'));
    expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 1 || spareFolders().length > 0, NEGATIVE_BUDGET_MS)).toBe(false);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(installRunLog()).toEqual([started]);
  });

  it('does not resolve until a claim releases its hold on a spare', async () => {
    const spareFolder = await buildSpare();
    const sparePath = path.join(worktreesRoot(), spareFolder);
    const release = tryHoldWorktreeCreation(sparePath);
    if (!release) throw new Error('the ready spare should not be held yet');
    let stopSettled = false;
    try {
      const stopPromise = pool.stop(projectPath).then(() => { stopSettled = true; });
      // Held: stop must keep waiting. A budget, because "still waiting" cannot
      // be polled for. Without the hold the same call resolves in milliseconds.
      expect(await becomesTrueWithin(() => stopSettled, NEGATIVE_BUDGET_MS)).toBe(false);

      release();
      expect(await settlesWithin(stopPromise, PROMPT_BOUND_MS)).toBe(true);
      expect(stopSettled).toBe(true);
    } finally {
      release();
    }
    // The stop only waited: the spare itself is untouched.
    expect(readySpareFolders()).toEqual([spareFolder]);
  });
});

describe('abortAllBuilds (the quit)', () => {
  it('aborts the build in progress, ends the loop, and does not start the request that came during it', async () => {
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    const started = await waitForStartedSpare(new Set());
    // A second request during the build leaves work pending for the loop.
    pool.request(projectPath, makeHooks());

    pool.abortAllBuilds();
    expect(await settlesWithin(pool.idle(projectPath), BUILD_STOP_BOUND_MS)).toBe(true);
    // The app is not shutting down in this case, so the build discards its folder.
    expect(spareFolders()).toEqual([]);

    // With the block lifted, a loop that restarted for the pending request would build.
    fs.rmSync(path.join(controlDirectory, 'block-spare'));
    expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 1 || spareFolders().length > 0, NEGATIVE_BUDGET_MS)).toBe(false);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(installRunLog()).toEqual([started]);
  });

  it('ends a loop parked behind a running task init script, which then builds nothing', async () => {
    const taskScript = await startTaskInitScript();
    try {
      const buildSpy = vi.spyOn(pool, 'build');
      pool.request(projectPath, makeHooks());
      expect(await settlesWithin(pool.idle(projectPath), NEGATIVE_BUDGET_MS)).toBe(false);

      pool.abortAllBuilds();
      expect(await settlesWithin(pool.idle(projectPath), PROMPT_BOUND_MS)).toBe(true);
      expect(isAnyInitScriptRunning()).toBe(true);

      await taskScript.release();
      expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 0 || spareFolders().length > 0, NEGATIVE_BUDGET_MS)).toBe(false);
    } finally {
      await taskScript.release();
    }
  });

  it('leaves an aborted build\'s folder on disk with no ready record while the app shuts down, for the startup pass', async () => {
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    pool.request(projectPath, makeHooks());
    const started = await waitForStartedSpare(new Set());

    try {
      shutdown.inProgress = true;
      pool.abortAllBuilds();
      expect(await settlesWithin(pool.idle(projectPath), BUILD_STOP_BOUND_MS)).toBe(true);
      expect(spareFolders()).toEqual([started]);
      expect(spareRecordFiles()).toEqual([]);
      expect(registeredWorktrees()).toContain(path.resolve(worktreesRoot(), started));
    } finally {
      shutdown.inProgress = false;
    }

    // The next start's pass finds a folder with no record and deletes it.
    fs.rmSync(path.join(controlDirectory, 'block-spare'));
    await pool.sweep(projectPath, spareInputsFor(context, projectPath), () => new Set());
    expect(spareFolders()).toEqual([]);
    expect(registeredWorktrees()).not.toContain(path.resolve(worktreesRoot(), started));
  });
});

describe('the build loop', () => {
  it('a failed build leaves no spare folder or record, and the loop ends until the next request', async () => {
    fs.writeFileSync(path.join(controlDirectory, 'fail-spare'), '');
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    await pool.idle(projectPath);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    await expect(buildSpy.mock.results[0].value).resolves.toBe(false);
    expect(spareFolders()).toEqual([]);
    expect(spareRecordFiles()).toEqual([]);
    expect(installRunLog().filter((folder) => isSpareWorktreeFolder(folder))).toHaveLength(1);
    // No retry on its own.
    expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 1, NEGATIVE_BUDGET_MS)).toBe(false);

    // A request after the failure runs the loop again.
    fs.rmSync(path.join(controlDirectory, 'fail-spare'));
    pool.request(projectPath, makeHooks());
    await pool.idle(projectPath);
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(readySpareFolders()).toHaveLength(1);
  });

  it('two requests in a row build one spare', async () => {
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    pool.request(projectPath, makeHooks());
    await pool.idle(projectPath);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(readySpareFolders()).toHaveLength(1);
    expect(installRunLog().filter((folder) => isSpareWorktreeFolder(folder))).toHaveLength(1);
  });

  it('builds nothing for hooks whose inputs are null', async () => {
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, { inputs: () => null, referencedFolders: () => new Set<string>() });
    await pool.idle(projectPath);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(spareFolders()).toEqual([]);
    expect(installRunLog()).toEqual([]);
  });

  it('builds no second spare while a usable ready one exists', async () => {
    const existing = await buildSpare();
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    await pool.idle(projectPath);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(readySpareFolders()).toEqual([existing]);
    expect(installRunLog().filter((folder) => isSpareWorktreeFolder(folder))).toEqual([existing]);
  });

  it('a request that lands as the loop is finishing restarts it', async () => {
    const buildSpy = vi.spyOn(pool, 'build');
    const realHooks = makeHooks();
    // The first run asks the project for its inputs, and a request arrives
    // during that look: the loop is still running, so it leaves the work to the
    // loop, which then returns for the project having no inputs.
    pool.request(projectPath, {
      inputs: () => {
        pool.request(projectPath, realHooks);
        return null;
      },
      referencedFolders: () => new Set<string>(),
    });
    await pool.idle(projectPath);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(readySpareFolders()).toHaveLength(1);
  });
});

describe('discardProjectSpares', () => {
  it('discards every ready spare when the task rows are going (null tasks)', async () => {
    const first = await buildSpare();
    const second = await buildSpare();
    expect(readySpareFolders()).toEqual([first, second].sort());

    await discardProjectSpares(context, projectPath, null);

    expect(spareFolders()).toEqual([]);
    expect(spareRecordFiles()).toEqual([]);
    expect(registeredWorktrees()).not.toContain(path.resolve(worktreesRoot(), first));
    expect(registeredWorktrees()).not.toContain(path.resolve(worktreesRoot(), second));
  });

  it('keeps a spare folder a task row names, by its folder or by its path, and discards the rest', async () => {
    const namedByFolder = await buildSpare();
    const namedByPath = await buildSpare();
    const unnamed = await buildSpare();
    const tasks = makeTaskRows([
      { worktree_folder: namedByFolder },
      { worktree_path: path.join(worktreesRoot(), namedByPath) },
    ]);

    await discardProjectSpares(context, projectPath, tasks);

    expect(spareFolders()).toEqual([namedByFolder, namedByPath].sort());
    expect(registeredWorktrees()).not.toContain(path.resolve(worktreesRoot(), unnamed));
    expect(registeredWorktrees()).toContain(path.resolve(worktreesRoot(), namedByFolder));
    expect(registeredWorktrees()).toContain(path.resolve(worktreesRoot(), namedByPath));
  });

  it('keeps every spare, ready records included, when the task rows cannot be read', async () => {
    const first = await buildSpare();
    const second = await buildSpare();
    const unreadable = {
      list: () => { throw new Error('the project database is closed'); },
      listArchived: () => [] as Task[],
    } as unknown as TaskRows;

    await expect(discardProjectSpares(context, projectPath, unreadable)).resolves.toBeUndefined();

    expect(spareFolders()).toEqual([first, second].sort());
    expect(readySpareFolders()).toEqual([first, second].sort());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('keeping its spares'), expect.any(Error));
  });

  it('does nothing when the context has no pool', async () => {
    const spareFolder = await buildSpare();
    const withoutPool = { ...makeContext(pool), spareWorktrees: undefined } as unknown as IpcContext;

    await expect(discardProjectSpares(withoutPool, projectPath, null)).resolves.toBeUndefined();

    expect(readySpareFolders()).toEqual([spareFolder]);
    expect(registeredWorktrees()).toContain(path.resolve(worktreesRoot(), spareFolder));
  });

  it('stops the pool first, so a build in progress is discarded rather than skipped as in flight', async () => {
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    const buildSpy = vi.spyOn(pool, 'build');
    pool.request(projectPath, makeHooks());
    await waitForStartedSpare(new Set());

    const discarded = discardProjectSpares(context, projectPath, null);
    expect(await settlesWithin(discarded, BUILD_STOP_BOUND_MS)).toBe(true);

    expect(spareFolders()).toEqual([]);
    expect(spareRecordFiles()).toEqual([]);
    fs.rmSync(path.join(controlDirectory, 'block-spare'));
    expect(await becomesTrueWithin(() => buildSpy.mock.calls.length > 1 || spareFolders().length > 0, NEGATIVE_BUDGET_MS)).toBe(false);
  });
});
