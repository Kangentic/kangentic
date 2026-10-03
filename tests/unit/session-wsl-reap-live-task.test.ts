/**
 * The in-distro WSL reap leaves out a task that has a live session again, or
 * one starting (src/main/pty/session-manager.ts, reapTaskProcesses). The pty
 * host protects every PTY it holds and everything under it; the distro's
 * script cannot tell which Linux processes those are, so without this a To Do
 * task dragged back into a running column while the startup sweep reaped it
 * would have its new WSL agent killed. The host reap still gets every task.
 *
 * `process.platform` is faked as win32, and `wsl.exe` is answered by a fake
 * off-main executor, so this runs on every OS.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (message: string) => message }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';
import type { HostExecRequest, HostExecResult } from '../../src/main/pty/host/protocol';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';

const LIVE_TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const STARTING_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const IDLE_TASK = '1c2d3e4f-5061-4728-9930-4b5c6d7e8f90';
const EMPTY: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] };

const realPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  setOffMainExecutor(null);
  vi.restoreAllMocks();
});

function setup() {
  const manager = new SessionManager();
  const hostRequests: TaggedReapRequest[] = [];
  Object.assign((manager as unknown as { host: { reapTaggedProcesses: unknown } }).host, {
    reapTaggedProcesses: async (request: TaggedReapRequest) => {
      hostRequests.push(request);
      return EMPTY;
    },
  });
  Object.assign(manager, { getShell: async () => 'wsl -d Ubuntu' });

  const wslCalls: string[][] = [];
  setOffMainExecutor(async (request: HostExecRequest): Promise<HostExecResult> => {
    if (request.kind !== 'execFile') throw new Error(`unexpected ${request.kind}`);
    wslCalls.push(request.args);
    return { ok: true, stdout: request.args.includes('--running') ? 'Ubuntu\n' : '', stderr: '' };
  });

  const seedLiveSession = (taskId: string): void => {
    const registry = (manager as unknown as { registry: { set(id: string, session: ManagedSession): void } }).registry;
    const session: ManagedSession = {
      id: `session-${taskId.slice(0, 4)}`,
      taskId,
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: 'wsl -d Ubuntu',
      cwd: os.tmpdir(),
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    };
    registry.set(session.id, session);
  };

  const seedStartingSpawn = (taskId: string): void => {
    const spawnsInFlight = (manager as unknown as { spawnsInFlight: Map<string, unknown> }).spawnsInFlight;
    spawnsInFlight.set('session-starting', { taskId, cancelled: false, abandonedPtyExit: null, settled: new Promise(() => undefined) });
  };

  const distroReapArgs = (): string[] | undefined => wslCalls.find((args) => args[0] === '-d');
  return { manager, hostRequests, wslCalls, seedLiveSession, seedStartingSpawn, distroReapArgs };
}

const allTasks = [LIVE_TASK, STARTING_TASK, IDLE_TASK].map((id) => ({ id, worktreePath: null }));

describe('the WSL reap and a task with a live or starting session', () => {
  it('reaps in the distro only the task with neither, while the host reap still gets all three', async () => {
    const { manager, hostRequests, seedLiveSession, seedStartingSpawn, distroReapArgs } = setup();
    seedLiveSession(LIVE_TASK);
    seedStartingSpawn(STARTING_TASK);

    await manager.reapTaskProcesses(os.tmpdir(), allTasks, { stop: true });

    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0].tasks.map((task) => task.taskId).sort()).toEqual([LIVE_TASK, STARTING_TASK, IDLE_TASK].sort());
    const reapArgs = distroReapArgs();
    expect(reapArgs).toBeDefined();
    // `-d Ubuntu -e sh -c <script> sh <task id> <count> <directories...>`
    const positional = reapArgs!.slice(6);
    expect(positional).toContain(IDLE_TASK);
    expect(positional).not.toContain(LIVE_TASK);
    expect(positional).not.toContain(STARTING_TASK);
  });

  it('runs no wsl.exe at all when every task has a live or starting session', async () => {
    const { manager, wslCalls, seedLiveSession, seedStartingSpawn } = setup();
    seedLiveSession(LIVE_TASK);
    seedStartingSpawn(STARTING_TASK);

    await manager.reapTaskProcesses(os.tmpdir(), [LIVE_TASK, STARTING_TASK].map((id) => ({ id, worktreePath: null })), { stop: true });

    expect(wslCalls).toEqual([]);
  });

  it('reaps every task in the distro when none has a session, as a terminal transition finds them', async () => {
    const { manager, distroReapArgs } = setup();

    await manager.reapTaskProcesses(os.tmpdir(), allTasks, { stop: true });

    const positional = distroReapArgs()!.slice(6);
    for (const taskId of [LIVE_TASK, STARTING_TASK, IDLE_TASK]) expect(positional).toContain(taskId);
  });
});
