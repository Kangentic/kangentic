/**
 * What a session's shell left running when it exited on its own
 * (src/main/pty/host/dead-root-orphans.ts), and how the pty host ends it
 * (pty-host-core.ts `endOrphansOf`).
 *
 * Windows never rewrites a parent pid, so the dead shell's children still name
 * it, but so can a process that inherited a REUSED pid. These pin that only a
 * child created inside the shell's lifetime counts, that a descendant counts
 * only when it was created after its own parent, and that a protected or
 * unreadable process is never touched or walked through. The lifetime is the
 * shell's own creation and exit times, read off the host's pin on it: a child
 * of an earlier or later owner of the pid falls outside it however close, and
 * without a pin the cleanup does not run.
 *
 * They also pin the order the measurements require (see the module comment):
 * the agent is asked to exit through the dead shell's console FIRST, so Claude
 * runs its SessionEnd hook and writes its exit records, and only what is still
 * alive after the grace is terminated. The host never looks after a kill it
 * was sent, during a quit, for a WSL root, on POSIX, or from the in-process core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
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
  type PinnedRoot,
} from '../../src/main/pty/host/dead-root-orphans';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import { ROOT_PID_POLL_MS } from '../../src/main/pty/host/root-pid-gate';
import type { PtyHostEvent, PtyHostRawSpawnParams, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';

const ROOT_PID = 500;
/** The wall clock the core reads before the spawn. */
const SPAWNED_AT = 10_000;
/** The shell's own creation time, a little after that reading (measured 28 to 127 ms). */
const ROOT_CREATED_AT = SPAWNED_AT + 30;
const EXITED_AT = 70_000;
const CLAUDE_EXIT_SEQUENCE = ['\x03', '/exit\r'];

interface FakeProcess extends OrphanProcessRow {
  /** Undefined: another user's or session's, or gone (identityOf answers null). */
  startedAtMs?: number;
}

function params(overrides: Partial<DeadRootOrphanParams> = {}): DeadRootOrphanParams {
  return { rootPid: ROOT_PID, rootStartedAtMs: ROOT_CREATED_AT, rootExitedAtMs: EXITED_AT, protectedPids: new Set(), ...overrides };
}

/** One `pinRoot` call that returned a pin. */
interface PinRecord {
  pid: number;
  notBeforeMs: number;
  released: boolean;
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

  /**
   * What `pinRoot` reads off a PTY root: its creation time, and its exit time
   * once it has exited. A root with no entry is not this process's child, so
   * it is not pinned.
   */
  readonly rootTimes = new Map<number, { startedAtMs: number; exitedAtMs: number | null }>();

  /** Every pin taken, and whether it was released. */
  readonly pins: PinRecord[] = [];

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
    pinRoot: (pid, notBeforeMs) => {
      const times = this.rootTimes.get(pid);
      if (!times || times.startedAtMs < notBeforeMs) return null;
      const record: PinRecord = { pid, notBeforeMs, released: false };
      this.pins.push(record);
      return {
        startedAtMs: times.startedAtMs,
        readExitedAtMs: () => (record.released ? null : this.rootTimes.get(pid)?.exitedAtMs ?? null),
        release: () => { record.released = true; },
      };
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

  it('spares a child created a moment before the shell itself, since an earlier owner of the pid started it', () => {
    // A clock read before the spawn, less a second of slack, used to admit both.
    const processes: FakeProcess[] = [
      { pid: 604, ppid: ROOT_PID, image: 'earlier-owner-child.exe', startedAtMs: ROOT_CREATED_AT - 500 },
      { pid: 605, ppid: ROOT_PID, image: 'earlier-owner-child.exe', startedAtMs: ROOT_CREATED_AT - 1 },
      { pid: 606, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: ROOT_CREATED_AT },
    ];
    expect(plan(processes)).toEqual([606]);
  });

  it('spares a child created after the shell\'s exit, however soon, since a later owner of the pid started it', () => {
    const processes: FakeProcess[] = [
      { pid: 607, ppid: ROOT_PID, image: 'later-owner-child.exe', startedAtMs: EXITED_AT + 1 },
      { pid: 608, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: EXITED_AT },
    ];
    expect(plan(processes)).toEqual([608]);
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

/**
 * A ConPTY-shaped fake: after the exit, node-pty's agent still holds an open
 * input pipe. `beforeExit` runs just before the exit is reported, where the
 * real shell's exit time is set.
 */
function createFakePty(pid: number, beforeExit: () => void = () => undefined): FakePty {
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
  return {
    pty,
    exit: (exitCode) => {
      beforeExit();
      exitListener?.({ exitCode });
    },
    consoleInput,
  };
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

function rawSpawnParams(overrides: Partial<PtyHostRawSpawnParams> = {}): PtyHostRawSpawnParams {
  return { ptyId: 7, file: 'C:\\mock\\claude.exe', args: [], cwd: 'C:\\mock\\project', env: {}, cols: 80, rows: 24, name: 'xterm-256color', ...overrides };
}

/**
 * A core over fake PTYs. Each fake shell is this process's child, created
 * 30 ms after the core's clock reading and exiting at the clock when its exit
 * is reported, unless a test set its times in `table.rootTimes` first.
 *
 * `orphanApiLoadError` fails every load of the orphan API. `orphanApiLoadFailures`
 * fails that many loads and then lets one succeed. The core's own load at
 * construction (Windows) is the first of them.
 */
function makeCore(options: {
  platform?: NodeJS.Platform;
  withOrphanApi?: boolean;
  table?: FakeProcessTable;
  latePid?: boolean;
  orphanApiLoadError?: Error;
  orphanApiLoadFailures?: number;
} = {}) {
  let clock = SPAWNED_AT;
  const fakes = new Map<number, FakePty>();
  let nextPid = ROOT_PID;
  const table = options.table ?? new FakeProcessTable([]);
  const events: PtyHostEvent[] = [];
  let loadFailuresLeft = options.orphanApiLoadFailures ?? 0;
  const loadOrphanApi = vi.fn(async () => {
    if (options.orphanApiLoadError) throw options.orphanApiLoadError;
    if (loadFailuresLeft > 0) {
      loadFailuresLeft -= 1;
      throw new Error('koffi failed to load');
    }
    return table.api;
  });
  const core = new PtyHostCore({
    emit: (event) => { events.push(event); },
    resolveAgent: () => undefined,
    transcriptSinkFor: () => null,
    coalesceMs: 0,
    spawnPty: (() => {
      const pid = nextPid;
      if (!table.rootTimes.has(pid)) table.rootTimes.set(pid, { startedAtMs: clock + 30, exitedAtMs: null });
      // `latePid`: ConPTY on node-pty 1.2 reads 0 until the process is connected.
      const fake = createFakePty(options.latePid ? 0 : pid, () => {
        const times = table.rootTimes.get(pid);
        if (times && times.exitedAtMs === null) times.exitedAtMs = clock;
      });
      fakes.set(pid, fake);
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
    events,
  };
}

/** The core's table of session PTYs, which no public read shows once a PTY has exited. */
function sessionPtyTable(core: PtyHostCore): Map<number, unknown> {
  return (core as unknown as { ptys: Map<number, unknown> }).ptys;
}

describe('PtyHostCore: a shell that exits on its own', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Spawn, and let the orphan API's load and the pin land, as they do long before a real shell exits. */
  async function spawnPinned(rig: ReturnType<typeof makeCore>, overrides: Partial<PtyHostSpawnParams> = {}): Promise<void> {
    rig.core.spawn(spawnParams(overrides));
    await vi.advanceTimersByTimeAsync(0);
  }

  it('writes the session\'s exit sequence into the dead shell\'s console, and the agent that exits is never terminated', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    await spawnPinned(rig);
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual(CLAUDE_EXIT_SEQUENCE);
    table.exit(600);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(table.terminated).toEqual([]);
  });

  it('releases the exited PTY only once the cleanup is done writing to its console', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    await spawnPinned(rig);
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual(CLAUDE_EXIT_SEQUENCE);
    expect(rig.fakeFor(ROOT_PID).pty.kill).not.toHaveBeenCalled();
    table.exit(600);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
  });

  it('asks with the pid node-pty set after spawn() returned, not the 0 it read at the spawn', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table, latePid: true });
    const answer = Promise.resolve(rig.core.handleRequest('spawn', spawnParams()));
    (rig.fakeFor(ROOT_PID).pty as { pid: number }).pid = ROOT_PID;
    await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);
    await expect(answer).resolves.toEqual({ ok: true, pid: ROOT_PID });

    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(rig.loadOrphanApi).toHaveBeenCalledTimes(1);
    expect(table.pins.map((pin) => pin.pid)).toEqual([ROOT_PID]);
    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual(CLAUDE_EXIT_SEQUENCE);
  });

  it('terminates only the dead shell\'s own children still alive after the grace, never a live PTY root or a reused pid\'s child', async () => {
    const liveRootPid = ROOT_PID + 1;
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
      { pid: 610, ppid: 600, image: 'node.exe', startedAtMs: SPAWNED_AT + 3_000 },
      // Created after the shell's exit: a reused pid's child.
      { pid: 620, ppid: ROOT_PID, image: 'later.exe', startedAtMs: EXITED_AT + 1_000 },
      // Created well before this shell was spawned: an earlier holder of the pid.
      { pid: 630, ppid: ROOT_PID, image: 'earlier.exe', startedAtMs: SPAWNED_AT - 5_000 },
      // A live PTY root that (implausibly) names the dead shell: still protected.
      { pid: liveRootPid, ppid: ROOT_PID, image: 'pwsh.exe', startedAtMs: SPAWNED_AT + 1_000 },
    ]);
    const rig = makeCore({ table });
    await spawnPinned(rig, { ptyId: 1, sessionId: 'dead' });
    await spawnPinned(rig, { ptyId: 2, sessionId: 'alive' });
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    // The window closes at the shell's own exit, not when the cleanup looks.
    rig.setClock(EXITED_AT + 5_000);
    await vi.advanceTimersByTimeAsync(0);
    // The grace runs from when the cleanup started; move the clock past it.
    rig.setClock(EXITED_AT + 5_000 + DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + 1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);

    expect(table.terminated).toEqual([600, 610]);
  });

  it('closes the window at the shell\'s real exit, read off its pin, and not at the later moment the exit was handled', async () => {
    // node-pty reports an exit after the shell is gone (about a second on
    // ConPTY). A newcomer that took the pid in that gap, and the child it
    // started, were created before the exit was handled and after the shell's.
    const realExitAt = EXITED_AT - 2_000;
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
      { pid: 640, ppid: ROOT_PID, image: 'newcomer-child.exe', startedAtMs: realExitAt + 500 },
    ]);
    table.rootTimes.set(ROOT_PID, { startedAtMs: ROOT_CREATED_AT, exitedAtMs: realExitAt });
    const rig = makeCore({ table });
    await spawnPinned(rig);
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);
    rig.setClock(EXITED_AT + DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + 1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);

    expect(table.terminated).toEqual([600]);
  });

  it('pins the root once its pid is known and closes the pin as its exit is handled, for an exit on its own, a kill and a quit alike', async () => {
    const naturalExit = makeCore();
    await spawnPinned(naturalExit);
    expect(naturalExit.table.pins).toEqual([{ pid: ROOT_PID, notBeforeMs: SPAWNED_AT - 1000, released: false }]);
    naturalExit.fakeFor(ROOT_PID).exit(1);
    expect(naturalExit.table.pins[0].released).toBe(true);

    const killed = makeCore();
    await spawnPinned(killed);
    killed.core.handleCommand({ type: 'kill', ptyId: 1 });
    expect(killed.table.pins[0].released).toBe(false);
    killed.fakeFor(ROOT_PID).exit(1);
    expect(killed.table.pins[0].released).toBe(true);

    const quit = makeCore();
    await spawnPinned(quit);
    quit.core.handleCommand({ type: 'shutdown' });
    quit.fakeFor(ROOT_PID).exit(1);
    expect(quit.table.pins[0].released).toBe(true);
  });

  it('pins a raw probe PTY the same way, since node-pty\'s kill reaches for its pid too', async () => {
    const rig = makeCore();
    rig.core.spawnRaw(rawSpawnParams());
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.table.pins.map((pin) => [pin.pid, pin.released])).toEqual([[ROOT_PID, false]]);
    rig.fakeFor(ROOT_PID).exit(0);
    expect(rig.table.pins[0].released).toBe(true);
  });

  it('pins a raw PTY whose pid node-pty sets after spawnRaw() returned, once its answer has the pid, and closes the pin at its exit', async () => {
    const rig = makeCore({ latePid: true });
    const answer = Promise.resolve(rig.core.spawnRaw(rawSpawnParams()));
    // The pid still reads 0: there is nothing to pin yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.table.pins).toEqual([]);

    (rig.fakeFor(ROOT_PID).pty as { pid: number }).pid = ROOT_PID;
    await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);
    await expect(answer).resolves.toEqual({ ok: true, pid: ROOT_PID });
    expect(rig.table.pins.map((pin) => [pin.pid, pin.released])).toEqual([[ROOT_PID, false]]);

    rig.fakeFor(ROOT_PID).exit(0);
    // The gate holds the PTY's events until its release, on the next macrotask.
    await vi.advanceTimersByTimeAsync(1);
    expect(rig.table.pins.map((pin) => [pin.pid, pin.released])).toEqual([[ROOT_PID, true]]);
  });

  it('takes no pin for a raw PTY that exits before the orphan API\'s load lands, since a pin of a dead root would never be closed', async () => {
    const rig = makeCore();
    rig.core.spawnRaw(rawSpawnParams());
    // The exit comes in the spawn's own turn, ahead of the load's continuation.
    rig.fakeFor(ROOT_PID).exit(0);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

    expect(rig.table.pins).toEqual([]);
    // The exit was handled as any other: the PTY is released once.
    expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
  });

  it('pins nothing it did not start, so a root the API refuses gets no pin, and its exit leaves what it ran alone and releases the PTY once', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    // Created before the spawn clock's slack allows: not this host's child.
    table.rootTimes.set(ROOT_PID, { startedAtMs: SPAWNED_AT - 5_000, exitedAtMs: null });
    const rig = makeCore({ table });
    const listProcesses = vi.spyOn(table.api, 'listProcesses');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await spawnPinned(rig);
      expect(table.pins).toEqual([]);

      rig.setClock(EXITED_AT);
      rig.fakeFor(ROOT_PID).exit(1);
      await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

      // Without a pin there is no lifetime, so the agent the shell ran is neither asked nor listed nor terminated.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('its lifetime could not be read'));
      expect(listProcesses).not.toHaveBeenCalled();
      expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
      expect(table.terminated).toEqual([]);
      expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves what the shell ran alone, and says so, when it holds no pin, since a guessed lifetime could take another owner\'s process', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    const listProcesses = vi.spyOn(table.api, 'listProcesses');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Exits before the API's load lands, so it was never pinned.
      rig.core.spawn(spawnParams());
      rig.setClock(EXITED_AT);
      rig.fakeFor(ROOT_PID).exit(1);
      await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('its lifetime could not be read'));
      expect(listProcesses).not.toHaveBeenCalled();
      expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
      expect(table.terminated).toEqual([]);
      // The exit releases the PTY itself, once.
      expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
      // The load landed after the exit and took no pin of the dead root, which nothing would ever close.
      expect(table.pins).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('does nothing after a kill it was sent: closing the console ended what it ran', async () => {
    const rig = makeCore();
    const listProcesses = vi.spyOn(rig.table.api, 'listProcesses');
    await spawnPinned(rig);
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(listProcesses).not.toHaveBeenCalled();
    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
  });

  it('does nothing during a quit', async () => {
    const rig = makeCore();
    const listProcesses = vi.spyOn(rig.table.api, 'listProcesses');
    await spawnPinned(rig);
    rig.core.handleCommand({ type: 'shutdown' });
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    expect(listProcesses).not.toHaveBeenCalled();
    expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
  });

  it('does nothing for a WSL root, on POSIX, or from a core given no orphan API', async () => {
    const wsl = makeCore();
    const wslListing = vi.spyOn(wsl.table.api, 'listProcesses');
    await spawnPinned(wsl, { file: 'C:\\Windows\\System32\\wsl.exe' });
    wsl.fakeFor(ROOT_PID).exit(1);

    const posix = makeCore({ platform: 'linux' });
    await spawnPinned(posix, { file: '/bin/bash' });
    posix.fakeFor(ROOT_PID).exit(1);

    const inProcess = makeCore({ withOrphanApi: false });
    await spawnPinned(inProcess);
    inProcess.fakeFor(ROOT_PID).exit(1);

    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
    // A WSL root is still pinned, for node-pty's kill; it is never looked under.
    expect(wsl.table.pins).toHaveLength(1);
    expect(wslListing).not.toHaveBeenCalled();
    expect(wsl.fakeFor(ROOT_PID).consoleInput).toEqual([]);
    expect(posix.loadOrphanApi).not.toHaveBeenCalled();
    expect(inProcess.loadOrphanApi).not.toHaveBeenCalled();
  });

  it('logs and never throws when the orphan API cannot load, pins nothing, and releases the exited PTY once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The core loads the API ahead, at construction, and tries again at the pin.
      const failing = makeCore({ orphanApiLoadError: new Error('koffi failed to load') });
      await spawnPinned(failing);
      failing.fakeFor(ROOT_PID).exit(1);
      await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

      expect(warn).toHaveBeenCalledWith('[pty-host] could not load the Windows process API:', 'koffi failed to load');
      expect(failing.table.pins).toEqual([]);
      expect(failing.fakeFor(ROOT_PID).consoleInput).toEqual([]);
      expect(failing.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('loads the orphan API again on the next use after a load failed, and pins the root of the spawn that finds it loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The load at construction is the first, and it fails. The first spawn shares it.
      const rig = makeCore({ orphanApiLoadFailures: 1 });
      await spawnPinned(rig, { ptyId: 1, sessionId: 'first' });
      expect(rig.loadOrphanApi).toHaveBeenCalledTimes(1);
      expect(rig.table.pins).toEqual([]);

      // The next use starts a second load, which succeeds, and the root is pinned as it lands.
      await spawnPinned(rig, { ptyId: 2, sessionId: 'second' });
      expect(rig.loadOrphanApi).toHaveBeenCalledTimes(2);
      expect(rig.table.pins.map((pin) => pin.pid)).toEqual([ROOT_PID + 1]);

      // Loaded now and kept: a third spawn is pinned at once, with no third load.
      await spawnPinned(rig, { ptyId: 3, sessionId: 'third' });
      expect(rig.loadOrphanApi).toHaveBeenCalledTimes(2);
      expect(rig.table.pins.map((pin) => pin.pid)).toEqual([ROOT_PID + 1, ROOT_PID + 2]);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a failed orphan API load once, however many loads fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loadFailureLogs = () => warn.mock.calls.filter((call) => call[0] === '[pty-host] could not load the Windows process API:');
    try {
      const rig = makeCore({ orphanApiLoadFailures: 3 });
      await spawnPinned(rig, { ptyId: 1, sessionId: 'first' });
      await spawnPinned(rig, { ptyId: 2, sessionId: 'second' });
      await spawnPinned(rig, { ptyId: 3, sessionId: 'third' });

      // Control: all three loads ran and failed, so one line is the log-once guard's doing, not a single failure.
      expect(rig.loadOrphanApi).toHaveBeenCalledTimes(3);
      expect(rig.table.pins).toEqual([]);
      expect(loadFailureLogs()).toEqual([['[pty-host] could not load the Windows process API:', 'koffi failed to load']]);

      // The fourth load succeeds, pins its spawn's root, and logs nothing more.
      await spawnPinned(rig, { ptyId: 4, sessionId: 'fourth' });
      expect(rig.loadOrphanApi).toHaveBeenCalledTimes(4);
      expect(rig.table.pins.map((pin) => pin.pid)).toEqual([ROOT_PID + 3]);
      expect(loadFailureLogs()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  describe('when the pin of a shell that exits misbehaves, the exit still reaches main', () => {
    const agentChild: FakeProcess = { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 };

    /** Makes the API hand out this pin for the root it is asked to pin. */
    function handOutPin(table: FakeProcessTable, pin: PinnedRoot): void {
      vi.spyOn(table.api, 'pinRoot').mockReturnValue(pin);
    }

    it('when the pin\'s exit time cannot be read, the PTY still leaves the table, the pin is closed, and no cleanup runs', async () => {
      const table = new FakeProcessTable([agentChild]);
      const rig = makeCore({ table });
      const listProcesses = vi.spyOn(table.api, 'listProcesses');
      const release = vi.fn();
      handOutPin(table, {
        startedAtMs: ROOT_CREATED_AT,
        readExitedAtMs: () => { throw new Error('handle gone'); },
        release,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await spawnPinned(rig);
        // Control: the PTY is in the table until its exit, so its absence below is the exit's doing.
        expect(sessionPtyTable(rig.core).has(1)).toBe(true);

        rig.setClock(EXITED_AT);
        expect(() => rig.fakeFor(ROOT_PID).exit(1)).not.toThrow();

        expect(rig.events.filter((event) => event.type === 'exit')).toEqual([{ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 1 }]);
        expect(sessionPtyTable(rig.core).has(1)).toBe(false);
        expect(warn).toHaveBeenCalledWith('[pty-host] could not read a PTY root\'s exit time:', 'handle gone');
        expect(release).toHaveBeenCalledTimes(1);

        // No exit time, so no lifetime, so the agent is left alone and the exit releases the PTY itself.
        await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
        expect(listProcesses).not.toHaveBeenCalled();
        expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual([]);
        expect(table.terminated).toEqual([]);
        expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('when closing the pin throws, the PTY still leaves the table and the exit time already read drives the cleanup', async () => {
      const table = new FakeProcessTable([agentChild]);
      const rig = makeCore({ table });
      const release = vi.fn(() => { throw new Error('close failed'); });
      handOutPin(table, { startedAtMs: ROOT_CREATED_AT, readExitedAtMs: () => EXITED_AT, release });
      await spawnPinned(rig);
      expect(sessionPtyTable(rig.core).has(1)).toBe(true);

      rig.setClock(EXITED_AT);
      expect(() => rig.fakeFor(ROOT_PID).exit(1)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(rig.events.filter((event) => event.type === 'exit')).toEqual([{ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 1 }]);
      expect(sessionPtyTable(rig.core).has(1)).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      // The read survived the failed close, so the cleanup asked the agent to exit, as it does for a pin that closes cleanly.
      expect(rig.fakeFor(ROOT_PID).consoleInput).toEqual(CLAUDE_EXIT_SEQUENCE);
      table.exit(600);
      await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);
      expect(table.terminated).toEqual([]);
      expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
    });
  });

  it('still releases the exited PTY, once, when the process listing fails after the API loaded', async () => {
    const rig = makeCore();
    vi.spyOn(rig.table.api, 'listProcesses').mockRejectedValueOnce(new Error('snapshot failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await spawnPinned(rig);
      const kill = rig.fakeFor(ROOT_PID).pty.kill;
      rig.fakeFor(ROOT_PID).exit(1);
      // The cleanup owns the release, so the exit itself does not release.
      expect(kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not end what session'), 'snapshot failed');
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('releases a WSL root that exited on its own, once, without looking for orphans', async () => {
    // A WSL root's children are Linux processes Win32 cannot see, so there is
    // nothing to clean up. Its conout worker still has to be freed.
    const rig = makeCore();
    const listProcesses = vi.spyOn(rig.table.api, 'listProcesses');
    await spawnPinned(rig, { file: 'C:\\Windows\\System32\\wsl.exe' });
    rig.fakeFor(ROOT_PID).exit(1);

    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

    expect(listProcesses).not.toHaveBeenCalled();
    expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
  });

  it('releases a PTY that exits on its own after the shutdown command, once, without looking for orphans', async () => {
    // The PTY already exited, so the release ends nothing and cuts no exit grace short.
    const rig = makeCore();
    const listProcesses = vi.spyOn(rig.table.api, 'listProcesses');
    await spawnPinned(rig);
    rig.core.handleCommand({ type: 'shutdown' });
    rig.fakeFor(ROOT_PID).exit(1);

    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS * 2);

    expect(listProcesses).not.toHaveBeenCalled();
    expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
  });
});

/**
 * A CLI run's Windows stop is `taskkill /PID <run> /T /F`, which opens the pid
 * about 550 ms after it starts. The core pins the run's pid through the orphan
 * API until taskkill exits (`pinRun`), so a run that exits by itself in that
 * window cannot hand its pid to a stranger first (src/main/shared/child-tree-stop.ts).
 */
describe('PtyHostCore: a CLI run\'s Windows stop pins the run\'s pid', () => {
  const originalPlatform = process.platform;
  const RUN_PID = 4321;

  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }));
  afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }));

  function cliRig(options: { withOrphanApi: boolean }) {
    const table = new FakeProcessTable([]);
    table.rootTimes.set(RUN_PID, { startedAtMs: SPAWNED_AT + 100, exitedAtMs: null });
    const order: string[] = [];
    const taskkillListeners: Array<{ event: string; listener: () => void }> = [];
    const taskkillHandle = {
      on: (event: string, listener: () => void) => {
        taskkillListeners.push({ event, listener });
        return taskkillHandle;
      },
      unref: () => taskkillHandle,
    };
    const run = Object.assign(new EventEmitter(), {
      pid: RUN_PID,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      kill: vi.fn(),
    });
    const spawnChild = ((command: string, args: readonly string[]) => {
      if (command !== 'taskkill') return run;
      order.push(`taskkill ${args.join(' ')}`);
      return taskkillHandle;
    }) as unknown as ConstructorParameters<typeof PtyHostCore>[0]['spawnChild'];
    const core = new PtyHostCore({
      emit: () => undefined,
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnChild,
      platform: 'win32',
      now: () => SPAWNED_AT,
      ...(options.withOrphanApi ? { loadOrphanApi: async () => table.api } : {}),
    });
    const startAndStop = async (): Promise<void> => {
      // The orphan API the core loaded at construction has landed, as it has long before any stop.
      await new Promise((resolve) => setImmediate(resolve));
      core.handleCommand({
        type: 'cliSpawn',
        params: { processId: 1, command: 'C:\\mock\\claude.exe', args: [], cwd: 'C:\\mock\\project', shell: false, env: {}, detached: false },
      });
      core.handleCommand({ type: 'cliStop', processId: 1 });
    };
    const taskkillExits = (): void => {
      for (const entry of taskkillListeners) if (entry.event === 'exit') entry.listener();
    };
    return { table, order, startAndStop, taskkillExits };
  }

  it('pins the run before taskkill starts and releases the pin once taskkill exits', async () => {
    const rig = cliRig({ withOrphanApi: true });
    await rig.startAndStop();
    expect(rig.table.pins.map((pin) => [pin.pid, pin.released])).toEqual([[RUN_PID, false]]);
    expect(rig.order).toEqual([`taskkill /pid ${RUN_PID} /T /F`]);
    rig.taskkillExits();
    expect(rig.table.pins[0].released).toBe(true);
  });

  it('logs and still stops the run, unpinned, when the API cannot pin it', async () => {
    const rig = cliRig({ withOrphanApi: true });
    const pinRoot = vi.spyOn(rig.table.api, 'pinRoot').mockImplementation(() => {
      throw new Error('OpenProcess failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await rig.startAndStop();

      expect(pinRoot).toHaveBeenCalledWith(RUN_PID, 0);
      expect(warn).toHaveBeenCalledWith('[pty-host] could not pin a CLI run:', 'OpenProcess failed');
      expect(rig.order).toEqual([`taskkill /pid ${RUN_PID} /T /F`]);
      // There is no pin to close when taskkill exits.
      expect(() => rig.taskkillExits()).not.toThrow();
      expect(rig.table.pins).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('still stops the run, unpinned, in a core given no orphan API', async () => {
    const rig = cliRig({ withOrphanApi: false });
    await rig.startAndStop();
    expect(rig.table.pins).toEqual([]);
    expect(rig.order).toEqual([`taskkill /pid ${RUN_PID} /T /F`]);
  });
});
