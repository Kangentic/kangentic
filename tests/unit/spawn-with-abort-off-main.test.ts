/**
 * `spawnWithAbort` starts its child in the pty host when one is registered
 * (src/main/git/spawn-with-abort.ts): git, through `runGitWithTimeout`, and a
 * project's script (the Post-Worktree Script, the Stop script). On Windows a
 * spawn is CreateProcess on the calling thread, 15 to 30 ms each, and a
 * workflow's task lifecycles stalled main on them.
 *
 * Pinned for git: the run goes to `spawnOffMainCli` with its arguments, working
 * directory and whole environment, no shell and no group lead, its stdin ended
 * (the local spawn's is 'ignore'), and nothing spawns here. The timeout and the
 * external signal stop the host's run and settle with the wording the local
 * abort gives, which `isGitTimeoutError` and `classifyFetchFailure` read.
 *
 * Pinned for a script: it starts in the host as a run the app does not stop at
 * a quit, an abort or a timeout stops its whole tree there and settles only
 * once the tree has closed (or at the bound), and a host lost with the script
 * running ends what it left by pid. A user loses a clean worktree otherwise: a
 * script's leftover `npm install` held the next creation at that path for 12 s.
 *
 * `node:child_process` is mocked, so no process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock, killByPidMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), killByPidMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// No macOS spawn-helper, whatever platform this runs on (see spawn-with-abort.test.ts).
vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: (): string[] => [],
}));
// The stop by pid is recorded, never run: on POSIX the real one signals a
// process group, and the pid here is made up.
vi.mock('../../src/main/shared/child-tree-stop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shared/child-tree-stop')>()),
  killChildTreeByPid: killByPidMock,
}));

import { spawnWithAbort, TREE_EXIT_WAIT_MS } from '../../src/main/git/spawn-with-abort';
import { runGitWithTimeout, isGitTimeoutError } from '../../src/main/git/git-spawn';
import { classifyFetchFailure, nonInteractiveGitEnv } from '../../src/main/git/fetch-throttle';
import { setOffMainCliSpawner, type CliChildProcess, type CliStopMode, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

class FakeOutput extends EventEmitter {
  resume(): this {
    return this;
  }
}

class FakeStdin extends EventEmitter {
  ended = false;
  write(): boolean {
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

/** A host run as `RemoteCliProcess` presents it, driven by the test. */
class FakeHostRun extends EventEmitter implements CliChildProcess {
  /** Undefined until the host has acknowledged the start, and for a start that failed. */
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  readonly stdin = new FakeStdin();
  /** The mode of each stop asked for, undefined for the default. */
  readonly stopModes: Array<CliStopMode | undefined> = [];

  get stops(): number {
    return this.stopModes.length;
  }

  kill(): boolean {
    this.stopTree();
    return true;
  }

  stopTree(mode?: CliStopMode): void {
    this.stopModes.push(mode);
  }

  finish(code: number, stdout = '', stderr = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) this.stderr.emit('data', Buffer.from(stderr, 'utf8'));
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

interface HostCall {
  command: string;
  args: string[];
  options: OffMainCliOptions;
}

let hostCalls: HostCall[];
let hostRun: FakeHostRun;

function registerHost(): void {
  hostCalls = [];
  hostRun = new FakeHostRun();
  setOffMainCliSpawner((command, args, options) => {
    hostCalls.push({ command, args, options });
    return hostRun;
  });
}

describe('spawnWithAbort with a pty host registered', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    killByPidMock.mockReset();
    registerHost();
  });

  afterEach(() => {
    setOffMainCliSpawner(null);
    vi.useRealTimers();
  });

  it('starts git in the host with its args, cwd and whole environment, no shell and no group lead, and spawns nothing here', async () => {
    process.env.KANGENTIC_GIT_HOST_PROBE = 'inherited';
    let pending: Promise<{ stdout: string; stderr: string }>;
    try {
      pending = runGitWithTimeout('/mock/repo', ['fetch', '--no-auto-gc', 'origin', 'main'], { timeoutMs: 15_000 });
    } finally {
      delete process.env.KANGENTIC_GIT_HOST_PROBE;
    }
    hostRun.finish(0, 'fetched\n', 'From origin\n');

    await expect(pending).resolves.toEqual({ stdout: 'fetched\n', stderr: 'From origin\n' });
    expect(hostCalls).toHaveLength(1);
    const [call] = hostCalls;
    expect(call.command).toBe('git');
    expect(call.args).toEqual(['fetch', '--no-auto-gc', 'origin', 'main']);
    expect(call.options).toMatchObject({ cwd: '/mock/repo', shell: false, detached: false });
    // Omitted env inherits main's current environment, as a local spawn does.
    expect(call.options.env.KANGENTIC_GIT_HOST_PROBE).toBe('inherited');
    expect(hostRun.stdin.ended).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('hands a caller\'s environment to the host as given', async () => {
    const pending = runGitWithTimeout('/mock/repo', ['fetch', '--all'], { timeoutMs: 5_000, env: nonInteractiveGitEnv() });
    hostRun.finish(0);
    await pending;

    expect(hostCalls[0].options.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(hostCalls[0].options.env.GCM_INTERACTIVE).toBe('never');
  });

  it('reports a failed exit with the label and stderr, as the local spawn does', async () => {
    const pending = runGitWithTimeout('/mock/repo', ['worktree', 'remove', '/mock/wt', '--force'], { timeoutMs: 15_000 });
    hostRun.finish(128, '', 'fatal: \'/mock/wt\' is not a working tree\n');

    await expect(pending).rejects.toThrow("git worktree remove /mock/wt --force exited with code 128: fatal: '/mock/wt' is not a working tree");
  });

  it('stops the host run on its timeout and settles with the wording isGitTimeoutError reads', async () => {
    vi.useFakeTimers();
    const pending = runGitWithTimeout('/mock/repo', ['fetch', '--no-auto-gc', 'origin', 'main'], { timeoutMs: 1_000 });
    const settled = pending.then(() => null, (error: unknown) => error);
    vi.advanceTimersByTime(1_000);
    const error = await settled;

    // The default stop: git's tree with the grace, never the script's stop at once.
    expect(hostRun.stopModes).toEqual([undefined]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('git fetch --no-auto-gc origin main aborted (timeout after 1000ms) (child process killed)');
    expect(isGitTimeoutError(error)).toBe(true);
    expect(classifyFetchFailure(error)).toBe('timeout');
  });

  it('stops the host run on an external abort and settles as an abort, not a timeout', async () => {
    const external = new AbortController();
    const pending = runGitWithTimeout('/mock/repo', ['fetch', '--no-auto-gc', 'origin', 'main'], { timeoutMs: 15_000, signal: external.signal });
    const settled = pending.then(() => null, (error: unknown) => error);
    external.abort();
    const error = await settled;
    // A close after the stop changes nothing: the first settle wins.
    hostRun.finish(1);

    expect(hostRun.stops).toBe(1);
    expect((error as Error).message).toBe('git fetch --no-auto-gc origin main aborted (external abort) (child process killed)');
    expect(isGitTimeoutError(error)).toBe(false);
    expect(classifyFetchFailure(error)).toBe('abort');
  });

  it('posts nothing to the host when the signal is already aborted', async () => {
    const external = new AbortController();
    external.abort();

    await expect(runGitWithTimeout('/mock/repo', ['fetch'], { timeoutMs: 15_000, signal: external.signal }))
      .rejects.toThrow('git fetch aborted before spawn');
    expect(hostCalls).toHaveLength(0);
  });

  it('rejects with the host\'s error when git could not start there', async () => {
    const pending = runGitWithTimeout('/mock/repo', ['status'], { timeoutMs: 15_000 });
    hostRun.emit('error', new Error('spawn git ENOENT'));
    hostRun.emit('close', null, null);

    await expect(pending).rejects.toThrow('spawn git ENOENT');
    // Git is not a script: a host lost under it ends nothing by pid here.
    expect(killByPidMock).not.toHaveBeenCalled();
  });
});

describe('a script (a shell command) with a pty host registered', () => {
  const SCRIPT = { command: 'npm install', cwd: '/mock/worktree', label: 'init script', signalKillAssertsTimeout: false };

  beforeEach(() => {
    spawnMock.mockReset();
    killByPidMock.mockReset();
    registerHost();
  });

  afterEach(() => {
    setOffMainCliSpawner(null);
    vi.useRealTimers();
  });

  it('starts in the host through the shell, as a run a quit leaves alone, and spawns nothing here', async () => {
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000, env: { KANGENTIC_SCRIPT: 'yes', CHROME_CRASHPAD_PIPE_NAME: 'pipe' } });
    hostRun.finish(0, 'added 12 packages\n');

    await expect(pending).resolves.toEqual({ stdout: 'added 12 packages\n', stderr: '' });
    expect(hostCalls).toHaveLength(1);
    const [call] = hostCalls;
    // The whole command line for the platform shell, with no args array.
    expect(call.command).toBe('npm install');
    expect(call.args).toEqual([]);
    expect(call.options.cwd).toBe('/mock/worktree');
    expect(call.options.shell).toBe(true);
    // Its own process group where there is one, so a stop reaches what it started.
    expect(call.options.detached).toBe(process.platform !== 'win32');
    expect(call.options.outlivesApp).toBe(true);
    expect(call.options.env).toEqual({ KANGENTIC_SCRIPT: 'yes' });
    expect(hostRun.stdin.ended).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops the whole tree at once on an external abort, and settles only when the tree has closed', async () => {
    const external = new AbortController();
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000, signal: external.signal });
    let settled = false;
    const outcome = pending.then(() => null, (error: unknown) => error).finally(() => { settled = true; });

    external.abort();
    await Promise.resolve();
    await Promise.resolve();

    expect(hostRun.stopModes).toEqual(['treeNow']);
    // Something the script started may still be running in the worktree.
    expect(settled).toBe(false);

    // The killed shell closes, with whatever exit code the kill left.
    hostRun.finish(1);
    const error = await outcome;
    expect((error as Error).message).toBe('init script aborted (external abort) (child process killed)');
    expect((error as { timedOut?: boolean }).timedOut).toBe(false);
    expect(killByPidMock).not.toHaveBeenCalled();
  });

  it('stops the tree on its timeout and reports the timeout as the cause', async () => {
    vi.useFakeTimers();
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 1_000 });
    const outcome = pending.then(() => null, (error: unknown) => error);

    vi.advanceTimersByTime(1_000);
    expect(hostRun.stopModes).toEqual(['treeNow']);
    hostRun.finish(1);

    const error = await outcome;
    expect((error as Error).message).toBe('init script aborted (timeout after 1000ms) (child process killed)');
    expect((error as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it('settles at the bound when the killed tree never closes', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 600_000, signal: external.signal });
    let settled = false;
    const outcome = pending.then(() => null, (error: unknown) => error).finally(() => { settled = true; });

    external.abort();
    await vi.advanceTimersByTimeAsync(TREE_EXIT_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(((await outcome) as Error).message).toBe('init script aborted (external abort) (child process killed)');
  });

  it('sends the stop for a script the host has not acknowledged yet, and still waits for its close', async () => {
    hostRun.pid = undefined;
    const external = new AbortController();
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000, signal: external.signal });
    let settled = false;
    const outcome = pending.then(() => null, (error: unknown) => error).finally(() => { settled = true; });

    external.abort();
    await Promise.resolve();
    await Promise.resolve();

    // The host holds the stop until the run has a pid, so it is always sent.
    expect(hostRun.stopModes).toEqual(['treeNow']);
    expect(settled).toBe(false);
    hostRun.finish(1);
    expect(((await outcome) as Error).message).toContain('aborted (external abort)');
  });

  it('ends by pid what a script left when its host is lost, and rejects with the host\'s error', async () => {
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000 });
    const lost = new Error('The pty host stopped while the agent was running');
    // The order `RemoteCliProcess.deliverHostLost` uses: the error first, then the exit and the close.
    hostRun.emit('error', lost);
    hostRun.signalCode = 'SIGKILL';
    hostRun.emit('exit', null, 'SIGKILL');
    hostRun.emit('close', null, 'SIGKILL');

    await expect(pending).rejects.toBe(lost);
    expect(killByPidMock).toHaveBeenCalledTimes(1);
    expect(killByPidMock).toHaveBeenCalledWith(4242);
  });

  it('ends nothing by pid for a script that never started', async () => {
    hostRun.pid = undefined;
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000 });
    hostRun.emit('error', new Error('spawn /bin/sh ENOENT'));
    hostRun.emit('close', null, null);

    await expect(pending).rejects.toThrow('spawn /bin/sh ENOENT');
    expect(killByPidMock).not.toHaveBeenCalled();
  });

  it('reports a script that fails on its own with its exit code and output', async () => {
    const pending = spawnWithAbort(SCRIPT, { timeoutMs: 60_000 });
    hostRun.finish(2, '', 'npm ERR! code ENOENT\n');

    const error = await pending.then(() => null, (failure: unknown) => failure);
    expect((error as Error).message).toBe('init script exited with code 2: npm ERR! code ENOENT');
    expect((error as { exitCode?: number }).exitCode).toBe(2);
    expect(hostRun.stops).toBe(0);
  });
});

describe('spawnWithAbort with no pty host registered', () => {
  it('spawns git here, as before', async () => {
    setOffMainCliSpawner(null);
    spawnMock.mockReset();
    const localChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 99 });
    spawnMock.mockReturnValue(localChild);

    const pending = runGitWithTimeout('/mock/repo', ['worktree', 'prune'], { timeoutMs: 15_000 });
    localChild.emit('close', 0, null);
    await pending;

    expect(spawnMock).toHaveBeenCalledWith('git', ['worktree', 'prune'], expect.objectContaining({ cwd: '/mock/repo' }));
  });
});
