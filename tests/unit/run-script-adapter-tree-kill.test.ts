/**
 * The run_script adapter ends a script's whole tree when its budget runs out or
 * the move is superseded (src/main/automations/adapters/run-script/index.ts).
 * A bare `child.kill()` reaches the shell only, and a shell that has started
 * `npm ci` leaves the install running with nothing left to stop it. So the
 * adapter stops the run in the `treeNow` mode: on POSIX that signals the
 * process group the `detached` start created, and on Windows it is
 * `taskkill /T` (src/main/shared/child-tree-stop.ts).
 *
 * The script starts in the pty host when one is registered, so the start never
 * runs on main's thread, and the stop is carried out there. With no host it
 * starts here and the same stop is `killChildTreeNow`. Both are pinned, and so
 * is what a host lost under a running script does.
 *
 * `run-script-adapter.test.ts` runs real scripts and checks the outcome. Here
 * `node:child_process` and the kills are mocked, so no process is spawned and
 * none is signalled: on POSIX the real helper signals the pid's process group,
 * and a fake pid could name anything on the machine running the suite.
 */

import os from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockKillChildTreeNow, mockKillChildTreeByPid } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockKillChildTreeNow: vi.fn(),
  mockKillChildTreeByPid: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('../../src/main/shared/child-tree-stop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shared/child-tree-stop')>()),
  killChildTreeNow: mockKillChildTreeNow,
  killChildTreeByPid: mockKillChildTreeByPid,
}));

import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import { AutomationTimeoutError } from '../../src/main/automations/shared/automation-errors';
import { setOffMainCliSpawner, type CliChildProcess, type CliStopMode, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';
import type { Task } from '../../src/shared/types';

// Any shell resolves here: nothing runs, the spawn is a fake.
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

interface FakeScriptChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: null;
  stdout: null;
  stderr: null;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

/** A child as `spawn` hands it back with stdio ignored: no streams. */
function fakeScriptChild(pid: number): FakeScriptChild {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdin: null, stdout: null, stderr: null, kill: vi.fn(), unref: vi.fn() });
}

function makeContext(signal: AbortSignal = new AbortController().signal): AutomationContext {
  return {
    task: { id: 'task-1', title: 'A task' } as Task,
    column: { name: 'Executing' },
    trigger: 'enter',
    cwd: os.tmpdir(),
    projectId: 'project-1',
    templateVars: { title: 'A task', toColumn: 'Executing' },
    sessionHost: { getShell: async () => SHELL },
    signal,
    runId: 'run-1',
    // The adapter reads none of the rest; the cast keeps the fake to what it uses.
  } as unknown as AutomationContext;
}

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** The adapter reads the shell asynchronously before it starts the script, so let that settle. */
async function until(started: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !started(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(started()).toBe(true);
}

describe('run_script with no pty host: the tree kill of a script that is stopped', () => {
  let child: FakeScriptChild;
  const untilSpawned = (): Promise<void> => until(() => mockSpawn.mock.calls.length === 1);

  beforeEach(() => {
    setOffMainCliSpawner(null);
    mockSpawn.mockReset();
    mockKillChildTreeNow.mockReset();
    mockKillChildTreeByPid.mockReset();
    child = fakeScriptChild(4242);
    mockSpawn.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  it('kills the tree of a script that outlives its budget, as the leader of its group', async () => {
    // Timeouts only: the adapter's budget is the one timer under test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    const rejection = expect(pending).rejects.toBeInstanceOf(AutomationTimeoutError);
    await untilSpawned();

    // Positive control: nothing is killed while the script is inside its budget.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(mockKillChildTreeNow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    expect(mockKillChildTreeNow).toHaveBeenCalledTimes(1);
    expect(mockKillChildTreeNow.mock.calls[0][0]).toBe(child);
    // The group exists only where the start made one (see the last test).
    expect(mockKillChildTreeNow.mock.calls[0][1]).toEqual({ leadsGroup: process.platform !== 'win32' });
    // The tree kill is the whole stop: the adapter never signals the shell alone.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills the tree of a script when the move is superseded, as the leader of its group', async () => {
    const controller = new AbortController();

    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext(controller.signal));
    const rejection = expect(pending).rejects.toThrow('superseded');
    await untilSpawned();
    expect(mockKillChildTreeNow).not.toHaveBeenCalled();

    controller.abort();
    await rejection;

    expect(mockKillChildTreeNow).toHaveBeenCalledTimes(1);
    expect(mockKillChildTreeNow.mock.calls[0][0]).toBe(child);
    expect(mockKillChildTreeNow.mock.calls[0][1]).toEqual({ leadsGroup: process.platform !== 'win32' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills nothing for a script that finished, even when the move is superseded afterwards', async () => {
    const controller = new AbortController();

    const pending = runScriptAdapter.execute({ script: 'exit 0', timeoutMinutes: 1 }, makeContext(controller.signal));
    await untilSpawned();
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({ detail: 'exit 0' });

    controller.abort();
    expect(mockKillChildTreeNow).not.toHaveBeenCalled();
  });

  // The group kill signals -pid, a group that exists only when the spawn
  // created one, so the group kill and `detached` are one decision. Windows has
  // no groups (`detached` there changes console attachment), and `taskkill /T`
  // walks the tree. The platform is pinned so each branch runs on every host.
  it.each([
    { platform: 'linux' as const, detached: true },
    { platform: 'win32' as const, detached: false },
  ])('starts the script with detached $detached on $platform, and kills its group only where it leads one', async ({ platform, detached }) => {
    setPlatform(platform);
    const controller = new AbortController();

    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext(controller.signal));
    const rejection = expect(pending).rejects.toThrow('superseded');
    await untilSpawned();
    controller.abort();
    await rejection;

    const spawnOptions = mockSpawn.mock.calls[0][2] as { detached?: boolean; stdio?: unknown };
    expect(spawnOptions.detached === true).toBe(detached);
    // Nothing reads a script's output, and an unread pipe would block it.
    expect(spawnOptions.stdio).toBe('ignore');
    expect(mockKillChildTreeNow.mock.calls[0][1]).toEqual({ leadsGroup: detached });
  });

  it('reports a script whose shell fails after it started as that failure, and ends nothing by pid', async () => {
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    const rejection = expect(pending).rejects.toThrow('kill EPERM');
    await untilSpawned();

    // A local child's own error: the child is still this process's to stop.
    child.emit('error', new Error('kill EPERM'));
    await rejection;

    expect(mockKillChildTreeByPid).not.toHaveBeenCalled();
  });
});

describe('run_script with a pty host registered', () => {
  interface HostedScript {
    command: string;
    args: string[];
    options: OffMainCliOptions;
    child: CliChildProcess & { pid: number | undefined; stopModes: Array<CliStopMode | undefined> };
  }

  let scripts: HostedScript[];
  const untilStarted = (): Promise<void> => until(() => scripts.length === 1);

  beforeEach(() => {
    mockSpawn.mockReset();
    mockKillChildTreeNow.mockReset();
    mockKillChildTreeByPid.mockReset();
    scripts = [];
    // Stands in for the host: records the start, and hands back a run the test drives.
    setOffMainCliSpawner((command, args, options) => {
      const stopModes: Array<CliStopMode | undefined> = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 4242 as number | undefined,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdout: Object.assign(new EventEmitter(), { resume: () => undefined }),
        stderr: Object.assign(new EventEmitter(), { resume: () => undefined }),
        stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
        kill: () => true,
        stopTree: (mode?: CliStopMode) => { stopModes.push(mode); },
        stopModes,
      });
      scripts.push({ command, args, options, child });
      return child;
    });
  });

  afterEach(() => {
    setOffMainCliSpawner(null);
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  it.each([
    { platform: 'linux' as const, detached: true },
    { platform: 'win32' as const, detached: false },
  ])('starts the script there on $platform with no pipes, as a run a quit leaves alone, and nothing here', async ({ platform, detached }) => {
    setPlatform(platform);
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    await untilStarted();
    scripts[0].child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ detail: 'exit 0' });
    const { options, args } = scripts[0];
    // The shell's own non-interactive form, never a second shell around it.
    expect(args.at(-1)).toContain('npm ci');
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(os.tmpdir());
    expect(options.stdio).toBe('ignore');
    expect(options.detached).toBe(detached);
    expect(options.outlivesApp).toBe(true);
    // The template variables travel as environment variables.
    expect(options.env.KANGENTIC_TO_COLUMN).toBe('Executing');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(scripts[0].child.stopModes).toEqual([]);
  });

  it('stops the whole tree at once, in the host, when the script outlives its budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    const rejection = expect(pending).rejects.toBeInstanceOf(AutomationTimeoutError);
    await untilStarted();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(scripts[0].child.stopModes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    expect(scripts[0].child.stopModes).toEqual(['treeNow']);
    expect(mockKillChildTreeNow).not.toHaveBeenCalled();
    expect(mockKillChildTreeByPid).not.toHaveBeenCalled();
  });

  it('stops the whole tree at once, in the host, when the move is superseded', async () => {
    const controller = new AbortController();
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext(controller.signal));
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await untilStarted();

    controller.abort('moved');
    await rejection;

    expect(scripts[0].child.stopModes).toEqual(['treeNow']);
  });

  it('ends by pid what a script left when its host is lost, and fails the run as a classified error', async () => {
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    // The classified error, which no reporter sends: the host's own crash is reported where it is noticed.
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'AutomationPermanentError',
      message: 'The script was stopped: the process running it ended unexpectedly.',
    });
    await untilStarted();

    // The order main's handle uses when its host dies: the error, then the exit and the close.
    scripts[0].child.emit('error', new Error('The pty host stopped while the agent was running'));
    scripts[0].child.signalCode = 'SIGKILL';
    scripts[0].child.emit('exit', null, 'SIGKILL');
    scripts[0].child.emit('close', null, 'SIGKILL');
    await rejection;

    expect(mockKillChildTreeByPid).toHaveBeenCalledTimes(1);
    expect(mockKillChildTreeByPid).toHaveBeenCalledWith(4242);
  });

  it('reports a shell the host could not start as that failure, and ends nothing by pid', async () => {
    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext());
    const rejection = expect(pending).rejects.toThrow('spawn no-such-shell ENOENT');
    await untilStarted();

    scripts[0].child.pid = undefined;
    scripts[0].child.emit('error', new Error('spawn no-such-shell ENOENT'));
    scripts[0].child.emit('close', null, null);
    await rejection;

    expect(mockKillChildTreeByPid).not.toHaveBeenCalled();
  });
});
