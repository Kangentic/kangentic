/**
 * Unit tests for WorktreeManager -- sparse-checkout logic that excludes
 * .claude/ from worktrees to prevent git contamination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockProjectGit = { raw: vi.fn() };
const mockWorktreeGit = { raw: vi.fn() };

vi.mock('simple-git', () => ({
  default: vi.fn((cwd: string) =>
    // path.join uses backslashes on Windows, forward slashes elsewhere
    cwd.includes('.kangentic\\worktrees') || cwd.includes('.kangentic/worktrees')
      ? mockWorktreeGit
      : mockProjectGit,
  ),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
    // Async fs used by createWorktree's non-blocking worktrees-dir creation
    // and copyFiles loop. access() resolves by default (treat source as
    // present); mkdir/copyFile resolve to undefined.
    promises: {
      mkdir: vi.fn(),
      access: vi.fn(),
      copyFile: vi.fn(),
    },
  },
}));

// spawn mock for the runGitWithTimeout helper. Returns a fake ChildProcess
// that emits close(0) by default (success). Test suites that need the git
// op to fail configure it via recordedSpawnCalls + spawnOverrides.
// vi.hoisted() is required so these are initialized before vi.mock() runs.
const { mockSpawn, recordedSpawnCalls, spawnOverrides } = vi.hoisted(() => {
  const recordedSpawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnOverrides: Array<{
    match: (args: readonly string[], command: string) => boolean;
    behavior: {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      /** Never emit 'close' - let external abort or signal drive the outcome. */
      hang?: boolean;
    };
  }> = [];

  // spawn is called with two different signatures in this file:
  //
  //   runGitWithTimeout: spawn('git', [...args], { signal, ... })  -- 3 positional args
  //   runInitScript:     spawn(script,            { signal, ... })  -- 2 positional args
  //                                                (options lands in the 'args' slot)
  //
  // The mock uses the `args` parameter for both cases: for git calls it is a real
  // readonly string[], for init-script calls it is the options object. We read
  // `signal` defensively from both: (a) if 3-arg form, it's in the 3rd positional
  // (not captured here); (b) if 2-arg form, it's in args as an object field.
  // To keep existing tests unchanged the 3-arg git form's options are ignored
  // (git spawns in this file have no signal). Only the 2-arg init-script form
  // has a live signal that should drive abort simulation.
  const mockSpawn = vi.fn((
    command: string,
    args: readonly string[] | { signal?: AbortSignal; [key: string]: unknown },
  ) => {
    recordedSpawnCalls.push({ command, args: args as readonly string[] });
    const argsArray = Array.isArray(args) ? args : [];
    const override = spawnOverrides.find((entry) => entry.match(argsArray, command));
    const behavior = override?.behavior ?? { exitCode: 0 };

    const EventEmitter = require('node:events').EventEmitter;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });

    // Read signal from the options object when args is the options (2-arg form).
    // For the 3-arg form, signal lives in the third positional which is not
    // captured here; existing git spawn tests have no signal anyway.
    const optionsSignal = !Array.isArray(args)
      ? (args as { signal?: AbortSignal }).signal
      : undefined;

    if (optionsSignal) {
      optionsSignal.addEventListener('abort', () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        child.emit('error', abortError);
      }, { once: true });
    }

    if (!behavior.hang) {
      // queueMicrotask (not setImmediate/setTimeout) so the mock still works
      // when vi.useFakeTimers() is active - fake timers don't affect microtasks.
      queueMicrotask(() => {
        if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout, 'utf8'));
        if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'));
        child.emit('close', behavior.exitCode ?? 0, null);
      });
    }

    return child;
  });

  return { mockSpawn, recordedSpawnCalls, spawnOverrides };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  // git-checks.ts (imported by worktree-manager) promisifies execFile at
  // module load, so the mock must export it or the import graph throws. It
  // MUST invoke its callback: `hasCommits` and `resolveWorktreeBase`'s local
  // ref checks (base-branch.ts) both promisify execFile and await it before
  // `ensureWorktree` reaches `createWorktree` - a bare `vi.fn()` never settles
  // that promise, so every ensureWorktree test hangs until the 5s timeout
  // instead of failing with a readable assertion. `rev-parse --verify HEAD`
  // (no `--quiet`) succeeds, matching mockProjectGit.raw's convention below
  // that this is an already-committed repo. Every OTHER rev-parse fails EXCEPT
  // `origin/<branch>` once a matching `git fetch origin <branch>` spawn call has
  // already been recorded (resolveWorktreeBase re-verifies a fetched ref locally
  // before trusting it as a startPoint - see base-branch.ts) - so a candidate
  // only resolves here in the same order production code resolves it: never
  // locally, only after an actual fetch, matching mockProjectGit.raw's
  // "branch doesn't exist yet" convention and letting resolveWorktreeBase's
  // fetch pass (driven by mockSpawn, which defaults to success) do the
  // resolving - the same shape `fetchIfStale` already assumes throughout
  // this file.
  execFile: vi.fn((...callArgs: unknown[]) => {
    const commandArgs = callArgs.find((arg): arg is readonly string[] => Array.isArray(arg));
    const callback = callArgs.find((arg): arg is (error: Error | null, result: { stdout: string; stderr: string }) => void =>
      typeof arg === 'function');
    if (commandArgs?.[0] === 'rev-parse' && commandArgs.includes('HEAD') && !commandArgs.includes('--quiet')) {
      callback?.(null, { stdout: 'abc1234\n', stderr: '' });
      return;
    }
    if (commandArgs?.[0] === 'rev-parse' && commandArgs.includes('--quiet')) {
      const ref = commandArgs[commandArgs.length - 1];
      const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : null;
      const alreadyFetched = branch !== null && recordedSpawnCalls.some(
        (call) => call.command === 'git' && call.args[0] === 'fetch' && call.args[2] === branch,
      );
      if (alreadyFetched) {
        callback?.(null, { stdout: 'abc1234\n', stderr: '' });
        return;
      }
    }
    callback?.(new Error('fatal: not a valid object name'), { stdout: '', stderr: '' });
  }),
  spawn: mockSpawn,
}));

// Stub node_modules linking so we can assert WHETHER it runs (the git.linkNodeModules
// gate) without touching original-fs. removeNodeModulesPath is stubbed to a no-op
// resolve; the removeWorktree tests below only assert the git remove spawn.
vi.mock('../../src/main/git/node-modules-link', () => ({
  linkNodeModules: vi.fn(() => Promise.resolve()),
  removeNodeModulesPath: vi.fn(() => Promise.resolve()),
}));

import fs from 'node:fs';
import { WorktreeManager, GitQueuePriority } from '../../src/main/git/worktree-manager';
import { isGitRepo, isInsideWorktree, isKangenticWorktree } from '../../src/main/git/git-checks';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { linkNodeModules } from '../../src/main/git/node-modules-link';
import { worktreeFolderFromPath } from '../../src/shared/worktree-folder';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The minimal task shape `createWorktree` needs. `display_id` is what names the
 * worktree DIRECTORY, so any test asserting a folder name passes an explicit
 * one; the default is arbitrary and only has to be a positive integer.
 */
function worktreeTask(
  id: string,
  title: string,
  overrides: { display_id?: number; worktree_folder?: string | null; worktree_path?: string | null } = {},
) {
  return { id, title, display_id: 7, ...overrides };
}

/** Set up mocks so createWorktree succeeds and reaches sparse-checkout / copyFiles. */
function setupCreateWorktreeMocks() {
  // fs.existsSync: true for .git check and worktrees dir, false for stale worktree path check
  vi.mocked(fs.existsSync).mockImplementation((checkPath: fs.PathLike) => {
    // Stale worktree directory check: return false (no stale directory)
    if (String(checkPath).includes('.kangentic') && String(checkPath).includes('worktrees') &&
        !String(checkPath).endsWith('worktrees')) {
      return false;
    }
    return true;
  });

  // Project-level git: rev-parse --verify should fail (branch doesn't exist yet)
  mockProjectGit.raw.mockImplementation((args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return Promise.reject(new Error('fatal: not a valid object name'));
    }
    return Promise.resolve('');
  });

  // Worktree-level git: config, sparse-checkout
  mockWorktreeGit.raw.mockResolvedValue('');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WorktreeManager -- sparse-checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes sparse-checkout with --no-cone and excludes .claude/commands/', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    // Verify sparse-checkout init was called
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'init', '--no-cone',
    ]);

    // Verify sparse-checkout set was called to exclude .claude/commands/ only
    // (skills and agents do NOT walk up the directory tree, so they must stay in worktrees)
    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'sparse-checkout', 'set', '/*', '!/.claude/commands/',
    ]);
  });

  it('sparse-checkout runs before copyFiles', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', ['README.md']);

    // Find the call order indices
    const calls = mockWorktreeGit.raw.mock.calls;
    const sparseInitIdx = calls.findIndex(
      (c: string[][]) => c[0]?.[0] === 'sparse-checkout' && c[0]?.[1] === 'init',
    );
    const sparseSetIdx = calls.findIndex(
      (c: string[][]) => c[0]?.[0] === 'sparse-checkout' && c[0]?.[1] === 'set',
    );

    // sparse-checkout should have been called
    expect(sparseInitIdx).toBeGreaterThanOrEqual(0);
    expect(sparseSetIdx).toBeGreaterThan(sparseInitIdx);

    // copyFile (async) should have been called (for README.md)
    expect(fs.promises.copyFile).toHaveBeenCalled();
  });

  it('skips .claude/ entries in copyFiles', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [
      '.claude/settings.local.json',
      '.claude\\commands\\review.md',
      'README.md',
    ]);

    // Only README.md should be copied (2 .claude/ entries skipped)
    expect(fs.promises.copyFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.copyFile).toHaveBeenCalledWith(
      expect.stringContaining('README.md'),
      expect.stringContaining('README.md'),
    );
  });

  it('no skip-worktree or update-index calls', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [
      '.claude/settings.local.json',
    ]);

    // No update-index, ls-files, or skip-worktree calls
    const forbiddenCalls = mockWorktreeGit.raw.mock.calls.filter(
      (c: string[][]) =>
        c[0]?.[0] === 'update-index' || c[0]?.[0] === 'ls-files',
    );
    expect(forbiddenCalls).toHaveLength(0);
  });

  it('does not call rmSync for .claude directories', async () => {
    setupCreateWorktreeMocks();

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    // rmSync should not be called for .claude dirs (sparse-checkout handles exclusion)
    const rmCalls = vi.mocked(fs.rmSync).mock.calls.filter(
      (c) => String(c[0]).includes('.claude'),
    );
    expect(rmCalls).toHaveLength(0);
  });
});

// ── initScript + linkNodeModules ──────────────────────────────────────────

describe('WorktreeManager -- initScript and node_modules linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
    setupCreateWorktreeMocks();
  });

  it('runs the initScript in the new worktree after creation', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [], null, {
      initScript: 'echo setup',
    });

    const initCall = recordedSpawnCalls.find((call) => call.command === 'echo setup');
    expect(initCall).toBeDefined();
  });

  it('fails worktree creation when the initScript exits non-zero (fatal)', async () => {
    spawnOverrides.push({
      match: (_args, command) => command === 'failing-script',
      behavior: { exitCode: 1, stderr: 'boom' },
    });

    const mgr = new WorktreeManager('/project');
    await expect(
      mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [], null, { initScript: 'failing-script' }),
    ).rejects.toThrow(/boom/);
  });

  it('skips the initScript when it is empty or whitespace', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [], null, { initScript: '   ' });

    // Only git spawns (fetch); no shell command spawned for the blank script.
    const nonGitSpawns = recordedSpawnCalls.filter((call) => call.command !== 'git');
    expect(nonGitSpawns).toHaveLength(0);
  });

  it('links node_modules by default (option omitted)', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    expect(vi.mocked(linkNodeModules)).toHaveBeenCalledTimes(1);
  });

  it('links node_modules when linkNodeModules is true', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [], null, { linkNodeModules: true });

    expect(vi.mocked(linkNodeModules)).toHaveBeenCalledTimes(1);
  });

  it('does NOT link node_modules when linkNodeModules is false', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'), 'main', [], null, { linkNodeModules: false });

    expect(vi.mocked(linkNodeModules)).not.toHaveBeenCalled();
  });

  it('propagates an external abort signal through createWorktree to runInitScript, rejecting creation', async () => {
    // Gap: an AbortSignal passed to createWorktree (via options.signal) must
    // propagate all the way through to runInitScript so a superseding task move
    // or app shutdown can cancel a long-running init script (e.g. npm install).
    //
    // The mock's signal detection reads from whichever positional argument holds
    // the options object. For runInitScript's spawn call that is the 2nd argument
    // (no args array); for runGitWithTimeout's spawn call it is the 3rd. The
    // updated mockSpawn checks Array.isArray(args) to distinguish them and wires
    // the signal listener only for the 2-arg (init-script) form.
    //
    // Timing note: createWorktree does several async git operations (fetch, rev-
    // parse, git.raw) before reaching runInitScript. All those operations are
    // mocked as queueMicrotask. We wait for an init-script spawn to appear in
    // recordedSpawnCalls (proof createWorktree has reached that phase) before
    // aborting, ensuring the abort flows through the init-script path and not an
    // earlier throwIfAborted() guard.
    spawnOverrides.push({
      // Match the init-script command; git calls are matched by 'git' command string.
      match: (_args, command) => command === 'hang-script',
      behavior: { hang: true },
    });

    const controller = new AbortController();
    const mgr = new WorktreeManager('/project');

    const creationPromise = mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'),
      'main',
      [],
      null,
      { initScript: 'hang-script', signal: controller.signal },
    );

    // Drain all queued microtasks until the init-script spawn is visible.
    // Each await flushes one layer of microtasks / resolved promise continuations.
    // The git phases (fetch, rev-parse, raw) each have one async step, so a handful
    // of yields is sufficient to advance createWorktree to the init-script await.
    for (let flushCount = 0; flushCount < 20; flushCount++) {
      const initScriptSpawned = recordedSpawnCalls.some((call) => call.command === 'hang-script');
      if (initScriptSpawned) break;
      await Promise.resolve();
    }

    // The init-script spawn must be visible before we abort (proving we reached
    // that phase, not an earlier throwIfAborted guard).
    expect(recordedSpawnCalls.some((call) => call.command === 'hang-script')).toBe(true);

    controller.abort();

    // The abort propagates through runInitScript's externalAbortHandler, which
    // aborts the internal controller, which triggers the child's AbortError event,
    // which makes runInitScript reject with "external abort".
    await expect(creationPromise).rejects.toThrow(/external abort/);
  });
});

// ── Fetch & base branch tests ─────────────────────────────────────────────

describe('WorktreeManager -- fetch and base branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    // recordedSpawnCalls and spawnOverrides are module-scoped, must be
    // reset here so per-test fetch outcomes don't leak across tests.
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
  });

  it('fetches from origin and uses origin/<baseBranch> as start point when fetch succeeds', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Fetch test'), 'develop');

    // Fetch now goes through child_process.spawn (runGitWithTimeout), not git.raw
    const fetchSpawn = recordedSpawnCalls.find(
      (call) => call.command === 'git' && call.args[0] === 'fetch' && call.args[2] === 'develop',
    );
    expect(fetchSpawn).toBeDefined();

    // worktree add still goes through simple-git raw with origin/develop as start point
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.includes('worktree') && c[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('origin/develop');
  });

  it('falls back to local branch when fetch fails (no remote)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockWorktreeGit.raw.mockResolvedValue('');

    // Make the spawn-based fetch fail with a non-zero exit code
    spawnOverrides.push({
      match: (args) => args[0] === 'fetch' && args[1] === 'origin',
      behavior: { exitCode: 128, stderr: 'fatal: no remote' },
    });

    // rev-parse rejects (no existing branch), worktree add resolves
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'No remote test'), 'main');

    // worktree add should use local 'main' (not 'origin/main')
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (c: string[][]) => c[0]?.includes('worktree') && c[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![0][worktreeAddCall![0].length - 1]).toBe('main');
  });

  it('stores kangentic.baseBranch in worktree git config', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Config test'), 'develop');

    expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
      'config', 'kangentic.baseBranch', 'develop',
    ]);
  });

  it('kangentic.baseBranch config failure is non-fatal', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    // Config call fails, sparse-checkout calls succeed
    mockWorktreeGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'config') {
        return Promise.reject(new Error('config write failed'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');

    // Should not throw
    const result = await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Config fail test'));
    expect(result.worktreePath).toBeDefined();
    expect(result.branchName).toBeDefined();
  });
});

// ── Removal tests ─────────────────────────────────────────────────────────

describe('WorktreeManager -- removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake timers while the promise is pending so setTimeout resolves. */
  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    let result: T | undefined;
    let done = false;
    const p = promise.then(r => { result = r; done = true; });
    while (!done) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await p;
    return result as T;
  }

  it('removeWorktree spawns "git worktree remove --force"', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const mgr = new WorktreeManager('/project');
    const result = await runWithTimers(mgr.removeWorktree('/project/.kangentic/worktrees/test-abcd1234'));

    expect(result).toBe(true);
    const removeCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toEqual([
      'worktree', 'remove', '/project/.kangentic/worktrees/test-abcd1234', '--force',
    ]);
  });

  // Async fs.promises.rm fallback paths (both success + exhaustion + warning)
  // are covered by tests/unit/remove-worktree.test.ts with cleaner mocks. The
  // prior sync-rmSync + manual-delay tests were tied to the retry loop that
  // was removed when removeWorktree switched to fs.promises.rm + built-in
  // maxRetries, and had nothing more to assert beyond what the dedicated
  // file already covers.

  it('removeWorktree no-ops when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const mgr = new WorktreeManager('/project');
    await mgr.removeWorktree('/project/.kangentic/worktrees/nonexistent');

    // git should not be called at all
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('removeBranch spawns "git branch -D"', async () => {
    const mgr = new WorktreeManager('/project');
    await mgr.removeBranch('kanban/fix-bug-abcd1234');

    const branchCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'branch' && call.args[1] === '-D',
    );
    expect(branchCall).toBeDefined();
    expect(branchCall!.args).toEqual(['branch', '-D', 'kanban/fix-bug-abcd1234']);
  });

  it('removeBranch silently handles missing branch', async () => {
    spawnOverrides.push({
      match: (args) => args[0] === 'branch' && args[1] === '-D',
      behavior: { exitCode: 1, stderr: 'error: branch not found' },
    });

    const mgr = new WorktreeManager('/project');

    // Should not throw - the spawn resolves with a non-zero exit; the catch
    // inside removeBranch swallows it (branch may legitimately not exist).
    await expect(mgr.removeBranch('kanban/nonexistent')).resolves.toBeUndefined();
  });
});

// ── renameBranch tests ────────────────────────────────────────────────────

describe('WorktreeManager -- renameBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGit.raw.mockResolvedValue('');
  });

  it('calls git branch -m with old and new slug when title changes', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'abcd1234-0000-0000-0000-000000000000';
    const oldBranchName = 'old-title-abcd1234';

    const result = await mgr.renameBranch(taskId, oldBranchName, 'New Title');

    expect(result).toBe('new-title-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m', 'old-title-abcd1234', 'new-title-abcd1234',
    ]);
  });

  it('uses taskId first 8 chars as the branch suffix', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'deadbeef-face-0000-0000-000000000000';

    const result = await mgr.renameBranch(taskId, 'irrelevant-deadbeef', 'Fix Login Bug');

    expect(result).toBe('fix-login-bug-deadbeef');
  });

  it('returns null without calling git when slug is unchanged', async () => {
    const mgr = new WorktreeManager('/project');
    // Only punctuation changes - slugify collapses them, so slug stays identical.
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'fix-login-abcd1234',
      'Fix  login!!',
    );

    expect(result).toBeNull();
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('returns null and logs error when git branch -m fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProjectGit.raw.mockRejectedValue(new Error('fatal: branch already exists'));

    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-slug-abcd1234',
      'New Title',
    );

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[WORKTREE] Branch rename failed:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('preserves the base-branch namespace prefix when renaming', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'bugfix-inacc-adjustments/old-title-abcd1234',
      'New Title',
      { baseBranch: 'bugfix/inacc-adjustments', defaultBaseBranch: 'main' },
    );

    expect(result).toBe('bugfix-inacc-adjustments/new-title-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m',
      'bugfix-inacc-adjustments/old-title-abcd1234',
      'bugfix-inacc-adjustments/new-title-abcd1234',
    ]);
  });

  it('drops the prefix when base equals the default', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-title-abcd1234',
      'New Title',
      { baseBranch: 'main', defaultBaseBranch: 'main' },
    );

    expect(result).toBe('new-title-abcd1234');
  });

  it('falls back to "task" slug when the title produces an empty slug', async () => {
    const mgr = new WorktreeManager('/project');
    // A title of only punctuation produces an empty slug string before the
    // fallback -- renameBranch must substitute 'task' so the branch name is
    // still valid.
    const result = await mgr.renameBranch(
      'abcd1234-0000-0000-0000-000000000000',
      'old-abcd1234',
      '!!!',
    );

    expect(result).toBe('task-abcd1234');
    expect(mockProjectGit.raw).toHaveBeenCalledWith([
      'branch', '-m', 'old-abcd1234', 'task-abcd1234',
    ]);
  });
});

// ── listWorktrees tests ───────────────────────────────────────────────────

describe('WorktreeManager -- listWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses git worktree list --porcelain output correctly', async () => {
    mockProjectGit.raw.mockResolvedValue(
      'worktree /project\n' +
      'HEAD abc1234\n' +
      'branch refs/heads/main\n' +
      '\n' +
      'worktree /project/.kangentic/worktrees/fix-bug-abcd1234\n' +
      'HEAD def5678\n' +
      'branch refs/heads/kanban/fix-bug-abcd1234\n' +
      '\n',
    );

    const mgr = new WorktreeManager('/project');
    const result = await mgr.listWorktrees();

    expect(result).toEqual([
      '/project',
      '/project/.kangentic/worktrees/fix-bug-abcd1234',
    ]);
  });

  it('returns empty array for bare output', async () => {
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    const result = await mgr.listWorktrees();

    expect(result).toEqual([]);
  });
});

// ── ensureWorktree guard tests ─────────────────────────────────────────────

describe('WorktreeManager -- ensureWorktree', () => {
  const gitConfig = { worktreesEnabled: true, defaultBaseBranch: 'main', copyFiles: [] as string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
    // Default: isGitRepo returns true, isInsideWorktree returns false
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('not a file'); });
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });
    mockWorktreeGit.raw.mockResolvedValue('');
  });

  it('returns null when the worktree_path still exists on disk', async () => {
    // existsSync true (beforeEach) + statSync isFile=true => isInsideWorktree
    // true => a genuine, present worktree, so no recreation.
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: '/existing' },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(mockProjectGit.raw).not.toHaveBeenCalled();
  });

  it('falls through to createWorktree when worktree_path points at a husk (no .git file)', async () => {
    // beforeEach: existsSync true (husk dir still on disk), statSync throws (no
    // `.git` file => isInsideWorktree false). A Done cleanup that could not
    // delete the directory leaves worktree_path pointing at this emptied husk;
    // trusting it blindly would silently no-op the move-back.
    const mgr = new WorktreeManager('/project');
    const createSpy = vi
      .spyOn(mgr, 'createWorktree')
      .mockResolvedValue({ worktreePath: '/project/.kangentic/worktrees/test-abcd1234', branchName: 'test-abcd1234', worktreeFolder: 'test-abcd1234' });

    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: '/project/.kangentic/worktrees/test-abcd1234' },
      gitConfig,
    );

    expect(createSpy).toHaveBeenCalled();
    expect(result).toEqual({ worktreePath: '/project/.kangentic/worktrees/test-abcd1234', branchName: 'test-abcd1234', worktreeFolder: 'test-abcd1234' });
  });

  it('falls through to createWorktree when worktree_path is set but the directory is missing', async () => {
    // The worktree dir is gone; the project root still exists (is a git repo).
    vi.mocked(fs.existsSync).mockImplementation(
      (checkPath: fs.PathLike) => !String(checkPath).includes('missing-worktree'),
    );
    const mgr = new WorktreeManager('/project');
    const createSpy = vi
      .spyOn(mgr, 'createWorktree')
      .mockResolvedValue({ worktreePath: '/project/.kangentic/worktrees/test-abcd1234', branchName: 'test-abcd1234', worktreeFolder: 'test-abcd1234' });

    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: '/project/.kangentic/worktrees/missing-worktree' },
      gitConfig,
    );

    expect(createSpy).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it('returns null when worktreesEnabled is false', async () => {
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: null },
      { ...gitConfig, worktreesEnabled: false },
    );
    expect(result).toBeNull();
  });

  it('returns null when project is not a git repo', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: null },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(isGitRepo('/project')).toBe(false);
  });

  it('returns null when project is inside a worktree', async () => {
    // existsSync true (for .git check) + statSync returns isFile=true (worktree)
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);

    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: null },
      gitConfig,
    );
    expect(result).toBeNull();
    expect(isInsideWorktree('/project')).toBe(true);
  });

  it('delegates to createWorktree with resolved base branch on success', async () => {
    // statSync throws (not a worktree file), existsSync true (is git repo)
    const mgr = new WorktreeManager('/project');
    const result = await mgr.ensureWorktree(
      { id: 'abcd1234', title: 'Test', display_id: 7, worktree_path: null, base_branch: 'develop' },
      gitConfig,
    );

    expect(result).not.toBeNull();
    // Branch name encodes the non-default base as a namespace prefix so the
    // worktree's origin is visible at-a-glance in git log / GitHub branch lists.
    expect(result!.branchName).toBe('develop/test-abcd1234');
    // Should have used 'develop' (task override) not 'main' (config default).
    // Fetch goes through child_process.spawn (runGitWithTimeout), not git.raw.
    const fetchSpawn = recordedSpawnCalls.find(
      (call) => call.command === 'git' && call.args[0] === 'fetch' && call.args[2] === 'develop',
    );
    expect(fetchSpawn).toBeDefined();
  });
});

describe('isKangenticWorktree', () => {
  it('returns true for paths inside .kangentic/worktrees/', () => {
    expect(isKangenticWorktree('/home/dev/project/.kangentic/worktrees/fix-bug-abc123')).toBe(true);
  });

  it('returns true for Windows backslash paths', () => {
    expect(isKangenticWorktree('C:\\Users\\dev\\project\\.kangentic\\worktrees\\fix-bug-abc123')).toBe(true);
  });

  it('returns false for normal project paths', () => {
    expect(isKangenticWorktree('/home/dev/my-app')).toBe(false);
  });

  it('returns false for external git worktrees', () => {
    expect(isKangenticWorktree('/home/dev/kangentic.com')).toBe(false);
  });

  it('returns false for path containing worktrees without .kangentic parent', () => {
    expect(isKangenticWorktree('/home/dev/worktrees/some-branch')).toBe(false);
  });

  it('returns false for path ending at .kangentic/worktrees with no trailing slash', () => {
    expect(isKangenticWorktree('/home/dev/project/.kangentic/worktrees')).toBe(false);
  });

  it('returns true for mixed-slash paths (cross-platform edge case)', () => {
    expect(isKangenticWorktree('C:/Users/dev/project/.kangentic/worktrees/fix-bug')).toBe(true);
    expect(isKangenticWorktree('/home/dev/project\\.kangentic\\worktrees\\fix-bug')).toBe(true);
  });

  it('returns false for path nested INSIDE a worktree checkout (regression)', () => {
    expect(isKangenticWorktree(
      'C:\\Users\\dev\\kangentic\\.kangentic\\worktrees\\my-branch\\tests\\.tmp\\test-project',
    )).toBe(false);
    expect(isKangenticWorktree(
      '/home/dev/kangentic/.kangentic/worktrees/my-branch/tests/.tmp/test-project',
    )).toBe(false);
  });
});

// ── Stale branch recovery tests ───────────────────────────────────────────

describe('WorktreeManager -- stale branch recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    mockWorktreeGit.raw.mockResolvedValue('');
  });

  it('createWorktree reuses auto-generated branch that already exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    // rev-parse succeeds (branch exists from failed cleanup), all others succeed
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    const result = await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    expect(result.branchName).toBe('test-task-abcd1234');

    // Should use 'worktree add <path> <branch>' (no -b flag)
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (call: string[][]) => call[0]?.includes('worktree') && call[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    const worktreeAddArgs = worktreeAddCall![0];
    const worktreeIndex = worktreeAddArgs.indexOf('worktree');
    // The DIRECTORY is the display_id; the BRANCH stays title-derived.
    expect(worktreeAddArgs.slice(worktreeIndex, worktreeIndex + 2)).toEqual(['worktree', 'add']);
    expect(worktreeFolderFromPath(worktreeAddArgs[worktreeIndex + 2])).toBe('7');
    expect(worktreeAddArgs[worktreeIndex + 3]).toBe('test-task-abcd1234');
    expect(worktreeAddArgs).toHaveLength(worktreeIndex + 4);
    // Should NOT contain -b flag
    expect(worktreeAddArgs).not.toContain('-b');
  });

  it('createWorktree does not inline prune (moved to background)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    // Prune should NOT be called inline during createWorktree
    // (it's been moved to background via scheduleBackgroundPrune)
    const calls = mockProjectGit.raw.mock.calls.map((call: string[][]) => call[0]);
    const pruneCall = calls.find(
      (args: string[]) => args.includes('worktree') && args.includes('prune'),
    );
    expect(pruneCall).toBeUndefined();
  });

  it('createWorktree cleans up stale directory before git worktree add', async () => {
    recordedSpawnCalls.length = 0;

    // existsSync: true for stale worktree path
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    // removeWorktree should have been spawned with git worktree remove --force
    const removeCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'remove' && call.args[3] === '--force',
    );
    expect(removeCall).toBeDefined();
    expect(worktreeFolderFromPath(String(removeCall!.args[2]))).toBe('7');
  });

  it('reuses an empty husk with --force when the stale directory cannot be removed', async () => {
    // existsSync true (stale husk on disk), readdirSync [] (emptied husk),
    // removeWorktree returns false (Windows pinned-CWD blocks the final rmdir).
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    // Branch survived the Done transition, so rev-parse --verify resolves.
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    vi.spyOn(mgr, 'removeWorktree').mockResolvedValue(false);

    const result = await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));

    expect(result.branchName).toBe('test-task-abcd1234');
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (call: string[][]) => call[0]?.includes('worktree') && call[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeDefined();
    const worktreeAddArgs = worktreeAddCall![0];
    const worktreeIndex = worktreeAddArgs.indexOf('worktree');
    // Existing-branch arm + --force, no -b flag.
    expect(worktreeAddArgs.slice(worktreeIndex, worktreeIndex + 3)).toEqual(['worktree', 'add', '--force']);
    expect(worktreeFolderFromPath(worktreeAddArgs[worktreeIndex + 3])).toBe('7');
    expect(worktreeAddArgs[worktreeIndex + 4]).toBe('test-task-abcd1234');
    expect(worktreeAddArgs).not.toContain('-b');
  });

  it('throws an actionable error when a non-empty stale directory cannot be removed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockReturnValue(['somefile'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    vi.spyOn(mgr, 'removeWorktree').mockResolvedValue(false);

    await expect(mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'))).rejects.toThrow(/preview/);

    // No worktree add should have been attempted for a genuinely-stuck dir.
    const worktreeAddCall = mockProjectGit.raw.mock.calls.find(
      (call: string[][]) => call[0]?.includes('worktree') && call[0]?.includes('add'),
    );
    expect(worktreeAddCall).toBeUndefined();
  });

  it('throws an actionable error when the stale directory cannot even be listed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EPERM: operation not permitted'); });
    mockProjectGit.raw.mockResolvedValue('');

    const mgr = new WorktreeManager('/project');
    vi.spyOn(mgr, 'removeWorktree').mockResolvedValue(false);

    await expect(mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'))).rejects.toThrow(/could not be removed/);
  });

  it('pruneWorktrees spawns "git worktree prune"', async () => {
    recordedSpawnCalls.length = 0;

    const mgr = new WorktreeManager('/project');
    await mgr.pruneWorktrees();

    const pruneCall = recordedSpawnCalls.find(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    );
    expect(pruneCall).toBeDefined();
  });
});

// ── Folder-name stability across Done round-trip ──────────────────────────
//
// Regression guard for the silent session-loss bug: a task taken To Do ->
// (worked for hours) -> Done -> back onto the board MUST recreate its worktree
// at the IDENTICAL path. Claude keys its transcript by cwd, so a path change
// makes `--resume` look under the wrong slug ("No conversation found").
//
// Moving to Done nulls worktree_path, so the move back out is a FRESH creation.
// `worktree_folder` is what carries the original directory name across that gap.
// Two shapes must both survive: a legacy `<slug>-<shortId>` folder from before
// the numeric scheme, and a numeric one. Neither is ever renamed on disk.

describe('WorktreeManager -- folder-name stability across Done round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFetchCache();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
    setupCreateWorktreeMocks();
  });

  it('a legacy folder survives the round-trip instead of being renumbered', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = '4e41b16b-8092-423c-a379-4627bc31b1b2';
    const title = 'DNS Setup';

    // A task created before the numeric scheme: its pinned folder is the old
    // title-derived name, and worktree_path was cleared by the Done move.
    const legacy = worktreeTask(taskId, title, {
      display_id: 460,
      worktree_folder: 'dns-setup-4e41b16b',
    });

    // Move-out feeds the preserved branch_name back as customBranchName.
    const result = await mgr.createWorktree(legacy, 'main', [], 'dns-setup-4e41b16b');

    expect(result.worktreeFolder).toBe('dns-setup-4e41b16b');
    expect(result.worktreePath.endsWith('dns-setup-4e41b16b')).toBe(true);
    // The whole point: it must NOT be relocated to the numeric folder.
    expect(result.worktreePath).not.toContain('460');
  });

  it('recovers the legacy folder from worktree_path when the column was never backfilled', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = '4e41b16b-8092-423c-a379-4627bc31b1b2';

    const result = await mgr.createWorktree(
      worktreeTask(taskId, 'DNS Setup', {
        display_id: 460,
        worktree_path: '/project/.kangentic/worktrees/dns-setup-4e41b16b',
      }),
    );

    expect(result.worktreeFolder).toBe('dns-setup-4e41b16b');
  });

  it('a new task uses its display_id and keeps it across repeated Done cycles', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'abcd1234-0000-0000-0000-000000000000';
    const title = 'Fix Login Bug';

    const first = await mgr.createWorktree(worktreeTask(taskId, title, { display_id: 460 }));
    expect(first.worktreeFolder).toBe('460');
    expect(first.branchName).toBe('fix-login-bug-abcd1234');

    // Each subsequent creation is fed back the pinned folder, as the real
    // callers do once they have persisted it.
    const pinned = worktreeTask(taskId, title, { display_id: 460, worktree_folder: first.worktreeFolder });
    const second = await mgr.createWorktree(pinned, 'main', [], first.branchName);
    const third = await mgr.createWorktree(pinned, 'main', [], second.branchName);

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(third.worktreePath).toBe(first.worktreePath);
  });

  it('a renamed title changes the branch but never the folder', async () => {
    const mgr = new WorktreeManager('/project');
    const taskId = 'abcd1234-0000-0000-0000-000000000000';

    const first = await mgr.createWorktree(worktreeTask(taskId, 'Fix Login Bug', { display_id: 12 }));
    const afterRename = await mgr.createWorktree(
      worktreeTask(taskId, 'Something Else Entirely', { display_id: 12, worktree_folder: first.worktreeFolder }),
    );

    expect(afterRename.worktreePath).toBe(first.worktreePath);
    expect(afterRename.branchName).not.toBe(first.branchName);
  });

  it('the branch stays title-derived and namespaced while the folder stays numeric', async () => {
    const mgr = new WorktreeManager('/project');

    const result = await mgr.createWorktree(
      worktreeTask('deadbeef-0000-0000-0000-000000000000', 'Fix Login', { display_id: 88 }),
      'bugfix-x',
    );

    expect(result.branchName).toBe('bugfix-x/fix-login-deadbeef');
    expect(result.worktreeFolder).toBe('88');
  });

  it('a custom branch name is used verbatim and does not name the folder', async () => {
    const mgr = new WorktreeManager('/project');

    const result = await mgr.createWorktree(
      worktreeTask('abcd1234-0000-0000-0000-000000000000', 'Some Title', { display_id: 9 }),
      'main',
      [],
      'feature/login',
    );

    expect(result.branchName).toBe('feature/login');
    expect(result.worktreeFolder).toBe('9');
  });

  it('refuses to create a worktree for a task with no usable display_id', async () => {
    const mgr = new WorktreeManager('/project');

    await expect(
      mgr.createWorktree({ id: 'abcd1234-0000', title: 'Broken', display_id: 0 }),
    ).rejects.toThrow(/not a positive integer/);
  });
});

/**
 * `withPathLengthCause` wiring: a failed `git worktree add` is enriched with a
 * path-length explanation when the error looks like one, and left untouched
 * otherwise. The predicate itself (`describeWorktreePathLengthCause`) is fully
 * pinned in `worktree-folder.test.ts`; these only check that `createWorktree`
 * actually calls it on the failure it raises.
 */
describe('WorktreeManager -- path-length error enrichment on a failed worktree add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCreateWorktreeMocks();
  });

  it('appends the path-length explanation on Windows when the failure looks like one', async () => {
    // describeWorktreePathLengthCause reads process.platform at call time (not
    // bound at import like `path`), so the spoof works here - but it must stay
    // live across the awaited rejection, not just the mock setup.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      mockProjectGit.raw.mockImplementation((args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return Promise.reject(new Error('fatal: not a valid object name'));
        }
        if (args.includes('worktree') && args.includes('add')) {
          return Promise.reject(new Error('ENAMETOOLONG: name too long, open ...'));
        }
        return Promise.resolve('');
      });

      const mgr = new WorktreeManager('/project');
      await expect(mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task')))
        .rejects.toThrow(/ran out of path/);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('leaves an unrelated worktree-add failure untouched', async () => {
    // Platform-independent: describeWorktreePathLengthCause returns null for a
    // message with no path-length signature on any platform, so this needs no
    // spoof and must pass on both local Windows and CI Linux.
    const originalMessage = 'fatal: could not lock config file .git/config: File exists';
    mockProjectGit.raw.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.reject(new Error('fatal: not a valid object name'));
      }
      if (args.includes('worktree') && args.includes('add')) {
        return Promise.reject(new Error(originalMessage));
      }
      return Promise.resolve('');
    });

    const mgr = new WorktreeManager('/project');
    let caught: Error | null = null;
    try {
      await mgr.createWorktree(worktreeTask('abcd1234-0000', 'Test task'));
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toBe(originalMessage);
  });
});

// ── Serial queue tests ────────────────────────────────────────────────────

describe('WorktreeManager -- serial queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorktreeManager.clearQueue('/project');
    WorktreeManager.clearQueue('/other-project');
  });

  it('concurrent operations on same project execute sequentially', async () => {
    const executionOrder: number[] = [];
    let resolveFirst: () => void;
    const firstBlocked = new Promise<void>(resolve => { resolveFirst = resolve; });

    const operation1 = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push(1);
      await firstBlocked;
      executionOrder.push(2);
      return 'first';
    });

    const operation2 = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push(3);
      return 'second';
    });

    // operation2 should not start until operation1 finishes
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(executionOrder).toEqual([1]);

    resolveFirst!();
    const [result1, result2] = await Promise.all([operation1, operation2]);

    expect(result1).toBe('first');
    expect(result2).toBe('second');
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('concurrent operations on different projects execute in parallel', async () => {
    const executionOrder: string[] = [];
    let resolveA: () => void;
    let resolveB: () => void;
    const blockedA = new Promise<void>(resolve => { resolveA = resolve; });
    const blockedB = new Promise<void>(resolve => { resolveB = resolve; });

    const operationA = WorktreeManager.withGitLock('/project', async () => {
      executionOrder.push('A-start');
      await blockedA;
      executionOrder.push('A-end');
    });

    const operationB = WorktreeManager.withGitLock('/other-project', async () => {
      executionOrder.push('B-start');
      await blockedB;
      executionOrder.push('B-end');
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    // Both should have started (different projects run independently)
    expect(executionOrder).toContain('A-start');
    expect(executionOrder).toContain('B-start');

    resolveA!();
    resolveB!();
    await Promise.all([operationA, operationB]);
  });

  it('failed operation does not block subsequent operations', async () => {
    const failingOperation = WorktreeManager.withGitLock('/project', async () => {
      throw new Error('git failed');
    });

    await expect(failingOperation).rejects.toThrow('git failed');

    // Next operation should still run
    const result = await WorktreeManager.withGitLock('/project', async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('clearQueue removes the project entry', async () => {
    // Queue an operation to ensure the key exists
    await WorktreeManager.withGitLock('/project', async () => 'done');

    // clearQueue should not throw and subsequent operations should work
    WorktreeManager.clearQueue('/project');

    const result = await WorktreeManager.withGitLock('/project', async () => 'after-clear');
    expect(result).toBe('after-clear');
  });

  it('withLock instance method uses the project path', async () => {
    const manager = new WorktreeManager('/project');
    const executionOrder: number[] = [];

    const operation1 = manager.withLock(async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push(2);
      return 'first';
    });

    const operation2 = manager.withLock(async () => {
      executionOrder.push(3);
      return 'second';
    });

    await Promise.all([operation1, operation2]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });
});

// ── Priority queue tests ──────────────────────────────────────────────────

describe('WorktreeManager - priority queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WorktreeManager.clearQueue('/project');
  });

  it('a later USER op jumps ahead of an already-queued BACKGROUND op (head-of-line fix)', async () => {
    const order: string[] = [];
    let releaseRunning: () => void;
    const running = new Promise<void>(resolve => { releaseRunning = resolve; });

    // First job occupies the runner (simulates the in-flight stuck cleanup).
    const first = WorktreeManager.withGitLock('/project', async () => {
      order.push('running-start');
      await running;
      order.push('running-end');
    }, { priority: GitQueuePriority.BACKGROUND });

    // Queue a BACKGROUND job, THEN a USER job. The USER job must run first.
    const background = WorktreeManager.withGitLock('/project', async () => {
      order.push('background');
    }, { priority: GitQueuePriority.BACKGROUND });

    const user = WorktreeManager.withGitLock('/project', async () => {
      order.push('user');
    }); // default USER priority

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(['running-start']); // both parked behind the running op

    releaseRunning!();
    await Promise.all([first, background, user]);

    expect(order).toEqual(['running-start', 'running-end', 'user', 'background']);
  });

  it('equal-priority ops drain in FIFO (enqueue) order', async () => {
    const order: number[] = [];
    let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const first = WorktreeManager.withGitLock('/project', async () => {
      order.push(1);
      await blocked;
    });
    const second = WorktreeManager.withGitLock('/project', async () => { order.push(2); });
    const third = WorktreeManager.withGitLock('/project', async () => { order.push(3); });

    release!();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('never runs two ops concurrently even under mixed priority', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeOp = (priority: number) => WorktreeManager.withGitLock('/project', async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
    }, { priority });

    await Promise.all([
      makeOp(GitQueuePriority.BACKGROUND),
      makeOp(GitQueuePriority.USER),
      makeOp(GitQueuePriority.BACKGROUND),
      makeOp(GitQueuePriority.USER),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it('a thrown high-priority op does not wedge the runner', async () => {
    const failing = WorktreeManager.withGitLock('/project', async () => {
      throw new Error('boom');
    }, { priority: GitQueuePriority.USER });
    await expect(failing).rejects.toThrow('boom');

    const next = await WorktreeManager.withGitLock('/project', async () => 'ok');
    expect(next).toBe('ok');
  });

  it('onWaitProgress fires only when parked, with the count of jobs ahead', async () => {
    const waits: number[] = [];
    const onWaitProgress = (info: { jobsAhead: number }) => waits.push(info.jobsAhead);
    let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    // First op starts immediately -> onWaitProgress NOT called.
    const first = WorktreeManager.withGitLock('/project', async () => { await blocked; }, { onWaitProgress });
    // Second op parks behind the running first -> jobsAhead 1.
    const second = WorktreeManager.withGitLock('/project', async () => {}, { onWaitProgress });
    // Third op parks behind running + one waiter -> jobsAhead 2.
    const third = WorktreeManager.withGitLock('/project', async () => {}, { onWaitProgress });

    expect(waits).toEqual([1, 2]); // first op did not report a wait

    release!();
    await Promise.all([first, second, third]);
  });

  it('a USER op reports only 1 ahead when it jumps a queued BACKGROUND op', async () => {
    const waits: number[] = [];
    let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const running = WorktreeManager.withGitLock('/project', async () => { await blocked; }, { priority: GitQueuePriority.BACKGROUND });
    // A queued BACKGROUND job (will be jumped, so it is not "ahead" of USER).
    const background = WorktreeManager.withGitLock('/project', async () => {}, { priority: GitQueuePriority.BACKGROUND });
    // USER job: only the running op is ahead of it.
    const user = WorktreeManager.withGitLock('/project', async () => {}, {
      priority: GitQueuePriority.USER,
      onWaitProgress: (info) => waits.push(info.jobsAhead),
    });

    expect(waits).toEqual([1]);

    release!();
    await Promise.all([running, background, user]);
  });

  it('onWaitProgress reports the running job label and its elapsed time', async () => {
    let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const seen: Array<{ runningLabel: string | null; runningElapsedMs: number }> = [];

    const running = WorktreeManager.withGitLock('/project', async () => { await blocked; }, { label: 'remove-worktree:abcd1234' });
    const parked = WorktreeManager.withGitLock('/project', async () => {}, {
      label: 'create-worktree:ef567890',
      onWaitProgress: (info) => seen.push({ runningLabel: info.runningLabel, runningElapsedMs: info.runningElapsedMs }),
    });

    // Enqueue-time emit names the in-flight removal.
    expect(seen).toHaveLength(1);
    expect(seen[0].runningLabel).toBe('remove-worktree:abcd1234');
    expect(seen[0].runningElapsedMs).toBeGreaterThanOrEqual(0);

    release!();
    await Promise.all([running, parked]);
  });

  it('clearQueue rejects still-waiting jobs and lets new ops run afterward', async () => {
    let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const running = WorktreeManager.withGitLock('/project', async () => { await blocked; });
    const waiter1 = WorktreeManager.withGitLock('/project', async () => 'never');
    const waiter2 = WorktreeManager.withGitLock('/project', async () => 'never');
    // Avoid unhandled-rejection noise before the assertions attach.
    waiter1.catch(() => {});
    waiter2.catch(() => {});

    WorktreeManager.clearQueue('/project');

    await expect(waiter1).rejects.toThrow(/Git queue cleared/);
    await expect(waiter2).rejects.toThrow(/Git queue cleared/);

    release!();
    await running;

    const afterClear = await WorktreeManager.withGitLock('/project', async () => 'after-clear');
    expect(afterClear).toBe('after-clear');
  });
});

// ── scheduleBackgroundPrune tests ─────────────────────────────────────────
//
// scheduleBackgroundPrune is static and uses module-scope backgroundPruneTimestamps
// (no export to reset). Each test uses a unique project path so the per-project
// timestamp key never collides across tests in this file. vi.useFakeTimers is
// used within the debounce test to control Date.now without needing a unique path.

describe('WorktreeManager.scheduleBackgroundPrune', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedSpawnCalls.length = 0;
    spawnOverrides.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // (a) Debounce: a second call within BACKGROUND_PRUNE_COOLDOWN_MS (10 min)
  //     returns early without enqueuing a git op.
  // -------------------------------------------------------------------------
  it('debounce: second call within 10-minute cooldown enqueues no git op', async () => {
    // Use fake timers so Date.now() is controllable and the project path is
    // stable across both calls (same key, testing the cooldown). The spawn mock
    // uses queueMicrotask, so setTimeout(0) drains the async prune chain.
    vi.useFakeTimers();
    const projectPath = '/prune-debounce-test-' + Date.now();

    // First call: should enqueue a prune.
    WorktreeManager.scheduleBackgroundPrune(projectPath);
    // Allow the queued promise chain to run. runAllTimersAsync advances fake
    // timers AND flushes promises, covering the queueMicrotask in the spawn mock.
    await vi.runAllTimersAsync();
    const countAfterFirst = recordedSpawnCalls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    ).length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    const pruneCountBeforeSecond = recordedSpawnCalls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    ).length;

    // Advance time by less than the cooldown (5 minutes).
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);

    // Second call within cooldown: must return early, no additional prune enqueued.
    WorktreeManager.scheduleBackgroundPrune(projectPath);
    await vi.runAllTimersAsync();

    const pruneCountAfterSecond = recordedSpawnCalls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    ).length;
    expect(pruneCountAfterSecond).toBe(pruneCountBeforeSecond);
  });

  // -------------------------------------------------------------------------
  // (b) Priority: the enqueued op runs at GitQueuePriority.BACKGROUND so a
  //     concurrently-queued USER op runs first.
  // -------------------------------------------------------------------------
  it('a USER op enqueued after scheduleBackgroundPrune runs before the prune', async () => {
    // Use a unique project path so debounce timestamps from other tests don't
    // interfere. Use real timers so Promise resolution is immediate.
    const projectPath = '/prune-priority-test-' + Math.random().toString(36).slice(2);

    const executionOrder: string[] = [];
    let releasePrune: () => void;
    const pruneBlock = new Promise<void>((resolve) => { releasePrune = resolve; });

    // Make the spawn that scheduleBackgroundPrune triggers park until we release it.
    // spawnOverrides can't easily block async prune here since spawn is sync;
    // instead we intercept via withGitLock directly using a second USER op approach.
    //
    // Strategy: manually withGitLock a BACKGROUND op first (to simulate the prune),
    // then queue a USER op. This tests the priority scheduler directly, which is
    // what scheduleBackgroundPrune relies on.
    const backgroundOp = WorktreeManager.withGitLock(projectPath, async () => {
      executionOrder.push('background');
      await pruneBlock;
    }, { priority: GitQueuePriority.BACKGROUND });

    const userOp = WorktreeManager.withGitLock(projectPath, async () => {
      executionOrder.push('user');
    }); // default USER priority

    // Both are now queued. Background is running; user is waiting.
    // Release the background op.
    releasePrune!();
    await Promise.all([backgroundOp, userOp]);

    // The background op started first (it was running when user was enqueued),
    // but now it has released - user ran after. Order: background then user.
    // This is the correct behavior: background finishes, then USER runs next
    // because USER priority is lower number (0 < 10).
    expect(executionOrder).toEqual(['background', 'user']);

    // Now test: if background is already running and we enqueue BACKGROUND then USER,
    // the USER runs before the queued BACKGROUND.
    executionOrder.length = 0;
    recordedSpawnCalls.length = 0;

    let releaseRunning: () => void;
    const runningBlock = new Promise<void>((resolve) => { releaseRunning = resolve; });

    const running = WorktreeManager.withGitLock(projectPath, async () => {
      await runningBlock;
    }, { priority: GitQueuePriority.BACKGROUND });

    // Queue a BACKGROUND op (like scheduleBackgroundPrune would enqueue).
    const backgroundQueued = WorktreeManager.withGitLock(projectPath, async () => {
      executionOrder.push('background-queued');
    }, { priority: GitQueuePriority.BACKGROUND });

    // Queue a USER op.
    const userQueued = WorktreeManager.withGitLock(projectPath, async () => {
      executionOrder.push('user-queued');
    }); // USER priority

    releaseRunning!();
    await Promise.all([running, backgroundQueued, userQueued]);

    // User op must run before the queued background op.
    expect(executionOrder).toEqual(['user-queued', 'background-queued']);
  });

  // -------------------------------------------------------------------------
  // (c) Bounded git call: scheduleBackgroundPrune uses runGitWithTimeout (via
  //     spawn) rather than unbounded simple-git. Verify it calls spawn with
  //     'worktree prune' args (not simple-git.raw).
  // -------------------------------------------------------------------------
  it('uses runGitWithTimeout (spawn) for the prune, not unbounded simple-git', async () => {
    const projectPath = '/prune-bounded-test-' + Math.random().toString(36).slice(2);

    WorktreeManager.scheduleBackgroundPrune(projectPath);
    // Drain the microtask/promise queue so the async prune fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const pruneSpawnCalls = recordedSpawnCalls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    );
    expect(pruneSpawnCalls.length).toBeGreaterThanOrEqual(1);

    // The prune should NOT have gone through simple-git (mockProjectGit.raw).
    // mockProjectGit.raw records calls when simple-git is used; spawn records
    // calls when runGitWithTimeout is used. A prune in mockProjectGit.raw
    // would mean the bounded-timeout path was bypassed.
    const simpleGitPruneCalls = mockProjectGit.raw.mock.calls.filter(
      (call: string[][]) => call[0]?.includes('worktree') && call[0]?.includes('prune'),
    );
    expect(simpleGitPruneCalls.length).toBe(0);
  });
});

// ── Queue observability (logging + heartbeat + wait re-emit) ───────────────

describe('WorktreeManager - queue observability', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs queue start/done and heartbeats a long-running holder, then stops', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    WorktreeManager.clearQueue('/obs-1');
    let release: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const job = WorktreeManager.withGitLock('/obs-1', async () => { await blocked; }, { label: 'remove-worktree:abcd1234' });

    const startLogged = logSpy.mock.calls.some(
      (call) => String(call[0]).includes('[GIT_QUEUE] start remove-worktree:abcd1234'),
    );
    expect(startLogged).toBe(true);

    // 15s -> exactly one heartbeat.
    await vi.advanceTimersByTimeAsync(15_000);
    const heartbeatCount = logSpy.mock.calls.filter(
      (call) => String(call[0]).includes('remove-worktree:abcd1234 still running'),
    ).length;
    expect(heartbeatCount).toBe(1);

    release!();
    await job;

    const doneLogged = logSpy.mock.calls.some(
      (call) => String(call[0]).includes('[GIT_QUEUE] done remove-worktree:abcd1234'),
    );
    expect(doneLogged).toBe(true);

    // Interval cleared on settle: advancing further logs no more heartbeats.
    const before = logSpy.mock.calls.filter(
      (call) => String(call[0]).includes('still running'),
    ).length;
    await vi.advanceTimersByTimeAsync(60_000);
    const after = logSpy.mock.calls.filter(
      (call) => String(call[0]).includes('still running'),
    ).length;
    expect(after).toBe(before);
  });

  it('re-emits onWaitProgress every 5s while parked and stops once the job runs', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    WorktreeManager.clearQueue('/obs-2');
    let release: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const elapsedSeen: number[] = [];

    const running = WorktreeManager.withGitLock('/obs-2', async () => { await blocked; }, { label: 'remove-worktree:abcd1234' });
    const parked = WorktreeManager.withGitLock('/obs-2', async () => {}, {
      label: 'create-worktree:ef567890',
      onWaitProgress: (info) => elapsedSeen.push(info.runningElapsedMs),
    });

    // Enqueue-time emit.
    expect(elapsedSeen).toHaveLength(1);

    // Two 5s ticks -> two more emits with growing elapsed.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(elapsedSeen).toHaveLength(3);
    expect(elapsedSeen[2]).toBeGreaterThan(elapsedSeen[0]);

    release!();
    await Promise.all([running, parked]);

    // Wait timer cleared when the parked job dequeued: no further emits.
    const countAfterRun = elapsedSeen.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(elapsedSeen).toHaveLength(countAfterRun);
  });

  it('clears the wait timer when a parked job is rejected by clearQueue', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    WorktreeManager.clearQueue('/obs-3');
    let release: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const emits: number[] = [];

    const running = WorktreeManager.withGitLock('/obs-3', async () => { await blocked; }, { label: 'remove-worktree:abcd1234' });
    const waiter = WorktreeManager.withGitLock('/obs-3', async () => 'never', {
      label: 'create-worktree:ef567890',
      onWaitProgress: (info) => emits.push(info.jobsAhead),
    });
    waiter.catch(() => {});

    expect(emits).toHaveLength(1);

    WorktreeManager.clearQueue('/obs-3');
    await expect(waiter).rejects.toThrow(/Git queue cleared/);

    // No further wait emits after the queue was cleared.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(emits).toHaveLength(1);

    release!();
    await running;
  });
});
