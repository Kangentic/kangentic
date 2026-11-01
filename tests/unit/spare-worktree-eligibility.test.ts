/**
 * Spare worktrees (#958): who may take a pre-installed spare, and how
 * `ensureTaskWorktree` talks to the pool.
 *
 * Part 1 drives `isSpareEligible` over real directories (a git repo with one
 * commit, a plain folder, and a linked worktree of the repo), because the
 * project-side guards read the disk: `.git` as a directory, a file or absent.
 *
 * Part 2 drives the real `ensureTaskWorktree` against a stubbed WorktreeManager
 * and a FAKE pool on the context. It pins when the pool is asked to claim, to
 * yield its builds, and to build the next spare. The project path is the same
 * real repo, so an eligible task is genuinely eligible: every row that expects
 * "no request" also asserts the claim happened (or, for an ineligible task, did
 * not), so a negative never passes because the start was ineligible by accident.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isSpareEligible } from '../../src/main/ipc/helpers/spare-worktrees';
import { ensureTaskWorktree } from '../../src/main/ipc/helpers/task-git';
import { isWorktreeCreationInFlight } from '../../src/main/git/worktree-creation-registry';
import type { SpareProjectHooks, SpareWorktreePool } from '../../src/main/git/spare-worktree';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';
import { DEFAULT_CONFIG } from '../../src/shared/types';

// Real git for the fixtures: give the hooks room under a loaded run.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const managerMocks = vi.hoisted(() => ({
  ensureWorktree: vi.fn(),
  setUpWorktree: vi.fn(),
  prepareWorktreeFiles: vi.fn(),
  runWorktreeInitScript: vi.fn(),
}));

// The real module stays in place (`isSpareEligible` calls its real
// `worktreeSkipBeforeBase`, which reads the disk); only the manager class and
// the stale-directory clear are stubbed.
vi.mock('../../src/main/git/worktree-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/worktree-manager')>();
  const MockWorktreeManager = vi.fn().mockImplementation(function MockWorktreeManagerInstance(this: Record<string, unknown>) {
    this.withLock = async (job: () => unknown) => job();
    this.ensureWorktree = managerMocks.ensureWorktree;
    this.setUpWorktree = managerMocks.setUpWorktree;
    this.prepareWorktreeFiles = managerMocks.prepareWorktreeFiles;
    this.runWorktreeInitScript = managerMocks.runWorktreeInitScript;
  });
  // A reused worktree starts a background drift probe through the static queue.
  Object.assign(MockWorktreeManager, { withGitLock: vi.fn(async () => undefined) });
  return {
    ...actual,
    WorktreeManager: MockWorktreeManager,
    prepareStaleWorktreeForCreation: vi.fn().mockResolvedValue(false),
  };
});

const holdTaskMessageMock = vi.fn(() => ({ status: 'held', displayId: 1, rowId: 'row-1' }));
vi.mock('../../src/main/held-messages/held-messages', () => ({
  holdTaskMessage: (...args: unknown[]) => holdTaskMessageMock(...(args as [])),
}));

vi.mock('../../src/main/git/git-client', () => ({ gitAt: vi.fn(() => ({ raw: vi.fn(async () => '') })) }));
vi.mock('../../src/main/git/fetch-throttle', () => ({ fetchIfStale: vi.fn(async (_git: unknown, _path: string, branch: string) => branch) }));

const INIT_SCRIPT = 'pnpm install --frozen-lockfile';

let workspace: string;
let repoPath: string;
let plainPath: string;
let linkedPath: string;
let goneWorktreePath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

beforeAll(() => {
  // The real path: macOS's `/var` is `/private/var`, and a Windows temp dir can
  // be an 8.3 short name.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-spare-eligibility-')));
  repoPath = path.join(workspace, 'repo');
  plainPath = path.join(workspace, 'plain');
  linkedPath = path.join(workspace, 'linked');
  goneWorktreePath = path.join(workspace, 'gone', 'worktrees', '41');
  fs.mkdirSync(repoPath);
  fs.mkdirSync(plainPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  // A CI runner has no global identity, and a developer's global signing would
  // prompt or fail with no key here.
  git(repoPath, ['config', 'user.email', 'dev@example.com']);
  git(repoPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'project\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  git(repoPath, ['worktree', 'add', '-q', '-b', 'linked-branch', linkedPath]);
  // The fixtures are what the rows below say they are.
  expect(fs.statSync(path.join(repoPath, '.git')).isDirectory()).toBe(true);
  expect(fs.statSync(path.join(linkedPath, '.git')).isFile()).toBe(true);
  expect(fs.existsSync(path.join(plainPath, '.git'))).toBe(false);
  expect(fs.existsSync(goneWorktreePath)).toBe(false);
});

afterAll(async () => {
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let nextDisplayId = 100;

/** A task that has never had a worktree: the one clean, eligible row. */
function makeTask(overrides: Partial<Task> = {}): Task {
  const displayId = nextDisplayId++;
  return {
    id: `task-eligibility-${displayId}`,
    display_id: displayId,
    title: `Spare eligibility ${displayId}`,
    description: '',
    swimlane_id: 'lane-1',
    position: 0,
    worktree_path: null,
    worktree_folder: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    session_id: null,
    created_at: '2026-10-31T00:00:00.000Z',
    updated_at: '2026-10-31T00:00:00.000Z',
    is_ghost: false,
    is_archived: false,
    priority: 0,
    attachment_count: 0,
    labels: null,
    ...overrides,
  } as unknown as Task;
}

describe('isSpareEligible', () => {
  type Row = {
    name: string;
    project: () => string;
    worktreesEnabled: boolean;
    task: () => Partial<Task>;
    expected: boolean;
  };

  const rows: Row[] = [
    { name: 'a task that never had a worktree, in a plain repo with worktrees on', project: () => repoPath, worktreesEnabled: true, task: () => ({}), expected: true },
    { name: 'the same task with Worktree explicitly chosen (use_worktree 1)', project: () => repoPath, worktreesEnabled: true, task: () => ({ use_worktree: 1 }), expected: true },
    { name: 'a task whose worktree_path is a live worktree', project: () => repoPath, worktreesEnabled: true, task: () => ({ worktree_path: linkedPath }), expected: false },
    // The live row is also stopped by the project-side "reuse" guard. This one
    // is stopped only by the task-side check: the path is stale, so nothing on
    // disk would block it, yet the task has had a worktree.
    { name: 'a task whose worktree_path no longer exists on disk', project: () => repoPath, worktreesEnabled: true, task: () => ({ worktree_path: goneWorktreePath }), expected: false },
    { name: 'a task with a worktree_folder (a restore out of Done, a To Do reset)', project: () => repoPath, worktreesEnabled: true, task: () => ({ worktree_folder: '41' }), expected: false },
    { name: 'a task with a branch_name', project: () => repoPath, worktreesEnabled: true, task: () => ({ branch_name: 'feature/custom-branch' }), expected: false },
    { name: 'a task with its own base_branch', project: () => repoPath, worktreesEnabled: true, task: () => ({ base_branch: 'develop' }), expected: false },
    { name: 'worktrees turned off for the project', project: () => repoPath, worktreesEnabled: false, task: () => ({}), expected: false },
    { name: 'a task whose use_worktree is stored as off (0)', project: () => repoPath, worktreesEnabled: true, task: () => ({ use_worktree: 0 }), expected: false },
    { name: 'a project that is not a git repo', project: () => plainPath, worktreesEnabled: true, task: () => ({}), expected: false },
    { name: 'a project that is itself a linked worktree', project: () => linkedPath, worktreesEnabled: true, task: () => ({}), expected: false },
  ];

  it.each(rows)('$name -> $expected', ({ project, worktreesEnabled, task, expected }) => {
    expect(isSpareEligible(makeTask(task()), project(), worktreesEnabled)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Part 2: ensureTaskWorktree's pool wiring
// ---------------------------------------------------------------------------

function makePool() {
  return {
    claim: vi.fn(async (_input: unknown): Promise<null> => null),
    request: vi.fn(),
    yieldBuilds: vi.fn(),
    noteCatchUp: vi.fn(),
    discard: vi.fn(),
  };
}

type FakePool = ReturnType<typeof makePool>;

function makeContext(options: { pool?: FakePool; initScript?: string | null; worktreesEnabled?: boolean } = {}) {
  const { pool, initScript = INIT_SCRIPT, worktreesEnabled = true } = options;
  const send = vi.fn();
  const context = {
    currentProjectPath: null,
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, git: { ...DEFAULT_CONFIG.git, initScript, worktreesEnabled } })),
    },
    boardConfigManager: { getDefaultBaseBranchForPath: vi.fn(() => undefined) },
    mainWindow: { isDestroyed: () => false, webContents: { send } },
    projectRepo: { list: vi.fn(() => []) },
    sessionManager: { listSessions: vi.fn(() => []) },
    ...(pool ? { spareWorktrees: pool as unknown as SpareWorktreePool } : {}),
  } as unknown as IpcContext;
  return context;
}

function makeTaskRepo(task: Task) {
  return {
    update: vi.fn(),
    getById: vi.fn(() => task),
    list: vi.fn(() => []),
    listArchived: vi.fn(() => []),
    recordWorktree: vi.fn(),
    setWorktreeSkipReason: vi.fn(),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
  };
}

function worktreePathFor(task: Task): string {
  return path.join(repoPath, '.kangentic', 'worktrees', String(task.display_id));
}

function createdFor(task: Task) {
  return {
    worktreePath: worktreePathFor(task),
    branchName: `spare-eligibility-${task.display_id}`,
    worktreeFolder: String(task.display_id),
    baseBranch: 'main',
    forkPointSha: 'abc',
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** A script step that runs until the test settles it. */
function blockingScript() {
  let finish: (error?: Error) => void = () => undefined;
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  managerMocks.runWorktreeInitScript.mockImplementationOnce(() => {
    started();
    return new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    });
  });
  return { started: startedPromise, succeed: () => finish(), fail: (error: Error) => finish(error) };
}

function makeHandle(): EarlyAgentHandle {
  return { discard: vi.fn(async () => undefined) } as unknown as EarlyAgentHandle;
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

/** The most recent call of `request`, typed. */
function requestedWith(pool: FakePool): [string, SpareProjectHooks] {
  return pool.request.mock.calls.at(-1) as unknown as [string, SpareProjectHooks];
}

beforeEach(() => {
  vi.clearAllMocks();
  holdTaskMessageMock.mockClear();
  for (const mock of Object.values(managerMocks)) mock.mockReset();
  managerMocks.setUpWorktree.mockResolvedValue(undefined);
  managerMocks.prepareWorktreeFiles.mockResolvedValue(undefined);
  managerMocks.runWorktreeInitScript.mockResolvedValue(undefined);
});

describe('ensureTaskWorktree - a start that cannot take a spare never touches the claim or the refill', () => {
  it('a context without a pool creates and records the worktree as it always did', async () => {
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await expect(ensureTaskWorktree(makeContext(), task, taskRepo as never, repoPath)).resolves.toBeNull();

    expect(managerMocks.setUpWorktree).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'its own base_branch', overrides: { base_branch: 'develop' } },
    { name: 'a custom branch_name', overrides: { branch_name: 'feature/custom-branch' } },
    { name: 'a worktree_folder from an earlier worktree', overrides: { worktree_folder: '7' } },
  ])('a task with $name never claims and never asks for the next spare, though it is created', async ({ overrides }) => {
    const pool = makePool();
    const task = makeTask(overrides);
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath);
    await flush();

    // The worktree was made, so the refill's absence is the eligibility check's doing.
    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(pool.claim).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no Post-Worktree Script', initScript: null },
    { name: 'a blank Post-Worktree Script', initScript: '   ' },
  ])('a project with $name has no spare to claim and none to build', async ({ initScript }) => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await ensureTaskWorktree(makeContext({ pool, initScript }), task, taskRepo as never, repoPath);
    await flush();

    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(pool.claim).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('a project with worktrees off never claims and never asks for the next spare', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue({ skipped: true, reason: 'disabled' });

    await ensureTaskWorktree(makeContext({ pool, worktreesEnabled: false }), task, taskRepo as never, repoPath);
    await flush();

    expect(managerMocks.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(pool.claim).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
  });
});

describe('ensureTaskWorktree - an eligible start asks for the next spare once its creation settles', () => {
  it('claims first, and asks for the next spare with the project path only after the worktree is recorded', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));
    const setUpGate = deferred();
    managerMocks.setUpWorktree.mockImplementation(() => setUpGate.promise);

    const creation = ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath);
    await vi.waitFor(() => expect(managerMocks.setUpWorktree).toHaveBeenCalledTimes(1));
    await flush();

    // The claim found no spare (null), the creation is mid-setup: no refill yet.
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(pool.claim).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: repoPath,
      inputs: expect.objectContaining({ initScript: INIT_SCRIPT }),
    }));
    expect(taskRepo.recordWorktree).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();

    setUpGate.resolve();
    await expect(creation).resolves.toBeNull();
    await flush();

    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(pool.request).toHaveBeenCalledTimes(1);
    const [requestedPath, hooks] = requestedWith(pool);
    expect(requestedPath).toBe(repoPath);
    // The hooks the pool reads later are this project's.
    expect(hooks.inputs()).toEqual({ baseBranch: 'main', initScript: INIT_SCRIPT, linkNodeModules: true, copyFiles: [] });
    expect(typeof hooks.referencedFolders).toBe('function');
  });

  it.each([
    { reason: 'reused' },
    { reason: 'disabled' },
    { reason: 'not-a-repo' },
    { reason: 'nested-worktree' },
    { reason: 'no-commits' },
  ])('a start that ends skipped ($reason) asks for no spare and does not yield the builds', async ({ reason }) => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue({ skipped: true, reason });

    await expect(ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath)).resolves.toBeNull();
    await flush();

    // The start was eligible (it claimed), and made nothing.
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
    expect(pool.yieldBuilds).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the git phase rejects',
      arrange: () => managerMocks.ensureWorktree.mockRejectedValue(new Error('git worktree add failed')),
      message: 'git worktree add failed',
    },
    {
      name: 'the setup phase rejects',
      arrange: (task: Task) => {
        managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));
        managerMocks.setUpWorktree.mockRejectedValue(new Error('post-worktree script failed'));
      },
      message: 'post-worktree script failed',
    },
  ])('a creation that rejects ($name) asks for no spare', async ({ arrange, message }) => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    arrange(task);

    await expect(ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath)).rejects.toThrow(message);
    await flush();

    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('background script mode: the call returns with the worktree recorded, and the refill waits for the script', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));
    const script = blockingScript();

    await expect(
      ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath, { initScript: { mode: 'background' } }),
    ).resolves.toBeNull();
    await script.started;
    await flush();

    // Recorded and returned, but the creation still holds the path: no refill yet.
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(isWorktreeCreationInFlight(worktreePathFor(task))).toBe(true);
    expect(pool.request).not.toHaveBeenCalled();

    script.succeed();
    await vi.waitFor(() => expect(pool.request).toHaveBeenCalledTimes(1));
    expect(requestedWith(pool)[0]).toBe(repoPath);
    await vi.waitFor(() => expect(isWorktreeCreationInFlight(worktreePathFor(task))).toBe(false));
  });

  it('background script mode: a script that fails still ends in the refill, the worktree being recorded', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));
    const script = blockingScript();

    await ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath, {
      projectId: 'project-spare-eligibility',
      initScript: { mode: 'background' },
    });
    await script.started;
    expect(pool.request).not.toHaveBeenCalled();

    script.fail(new Error('init script exited with code 1'));
    await vi.waitFor(() => expect(pool.request).toHaveBeenCalledTimes(1));
    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(isWorktreeCreationInFlight(worktreePathFor(task))).toBe(false));
  });

  it('hold-prompt mode: the refill waits for the script and the recorded worktree, not for the early agent', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));
    const script = blockingScript();
    const handle = makeHandle();
    const launchAgent = vi.fn(async () => handle);

    const creation = ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath, {
      initScript: { mode: 'hold-prompt', launchAgent },
    });
    await script.started;
    await flush();

    expect(launchAgent).toHaveBeenCalledTimes(1);
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();

    script.succeed();
    await expect(creation).resolves.toBe(handle);
    await flush();

    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(pool.request).toHaveBeenCalledTimes(1);
    expect(requestedWith(pool)[0]).toBe(repoPath);
  });
});

describe('ensureTaskWorktree - the pool yields its builds only for an init script that is about to run', () => {
  it('yields once on a fresh creation, after the git phase and before the setup', async () => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath);
    await flush();

    expect(pool.yieldBuilds).toHaveBeenCalledTimes(1);
    const yieldOrder = pool.yieldBuilds.mock.invocationCallOrder[0];
    expect(managerMocks.ensureWorktree.mock.invocationCallOrder[0]).toBeLessThan(yieldOrder);
    expect(yieldOrder).toBeLessThan(managerMocks.setUpWorktree.mock.invocationCallOrder[0]);
  });

  it('yields for a creation that cannot take a spare too: its script runs all the same', async () => {
    const pool = makePool();
    const task = makeTask({ base_branch: 'develop' });
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await ensureTaskWorktree(makeContext({ pool }), task, taskRepo as never, repoPath);
    await flush();

    expect(pool.claim).not.toHaveBeenCalled();
    expect(pool.yieldBuilds).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'null', initScript: null },
    { name: 'empty', initScript: '' },
    { name: 'blank (whitespace only)', initScript: '   ' },
  ])('does not yield when the Post-Worktree Script is $name, and the worktree is still made', async ({ initScript }) => {
    const pool = makePool();
    const task = makeTask();
    const taskRepo = makeTaskRepo(task);
    managerMocks.ensureWorktree.mockResolvedValue(createdFor(task));

    await ensureTaskWorktree(makeContext({ pool, initScript }), task, taskRepo as never, repoPath);
    await flush();

    expect(managerMocks.setUpWorktree).toHaveBeenCalledTimes(1);
    expect(taskRepo.recordWorktree).toHaveBeenCalledTimes(1);
    expect(pool.yieldBuilds).not.toHaveBeenCalled();
  });
});
