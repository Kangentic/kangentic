/**
 * The run_script adapter ends a script's whole tree when its budget runs out or
 * the move is superseded (src/main/automations/adapters/run-script/index.ts).
 * A bare `child.kill()` reaches the shell only, and a shell that has started
 * `npm ci` leaves the install running with nothing left to stop it. The adapter
 * therefore hands the child to `killChildTreeNow` with `leadsGroup: true`: on
 * POSIX that signals the process group the `detached` spawn created, and on
 * Windows it is `taskkill /T` (src/main/shared/child-tree-stop.ts).
 *
 * `run-script-adapter.test.ts` runs real scripts and checks the outcome. These
 * pin the one call that makes the kill a tree kill. `node:child_process` and
 * the tree kill are mocked, so no process is spawned and none is signalled: on
 * POSIX the real helper signals the pid's process group, and a fake pid could
 * name anything on the machine running the suite.
 */

import os from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockKillChildTreeNow } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockKillChildTreeNow: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('../../src/main/shared/child-tree-stop', () => ({ killChildTreeNow: mockKillChildTreeNow }));

import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import { AutomationTimeoutError } from '../../src/main/automations/shared/automation-errors';
import type { Task } from '../../src/shared/types';

// Any shell resolves here: nothing runs, the spawn is a fake.
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

interface FakeScriptChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeScriptChild(pid: number): FakeScriptChild {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: vi.fn() });
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

/** The adapter reads the shell asynchronously before it spawns, so let that settle. */
async function untilSpawned(): Promise<void> {
  for (let attempt = 0; attempt < 50 && mockSpawn.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(mockSpawn).toHaveBeenCalledTimes(1);
}

describe('run_script: the tree kill of a script that is stopped', () => {
  let child: FakeScriptChild;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockKillChildTreeNow.mockReset();
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
    expect(mockKillChildTreeNow.mock.calls[0][1]).toEqual({ leadsGroup: true });
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
    expect(mockKillChildTreeNow.mock.calls[0][1]).toEqual({ leadsGroup: true });
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

  // `leadsGroup: true` signals -pid, a group that exists only when the spawn
  // created one, so the group kill and `detached` are one decision. Windows has
  // no groups (`detached` there changes console attachment), and `taskkill /T`
  // walks the tree. The platform is pinned so each branch runs on every host.
  it.each([
    { platform: 'linux' as const, detached: true },
    { platform: 'win32' as const, detached: false },
  ])('starts the script with detached $detached on $platform', async ({ platform, detached }) => {
    setPlatform(platform);
    const controller = new AbortController();

    const pending = runScriptAdapter.execute({ script: 'npm ci', timeoutMinutes: 1 }, makeContext(controller.signal));
    const rejection = expect(pending).rejects.toThrow('superseded');
    await untilSpawned();
    controller.abort();
    await rejection;

    const spawnOptions = mockSpawn.mock.calls[0][2] as { detached?: boolean };
    expect(spawnOptions.detached).toBe(detached);
  });
});
