/**
 * `spawnWithAbort` starts a binary (git, through `runGitWithTimeout`) in the
 * pty host when one is registered (src/main/git/spawn-with-abort.ts). On
 * Windows a spawn is CreateProcess on the calling thread, 15 to 30 ms each, and
 * a workflow's task lifecycles stalled main on them.
 *
 * Pinned: the run goes to `spawnOffMainCli` with its arguments, working
 * directory and whole environment, no shell and no group lead, its stdin ended
 * (the local spawn's is 'ignore'), and nothing spawns here. The timeout and the
 * external signal stop the host's run and settle with the wording the local
 * abort gives, which `isGitTimeoutError` and `classifyFetchFailure` read. A
 * shell command (the init script) never goes to the host.
 *
 * `node:child_process` is mocked, so no process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// No macOS spawn-helper, whatever platform this runs on (see spawn-with-abort.test.ts).
vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: (): string[] => [],
}));

import { spawnWithAbort } from '../../src/main/git/spawn-with-abort';
import { runGitWithTimeout, isGitTimeoutError } from '../../src/main/git/git-spawn';
import { classifyFetchFailure, nonInteractiveGitEnv } from '../../src/main/git/fetch-throttle';
import { setOffMainCliSpawner, type CliChildProcess, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

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
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  readonly stdin = new FakeStdin();
  stops = 0;

  kill(): boolean {
    this.stopTree();
    return true;
  }

  stopTree(): void {
    this.stops += 1;
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

    expect(hostRun.stops).toBe(1);
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
  });

  it('keeps a shell command (the init script) in this process', async () => {
    const localChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 99 });
    spawnMock.mockReturnValue(localChild);

    const pending = spawnWithAbort(
      { command: 'npm install', cwd: '/mock/repo', label: 'init script', signalKillAssertsTimeout: false },
      { timeoutMs: 60_000 },
    );
    localChild.emit('close', 0, null);
    await pending;

    expect(hostCalls).toHaveLength(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
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
