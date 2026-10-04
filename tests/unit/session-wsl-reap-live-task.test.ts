/**
 * The in-distro WSL reap leaves out a task that has a live session again, or
 * one starting (src/main/pty/session-manager.ts, reapTaskProcesses). The pty
 * host protects every PTY it holds and everything under it; the distro's
 * script cannot tell which Linux processes those are, so without this a To Do
 * task dragged back into a running column while the startup sweep reaped it
 * would have its new WSL agent killed. The host reap still gets every task.
 *
 * It also pins that no `wsl.exe` call of that reap carries a task tag in its
 * environment, even when main holds one (Kangentic run from a task's terminal).
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
import { TASK_PROCESS_TAG_ENV } from '../../src/main/pty/process-tag/task-process-tag';

const LIVE_TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const STARTING_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const IDLE_TASK = '1c2d3e4f-5061-4728-9930-4b5c6d7e8f90';
/** Has no session when a reap starts, and gets one while its `wsl.exe` listings are in flight. */
const LATE_TASK = '2d3e4f50-6172-4839-8a41-5c6d7e8f9a01';
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
  // The same calls as `wslCalls`, whole, so a test can read the environment each one carried.
  const wslRequests: Array<Extract<HostExecRequest, { kind: 'execFile' }>> = [];
  // A test sets `onRunningListing` to act while the `wsl.exe -l --running -q` call is in flight.
  const hooks: { onRunningListing: (() => void) | null } = { onRunningListing: null };
  setOffMainExecutor(async (request: HostExecRequest): Promise<HostExecResult> => {
    if (request.kind !== 'execFile') throw new Error(`unexpected ${request.kind}`);
    wslCalls.push(request.args);
    wslRequests.push(request);
    if (request.args.includes('--running')) hooks.onRunningListing?.();
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
  return { manager, hostRequests, wslCalls, wslRequests, hooks, seedLiveSession, seedStartingSpawn, distroReapArgs };
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

  it('leaves out a task whose spawn registered while the running-distro listing was in flight, and still reaps the one that stayed idle', async () => {
    const { manager, hostRequests, hooks, seedStartingSpawn, distroReapArgs } = setup();
    let runningListings = 0;
    hooks.onRunningListing = () => {
      runningListings += 1;
      // Both tasks had no session when the reap started, so both passed the first check.
      seedStartingSpawn(LATE_TASK);
    };

    await manager.reapTaskProcesses(os.tmpdir(), [IDLE_TASK, LATE_TASK].map((id) => ({ id, worktreePath: null })), { stop: true });

    // Positive controls: the listing ran once and fired the hook, the host reap still got both tasks,
    // and the script did run, for the task that stayed idle.
    expect(runningListings).toBe(1);
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0].tasks.map((task) => task.taskId).sort()).toEqual([IDLE_TASK, LATE_TASK].sort());
    const reapArgs = distroReapArgs();
    expect(reapArgs).toBeDefined();
    // `-d Ubuntu -e sh -c <script> sh <task id> <count> <directories...>`
    const positional = reapArgs!.slice(6);
    expect(positional).toContain(IDLE_TASK);
    expect(positional).not.toContain(LATE_TASK);
  });
});

describe('the WSL reap log line for the tasks it left out', () => {
  const taskIds = [LIVE_TASK, STARTING_TASK, IDLE_TASK];

  function loggedLines(logSpy: { mock: { calls: unknown[][] } }): string[] {
    return logSpy.mock.calls.map((callArguments) => callArguments.map(String).join(' '));
  }

  it('reports how many tasks it left out in one line, and names none of them', async () => {
    const { manager, seedLiveSession, seedStartingSpawn, distroReapArgs } = setup();
    seedLiveSession(LIVE_TASK);
    seedStartingSpawn(STARTING_TASK);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await manager.reapTaskProcesses(os.tmpdir(), allTasks, { stop: true });

      // Positive control: the reap reached the script, so the count below is that path's own line.
      expect(distroReapArgs()).toBeDefined();
      const lines = loggedLines(logSpy);
      const leftOutLines = lines.filter((line) => line.includes('[TASK-REAP] WSL reap left out 2 task(s)'));
      expect(leftOutLines).toHaveLength(1);
      // A task id can name a project's work: the count is all that is logged.
      for (const line of lines) {
        for (const taskId of taskIds) expect(line).not.toContain(taskId);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('says nothing about left-out tasks when every task was reaped in the distro', async () => {
    const { manager, distroReapArgs } = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await manager.reapTaskProcesses(os.tmpdir(), allTasks, { stop: true });

      expect(distroReapArgs()).toBeDefined();
      expect(loggedLines(logSpy).filter((line) => line.includes('left out'))).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('the environment of the WSL reap\'s wsl.exe calls', () => {
  /** The task Kangentic itself is running inside, when it is started from that task's terminal. */
  const OUTER_TASK = '3e4f5061-7283-4948-9b52-6d7e8f9a0b12';
  const PROBE_VARIABLE = 'KANGENTIC_REAP_ENV_PROBE';

  /** Set a variable on `process.env` for the run, then put back what was there, even when the run throws. */
  async function withEnvironmentVariables(overrides: Record<string, string>, run: () => Promise<void>): Promise<void> {
    const priorValues = new Map(Object.keys(overrides).map((name): [string, string | undefined] => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
      await run();
    } finally {
      for (const [name, priorValue] of priorValues) {
        if (priorValue === undefined) delete process.env[name];
        else process.env[name] = priorValue;
      }
    }
  }

  it('never carries a task tag, though main holds one and the rest of main\'s environment is passed on', async () => {
    const { manager, wslRequests } = setup();

    await withEnvironmentVariables({ [TASK_PROCESS_TAG_ENV]: OUTER_TASK, [PROBE_VARIABLE]: 'present' }, async () => {
      await manager.reapTaskProcesses(os.tmpdir(), allTasks, { stop: true });
    });

    // The spec names its distro, so there is no `-l -v` listing: one running-distro listing, then the script.
    const runningListings = wslRequests.filter((request) => request.args.includes('--running'));
    const distroReaps = wslRequests.filter((request) => request.args[0] === '-d');
    expect(runningListings).toHaveLength(1);
    expect(distroReaps).toHaveLength(1);
    for (const request of [...runningListings, ...distroReaps]) {
      const environment = request.options.env;
      expect(request.file).toBe('wsl.exe');
      expect(environment).toBeDefined();
      // Positive controls: an environment did reach the call, `WSL_UTF8` from the reap and the probe from main's own,
      // so a tag missing from it is the reap's doing and not an empty environment.
      expect(environment!.WSL_UTF8).toBe('1');
      expect(environment![PROBE_VARIABLE]).toBe('present');
      expect(Object.keys(environment!).filter((name) => name.toUpperCase() === TASK_PROCESS_TAG_ENV)).toEqual([]);
    }
  });
});
