/**
 * Unit tests for spawnWithAbort's `env` option (src/main/git/spawn-with-abort.ts).
 *
 * The background fetch scheduler must not be able to raise a credential
 * prompt, which it achieves by handing git a copy of the environment with the
 * prompt-suppressing variables set (nonInteractiveGitEnv in fetch-throttle.ts).
 * That only works if the option actually reaches `child_process.spawn`, on
 * BOTH spawn shapes, and if its absence still means "process.env". Either way
 * the child never gets Crashpad's pipe name (child-env.ts).
 *
 * `node:child_process` is mocked with a fake child that settles on `close`, so
 * no process is spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock, helperCandidatesMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  helperCandidatesMock: vi.fn((): string[] => []),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// No spawn-helper unless a test hands one in. node-pty ships darwin helpers in
// its tarball, and on Windows an execute check passes for any file that
// exists, so the real lookup would find one locally and none on CI.
vi.mock('../../src/main/pty/spawn/spawn-helper-permissions', () => ({
  spawnHelperCandidatePaths: helperCandidatesMock,
}));

import { spawnWithAbort } from '../../src/main/git/spawn-with-abort';
import { setOffMainCliSpawner, type CliChildProcess, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const BINARY_TARGET = {
  command: 'git',
  args: ['fetch', '--all'],
  cwd: '/mock/repo',
  label: 'git fetch --all',
  signalKillAssertsTimeout: true,
};

const SHELL_TARGET = {
  command: 'npm install',
  cwd: '/mock/repo',
  label: 'init script',
  signalKillAssertsTimeout: false,
};

/** The options object handed to spawn, whichever positional shape was used. */
function spawnOptions(): Record<string, unknown> {
  const call = spawnMock.mock.calls[0];
  return call[call.length - 1] as Record<string, unknown>;
}

describe('spawnWithAbort env option', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('hands a supplied env to the child on the binary-spawn shape', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000, env });
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith('git', ['fetch', '--all'], expect.objectContaining({ cwd: '/mock/repo', env }));
  });

  it('hands a supplied env to the child on the shell-string shape', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' };

    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 1_000, env });
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith('npm install', expect.objectContaining({ shell: true, env }));
  });

  describe('Crashpad\'s pipe name', () => {
    const pipeKey = 'CHROME_CRASHPAD_PIPE_NAME';
    let savedHostValue: string | undefined;

    beforeEach(() => {
      savedHostValue = process.env[pipeKey];
      process.env[pipeKey] = '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP';
      process.env.KANGENTIC_SPAWN_WITH_ABORT_PROBE = 'inherited';
    });

    afterEach(() => {
      if (savedHostValue === undefined) delete process.env[pipeKey];
      else process.env[pipeKey] = savedHostValue;
      delete process.env.KANGENTIC_SPAWN_WITH_ABORT_PROBE;
      setOffMainCliSpawner(null);
    });

    it.each([
      ['git', BINARY_TARGET],
      ['the init script', SHELL_TARGET],
    ])('hands %s main\'s environment without it when no env is supplied', async (_label, target) => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const pending = spawnWithAbort(target, { timeoutMs: 1_000 });
      child.emit('close', 0, null);

      await pending;
      const env = spawnOptions().env as NodeJS.ProcessEnv;
      expect(env.KANGENTIC_SPAWN_WITH_ABORT_PROBE).toBe('inherited');
      expect(env[pipeKey]).toBeUndefined();
      expect(process.env[pipeKey]).toBeDefined();
    });

    it('drops it from a supplied env', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000, env: { PATH: '/usr/bin', [pipeKey]: 'supplied' } });
      child.emit('close', 0, null);

      await pending;
      expect(spawnOptions().env).toEqual({ PATH: '/usr/bin' });
    });

    it('never ships it to the pty host', async () => {
      const shipped: OffMainCliOptions[] = [];
      setOffMainCliSpawner((_command, _args, options) => {
        shipped.push(options);
        const remote = Object.assign(fakeChild(), {
          exitCode: null,
          signalCode: null,
          stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
          kill: () => true,
        });
        Object.assign(remote.stdout, { resume: () => undefined });
        Object.assign(remote.stderr, { resume: () => undefined });
        queueMicrotask(() => remote.emit('close', 0, null));
        return remote as unknown as CliChildProcess;
      });

      await spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
      expect(shipped).toHaveLength(1);
      expect(shipped[0].env.KANGENTIC_SPAWN_WITH_ABORT_PROBE).toBe('inherited');
      expect(shipped[0].env[pipeKey]).toBeUndefined();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * An aborted init script loses its whole tree through `taskkill /T` on
 * Windows, by the shell's pid. Node pins that pid only until it has handled the
 * shell's exit, and a shell can exit while something it started still holds
 * its output pipes open, so `close` (which settles the call) comes later. An
 * abort in that gap must not tree-kill a pid that may name a stranger by then
 * (src/main/shared/child-tree-stop.ts).
 */
describe('spawnWithAbort on Windows: the tree kill on an abort', () => {
  const originalPlatform = process.platform;
  const taskkillHandle = { on: () => taskkillHandle, unref: () => taskkillHandle };

  beforeEach(() => {
    spawnMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  function runningShell(): FakeChild & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null } {
    const shell = Object.assign(fakeChild(), { pid: 4321, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
    spawnMock.mockImplementation((command: string) => (command === 'taskkill' ? taskkillHandle : shell));
    return shell;
  }

  const taskkillCalls = (): unknown[][] => spawnMock.mock.calls.filter(([command]) => command === 'taskkill');

  it('takes a running shell\'s tree by its pid', async () => {
    const shell = runningShell();
    const abort = new AbortController();
    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 60_000, signal: abort.signal });
    abort.abort();
    shell.emit('close', 1, null);
    await expect(pending).rejects.toThrow('aborted (external abort)');
    expect(taskkillCalls().map(([, args]) => args)).toEqual([['/pid', '4321', '/T', '/F']]);
  });

  it('starts no taskkill once the shell has exited, though its pipes are still open', async () => {
    const shell = runningShell();
    const abort = new AbortController();
    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 60_000, signal: abort.signal });
    // Node has handled the exit; something the script started still holds stdout.
    shell.exitCode = 0;
    abort.abort();
    shell.emit('close', 0, null);
    await expect(pending).rejects.toThrow('aborted (external abort)');
    expect(taskkillCalls()).toEqual([]);
  });
});

/**
 * The init script can start anything, so on macOS it runs through node-pty's
 * spawn-helper, which clears Crashpad's inherited exception port before exec
 * (src/main/pty/spawn/shell-launch.ts). git itself does not.
 */
describe('spawnWithAbort on macOS', () => {
  const originalPlatform = process.platform;
  // Any file this process can execute stands in for the helper here: nothing
  // is spawned, and the lookup only checks that the candidate is executable.
  const HELPER = process.execPath;

  beforeEach(() => {
    spawnMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    helperCandidatesMock.mockReturnValue([HELPER]);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    helperCandidatesMock.mockReturnValue([]);
  });

  it('runs the init script through the helper as `/bin/sh -c`, keeping its cwd and options', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 1_000 });
    child.emit('close', 0, null);

    await pending;
    expect(spawnMock).toHaveBeenCalledWith(
      HELPER,
      ['', '/bin/sh', '-c', 'npm install'],
      expect.objectContaining({ cwd: '/mock/repo', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('leaves a git binary spawn alone', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    child.emit('close', 0, null);

    await pending;
    expect(spawnMock).toHaveBeenCalledWith('git', ['fetch', '--all'], expect.objectContaining({ shell: false }));
  });
});
