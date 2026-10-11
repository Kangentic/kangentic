/**
 * What a session's shell left running when it exited on its own
 * (src/main/pty/host/dead-root-orphans.ts), and how the pty host ends it
 * (pty-host-core.ts `endOrphansOf`).
 *
 * Windows never rewrites a parent pid, so the dead shell's children still name
 * it, but so can a process that inherited a REUSED pid. These pin that only a
 * child created inside the shell's lifetime counts, that a descendant counts
 * only when it was created after its own parent, and that a protected or
 * unreadable process is never touched or walked through.
 *
 * They also pin the order the measurements require (see the module comment):
 * the agent is asked to exit through the dead shell's console FIRST, so Claude
 * runs its SessionEnd hook and writes its exit records, and only what is still
 * alive after the grace is terminated. The host never looks after a kill it
 * was sent, during a quit, for a WSL root, on POSIX, or from the in-process core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as nodePty from 'node-pty';
import {
  DEAD_ROOT_ORPHAN_EXIT_GRACE_MS,
  DEAD_ROOT_ORPHAN_POLL_MS,
  endDeadRootOrphans,
  planDeadRootOrphans,
  type DeadRootOrphanApi,
  type DeadRootOrphanParams,
  type DeadRootOrphanSteps,
  type OrphanIdentity,
  type OrphanProcessRow,
} from '../../src/main/pty/host/dead-root-orphans';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { PtyHostSpawnParams } from '../../src/main/pty/host/protocol';

const ROOT_PID = 500;
const SPAWNED_AT = 10_000;
const EXITED_AT = 70_000;
const CLAUDE_EXIT_SEQUENCE = ['\x03', '/exit\r'];

interface FakeProcess extends OrphanProcessRow {
  /** Undefined: another user's or session's, or gone (identityOf answers null). */
  startedAtMs?: number;
}

function params(overrides: Partial<DeadRootOrphanParams> = {}): DeadRootOrphanParams {
  return { rootPid: ROOT_PID, spawnedAtMs: SPAWNED_AT, exitedAtMs: EXITED_AT, protectedPids: new Set(), ...overrides };
}

/** A process table whose members can exit, as a real agent does after `/exit`. */
class FakeProcessTable {
  private readonly alive = new Map<number, FakeProcess>();

  constructor(processes: readonly FakeProcess[]) {
    for (const process of processes) this.alive.set(process.pid, process);
  }

  /** A pid changing hands that `terminate` will see, armed per pid by `reusePidBeforeTerminate`. */
  private readonly reuseOnTerminate = new Map<number, FakeProcess>();

  exit(pid: number): void {
    this.alive.delete(pid);
  }

  /** Puts a process in the table, as the kernel does when it hands an exited process's pid to a new one. */
  start(process: FakeProcess): void {
    this.alive.set(process.pid, process);
  }

  /**
   * Arms the race a terminate can lose: the pid changes hands after the last
   * poll and before the terminate opens its handle. `endDeadRootOrphans` runs
   * from its last poll to its terminate loop with no await in between, so a
   * timer cannot land in that gap and the terminate call itself is the seam.
   */
  reusePidBeforeTerminate(replacement: FakeProcess): void {
    this.reuseOnTerminate.set(replacement.pid, replacement);
  }

  /** Every terminate call, in order, whether or not it ended a process. */
  readonly terminated: number[] = [];

  private identity(pid: number): OrphanIdentity | null {
    const process = this.alive.get(pid);
    if (!process || process.startedAtMs === undefined) return null;
    return { startKey: `key-${pid}-${process.startedAtMs}`, startedAtMs: process.startedAtMs };
  }

  readonly api: DeadRootOrphanApi = {
    listProcesses: async () => [...this.alive.values()],
    identityOf: (pid) => this.identity(pid),
    terminate: (target) => {
      this.terminated.push(target.pid);
      const replacement = this.reuseOnTerminate.get(target.pid);
      if (replacement) {
        this.reuseOnTerminate.delete(target.pid);
        this.alive.set(target.pid, replacement);
      }
      // The real terminate re-reads the creation time on the handle it opened
      // and refuses a process that is not the one that was planned.
      if (this.identity(target.pid)?.startKey !== target.startKey) return false;
      this.alive.delete(target.pid);
      return true;
    },
  };
}

function plan(processes: readonly FakeProcess[], overrides: Partial<DeadRootOrphanParams> = {}): number[] {
  const table = new FakeProcessTable(processes);
  return planDeadRootOrphans(processes, params(overrides), (pid) => table.api.identityOf(pid)).map((target) => target.pid);
}

describe('planDeadRootOrphans', () => {
  it('takes the shell\'s child created in its lifetime and everything under it, parents first', () => {
    const processes: FakeProcess[] = [
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: 12_000 },
      { pid: 610, ppid: 600, image: 'cmd.exe', startedAtMs: 13_000 },
      { pid: 620, ppid: 610, image: 'node.exe', startedAtMs: 13_500 },
      { pid: 630, ppid: 600, image: 'conhost.exe', startedAtMs: 13_100 },
      { pid: 900, ppid: 1, image: 'explorer.exe', startedAtMs: 1_000 },
    ];
    expect(plan(processes)).toEqual([600, 610, 630, 620]);
  });

  it('spares a child that names the shell\'s pid but was created outside the shell\'s lifetime (a reused pid)', () => {
    const processes: FakeProcess[] = [
      { pid: 601, ppid: ROOT_PID, image: 'old.exe', startedAtMs: SPAWNED_AT - 60_000 },
      { pid: 602, ppid: ROOT_PID, image: 'new.exe', startedAtMs: EXITED_AT + 1 },
      { pid: 603, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 500 },
    ];
    expect(plan(processes)).toEqual([603]);
  });

  it('allows for the clock reading taken just before the spawn call', () => {
    expect(plan([{ pid: 604, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT - 200 }])).toEqual([604]);
  });

  it('spares a descendant created before its own parent, whose parent pid was reused', () => {
    const processes: FakeProcess[] = [
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: 20_000 },
      { pid: 640, ppid: 600, image: 'unrelated.exe', startedAtMs: 15_000 },
      { pid: 650, ppid: 640, image: 'unrelated-child.exe', startedAtMs: 16_000 },
    ];
    expect(plan(processes)).toEqual([600]);
  });

  it('never touches or walks through a protected or unreadable process', () => {
    const processes: FakeProcess[] = [
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: 12_000 },
      { pid: 660, ppid: 600, image: 'held-pty-root.exe', startedAtMs: 12_500 },
      { pid: 661, ppid: 660, image: 'under-held.exe', startedAtMs: 12_600 },
      { pid: 670, ppid: 600, image: 'elevated.exe' },
      { pid: 671, ppid: 670, image: 'under-elevated.exe', startedAtMs: 13_000 },
    ];
    expect(plan(processes, { protectedPids: new Set([660]) })).toEqual([600]);
  });
});

describe('endDeadRootOrphans', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function steps(table: FakeProcessTable, onAsk: () => void, overrides: Partial<DeadRootOrphanSteps> = {}): DeadRootOrphanSteps & { asks: number } {
    const recorder = {
      asks: 0,
      askToExit: () => {
        recorder.asks += 1;
        onAsk();
        return true;
      },
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      isStopping: () => false,
      ...overrides,
    };
    return recorder;
  }

  const agentTree: FakeProcess[] = [
    { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: 12_000 },
    { pid: 610, ppid: 600, image: 'node.exe', startedAtMs: 13_000 },
  ];

  it('asks the agent to exit first and terminates nothing when it does, within the grace', async () => {
    const table = new FakeProcessTable(agentTree);
    // Measured: Claude exits about 600 ms after /exit, its MCP server with it.
    const recorder = steps(table, () => {
      setTimeout(() => {
        table.exit(600);
        table.exit(610);
      }, 600);
    });
    const done = endDeadRootOrphans(table.api, params(), recorder);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await done;

    expect(recorder.asks).toBe(1);
    expect(result).toMatchObject({ found: ['claude.exe', 'node.exe'], asked: true, exitedByThemselves: ['claude.exe', 'node.exe'], terminated: [] });
    expect(table.terminated).toEqual([]);
  });

  it('terminates, parents first, only what is still alive once the grace runs out', async () => {
    const table = new FakeProcessTable(agentTree);
    // The agent exits; a process it left under it does not.
    const recorder = steps(table, () => setTimeout(() => table.exit(600), 600));
    const done = endDeadRootOrphans(table.api, params(), recorder);

    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS - DEAD_ROOT_ORPHAN_POLL_MS);
    expect(table.terminated).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);
    const result = await done;

    expect(result.exitedByThemselves).toEqual(['claude.exe']);
    expect(result.terminated).toEqual(['node.exe']);
    expect(table.terminated).toEqual([610]);
  });

  it('counts a planned process whose pid was taken by an unrelated new process as exited, and never terminates the newcomer', async () => {
    const table = new FakeProcessTable(agentTree);
    // claude.exe exits during the grace and the kernel hands pid 600 to a process created later.
    // node.exe stays alive, so the terminate loop does run and is the positive control.
    const recorder = steps(table, () => setTimeout(() => {
      table.exit(600);
      table.start({ pid: 600, ppid: 1, image: 'unrelated.exe', startedAtMs: EXITED_AT + 5_000 });
    }, 600));
    const done = endDeadRootOrphans(table.api, params(), recorder);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + DEAD_ROOT_ORPHAN_POLL_MS * 2);
    const result = await done;

    expect(result.found).toEqual(['claude.exe', 'node.exe']);
    expect(result.exitedByThemselves).toEqual(['claude.exe']);
    expect(result.terminated).toEqual(['node.exe']);
    expect(result.notTerminated).toBe(0);
    // Terminate was never even called for the reused pid, and the newcomer is still running.
    expect(table.terminated).toEqual([610]);
    expect(table.api.identityOf(600)?.startedAtMs).toBe(EXITED_AT + 5_000);
  });

  it('counts a process whose pid changed hands just before its terminate as not terminated, and leaves the newcomer running', async () => {
    const table = new FakeProcessTable(agentTree);
    // Nothing exits, so both processes are still the planned ones at the last poll. Then pid 600 is
    // reused before the terminate can open it, so the creation time no longer matches and it is refused.
    table.reusePidBeforeTerminate({ pid: 600, ppid: 1, image: 'unrelated.exe', startedAtMs: EXITED_AT + 5_000 });
    const recorder = steps(table, () => undefined);
    const done = endDeadRootOrphans(table.api, params(), recorder);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + DEAD_ROOT_ORPHAN_POLL_MS * 2);
    const result = await done;

    expect(result.exitedByThemselves).toEqual([]);
    expect(result.terminated).toEqual(['node.exe']);
    expect(result.notTerminated).toBe(1);
    // Parents first: the refused terminate was attempted, then the one that took effect.
    expect(table.terminated).toEqual([600, 610]);
    expect(table.api.identityOf(600)?.startedAtMs).toBe(EXITED_AT + 5_000);
    expect(table.api.identityOf(610)).toBeNull();
  });

  it('still waits out the grace and terminates what is left when the exit sequence could not be written', async () => {
    const table = new FakeProcessTable(agentTree);
    // The console pipe is gone, so nothing is written and nothing exits because of the ask. claude.exe
    // ends on its own partway through the grace; node.exe never does.
    setTimeout(() => table.exit(600), 5_000);
    let askCalls = 0;
    const recorder = steps(table, () => undefined, {
      askToExit: () => {
        askCalls += 1;
        return false;
      },
    });
    const done = endDeadRootOrphans(table.api, params(), recorder);

    // A failed ask does not cut the grace short: node.exe is still alive, and untouched, one poll before it ends.
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS - DEAD_ROOT_ORPHAN_POLL_MS);
    expect(table.terminated).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);
    const result = await done;

    expect(askCalls).toBe(1);
    expect(result.asked).toBe(false);
    expect(result.found).toEqual(['claude.exe', 'node.exe']);
    expect(result.exitedByThemselves).toEqual(['claude.exe']);
    expect(result.terminated).toEqual(['node.exe']);
    expect(result.notTerminated).toBe(0);
    expect(table.terminated).toEqual([610]);
  });

  it('writes nothing and terminates nothing when the shell left nothing running', async () => {
    const table = new FakeProcessTable([{ pid: 900, ppid: 1, image: 'explorer.exe', startedAtMs: 1_000 }]);
    const recorder = steps(table, () => undefined);
    const result = await endDeadRootOrphans(table.api, params(), recorder);
    expect(recorder.asks).toBe(0);
    expect(result.found).toEqual([]);
    expect(table.terminated).toEqual([]);
  });

  it('stops waiting and terminates nothing once the host is quitting', async () => {
    const table = new FakeProcessTable(agentTree);
    let stopping = false;
    const recorder = steps(table, () => undefined, { isStopping: () => stopping });
    const done = endDeadRootOrphans(table.api, params(), recorder);
    await vi.advanceTimersByTimeAsync(1_000);
    stopping = true;
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS);
    const result = await done;
    expect(result.terminated).toEqual([]);
    expect(table.terminated).toEqual([]);
  });
});

interface FakePty {
  pty: nodePty.IPty;
  exit(exitCode: number): void;
  consoleInput: string[];
}

/** A ConPTY-shaped fake: after the exit, node-pty's agent still holds an open input pipe. */
function createFakePty(pid: number): FakePty {
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const consoleInput: string[] = [];
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    _agent: { inSocket: { writable: true, destroyed: false, write: (data: string) => { consoleInput.push(data); return true; } } },
  } as unknown as nodePty.IPty;
  return { pty, exit: (exitCode) => exitListener?.({ exitCode }), consoleInput };
}

function spawnParams(overrides: Partial<PtyHostSpawnParams> = {}): PtyHostSpawnParams {
  return {
    ptyId: 1,
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: 'claude',
    transient: true,
    file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: [],
    cwd: 'C:\\mock\\project',
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    exitSequence: CLAUDE_EXIT_SEQUENCE,
    ...overrides,
  };
}

function makeCore(options: { platform?: NodeJS.Platform; withOrphanApi?: boolean; table?: FakeProcessTable } = {}) {
  let clock = SPAWNED_AT;
  const fakes = new Map<number, FakePty>();
  let nextPid = ROOT_PID;
  const table = options.table ?? new FakeProcessTable([]);
  const loadOrphanApi = vi.fn(async () => table.api);
  const core = new PtyHostCore({
    emit: () => undefined,
    resolveAgent: () => undefined,
    transcriptSinkFor: () => null,
    coalesceMs: 0,
    spawnPty: (() => {
      const fake = createFakePty(nextPid);
      fakes.set(nextPid, fake);
      nextPid += 1;
      return fake.pty;
    }) as unknown as typeof nodePty.spawn,
    platform: options.platform ?? 'win32',
    now: () => clock,
    ...(options.withOrphanApi === false ? {} : { loadOrphanApi }),
  });
  return {
    core,
    table,
    fakeFor: (pid: number) => fakes.get(pid) as FakePty,
    setClock: (value: number) => { clock = value; },
    loadOrphanApi,
  };
}

describe('PtyHostCore: a shell that exits on its own', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the session\'s exit sequence into the dead shell\'s console, and the agent that exits is never terminated', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual(CLAUDE_EXIT_SEQUENCE);
    table.exit(600);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(table.terminated).toEqual([]);
  });

  it('terminates only the dead shell\'s own children still alive after the grace, never a live PTY root or a reused pid\'s child', async () => {
    const liveRootPid = ROOT_PID + 1;
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
      { pid: 610, ppid: 600, image: 'node.exe', startedAtMs: SPAWNED_AT + 3_000 },
      // Created after the exit the core observed: a reused pid's child.
      { pid: 620, ppid: ROOT_PID, image: 'later.exe', startedAtMs: EXITED_AT + 1_000 },
      // Created well before this shell was spawned: an earlier holder of the pid.
      { pid: 630, ppid: ROOT_PID, image: 'earlier.exe', startedAtMs: SPAWNED_AT - 5_000 },
      // A live PTY root that (implausibly) names the dead shell: still protected.
      { pid: liveRootPid, ppid: ROOT_PID, image: 'pwsh.exe', startedAtMs: SPAWNED_AT + 1_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams({ ptyId: 1, sessionId: 'dead' }));
    rig.core.spawn(spawnParams({ ptyId: 2, sessionId: 'alive' }));
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    // The window must close at the exit the core observed, not when it looks:
    // pid 620 was created after the exit but before this later clock.
    rig.setClock(EXITED_AT + 5_000);
    await vi.advanceTimersByTimeAsync(0);
    // The grace runs from when the cleanup started; move the clock past it.
    rig.setClock(EXITED_AT + 5_000 + DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + 1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);

    expect(table.terminated).toEqual([600, 610]);
  });

  it('does nothing after a kill it was sent: closing the console ended what it ran', async () => {
    const rig = makeCore();
    rig.core.spawn(spawnParams());
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(rig.loadOrphanApi).not.toHaveBeenCalled();
    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
  });

  it('does nothing during a quit', async () => {
    const rig = makeCore();
    rig.core.spawn(spawnParams());
    rig.core.handleCommand({ type: 'shutdown' });
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(rig.loadOrphanApi).not.toHaveBeenCalled();
  });

  it('does nothing for a WSL root, on POSIX, or from a core given no orphan API', async () => {
    const wsl = makeCore();
    wsl.core.spawn(spawnParams({ file: 'C:\\Windows\\System32\\wsl.exe' }));
    wsl.fakeFor(ROOT_PID).exit(1);

    const posix = makeCore({ platform: 'linux' });
    posix.core.spawn(spawnParams({ file: '/bin/bash' }));
    posix.fakeFor(ROOT_PID).exit(1);

    const inProcess = makeCore({ withOrphanApi: false });
    inProcess.core.spawn(spawnParams());
    inProcess.fakeFor(ROOT_PID).exit(1);

    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(wsl.loadOrphanApi).not.toHaveBeenCalled();
    expect(posix.loadOrphanApi).not.toHaveBeenCalled();
    expect(inProcess.loadOrphanApi).not.toHaveBeenCalled();
  });

  it('logs and never throws when the lookup fails', async () => {
    const rig = makeCore();
    rig.loadOrphanApi.mockRejectedValueOnce(new Error('koffi failed to load'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rig.core.spawn(spawnParams());
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not end what session'), 'koffi failed to load');
    warn.mockRestore();
  });
});
