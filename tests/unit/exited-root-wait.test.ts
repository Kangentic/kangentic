/**
 * The wait a task reap makes for what the task's exited shells left running
 * (src/main/pty/host/exited-root-wait.ts and PtyHostCore.awaitAgentExit).
 *
 * A PTY's exit is its shell's. After a kill the agent the shell started is
 * often still exiting on its own (SessionEnd hooks, transcript, boot record),
 * and the reap would terminate it as a tagged leftover. These pin that the
 * wait finds the dead shell's agent (its children, through a launcher such as
 * cmd.exe, and nothing the agent itself started) by the orphan cleanup's
 * identity rules (Windows) or by the pids listed just before the kill (POSIX),
 * ends as soon as it is gone, never outlasts its bound, waits out an orphan
 * cleanup still asking a natural exit's agent to leave, and never runs in the
 * in-process core, during a quit, or for a PTY with no task.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as nodePty from 'node-pty';
import {
  DEAD_ROOT_ORPHAN_EXIT_GRACE_MS,
  DEAD_ROOT_ORPHAN_POLL_MS,
  type DeadRootOrphanApi,
  type OrphanIdentity,
  type OrphanProcessRow,
} from '../../src/main/pty/host/dead-root-orphans';
import {
  AGENT_EXIT_WAIT_MS,
  EXITED_ROOT_LEDGER_MS,
  KILL_SNAPSHOT_CAP_MS,
  agentDescendantsOf,
  pruneExitedRoots,
  waitForExitedRootTrees,
  type ExitedRoot,
} from '../../src/main/pty/host/exited-root-wait';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { PtyHostSpawnParams } from '../../src/main/pty/host/protocol';

const ROOT_PID = 500;
const SPAWNED_AT = 10_000;
const EXITED_AT = 70_000;
const TASK = 'task-a';

interface FakeProcess extends OrphanProcessRow {
  startedAtMs: number;
}

class FakeProcessTable {
  private readonly alive = new Map<number, FakeProcess>();
  listCalls = 0;

  constructor(processes: readonly FakeProcess[]) {
    for (const fakeProcess of processes) this.alive.set(fakeProcess.pid, fakeProcess);
  }

  exit(pid: number): void {
    this.alive.delete(pid);
  }

  readonly api: DeadRootOrphanApi = {
    listProcesses: async () => {
      this.listCalls += 1;
      return [...this.alive.values()];
    },
    identityOf: (pid): OrphanIdentity | null => {
      const fakeProcess = this.alive.get(pid);
      return fakeProcess ? { startKey: `key-${pid}-${fakeProcess.startedAtMs}`, startedAtMs: fakeProcess.startedAtMs } : null;
    },
    // Only the orphan cleanup terminates; the agent-exit wait never does.
    terminate: (target) => {
      this.terminated.push(target.pid);
      this.alive.delete(target.pid);
      return true;
    },
  };

  readonly terminated: number[] = [];
}

function killedRoot(overrides: Partial<ExitedRoot> = {}): ExitedRoot {
  return { taskId: TASK, rootPid: ROOT_PID, spawnedAtMs: SPAWNED_AT, exitedAtMs: EXITED_AT, orphanCleanup: null, descendants: null, ...overrides };
}

function fakeSteps(alivePids: Set<number> = new Set()) {
  let clock = EXITED_AT;
  let stopping = false;
  return {
    steps: {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(() => { clock += ms; resolve(); }, ms)),
      now: () => clock,
      isStopping: () => stopping,
      isAlive: (pid: number) => alivePids.has(pid),
    },
    stop: () => { stopping = true; },
  };
}

describe('waitForExitedRootTrees', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends as soon as the agent has exited, whatever the agent left running', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
      // A dev server the agent started: it never exits by itself, and the reap ends it.
      { pid: 610, ppid: 600, image: 'node.exe', startedAtMs: SPAWNED_AT + 3_000 },
    ]);
    const { steps } = fakeSteps();
    const done = waitForExitedRootTrees(table.api, [killedRoot()], new Set(), steps);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    table.exit(600);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.found).toEqual(['claude.exe']);
    expect(result.stillRunning).toEqual([]);
    expect(result.waitedMs).toBeLessThan(AGENT_EXIT_WAIT_MS);
  });

  it('looks through a launcher that exits first, to the agent behind it', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'cmd.exe', startedAtMs: SPAWNED_AT + 2_000 },
      { pid: 601, ppid: 600, image: 'node.exe', startedAtMs: SPAWNED_AT + 2_100 },
    ]);
    const { steps } = fakeSteps();
    let settled = false;
    const done = waitForExitedRootTrees(table.api, [killedRoot()], new Set(), steps).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Listed while cmd.exe ran; then it goes first, and node.exe, the agent, is still exiting.
    table.exit(600);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS * 2);
    expect(settled).toBe(false);
    table.exit(601);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.found).toEqual(['cmd.exe', 'node.exe']);
    expect(result.stillRunning).toEqual([]);
  });

  it('gives up at the bound and leaves what is still running to the reap', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const { steps } = fakeSteps();
    const done = waitForExitedRootTrees(table.api, [killedRoot()], new Set(), steps);
    await vi.advanceTimersByTimeAsync(AGENT_EXIT_WAIT_MS + DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.stillRunning).toEqual(['claude.exe']);
    expect(result.waitedMs).toBeGreaterThanOrEqual(AGENT_EXIT_WAIT_MS);
    expect(result.waitedMs).toBeLessThan(AGENT_EXIT_WAIT_MS + 2 * DEAD_ROOT_ORPHAN_POLL_MS);
  });

  it('waits for nothing a reused pid, an earlier pid holder, or a protected process names', async () => {
    const table = new FakeProcessTable([
      { pid: 620, ppid: ROOT_PID, image: 'later.exe', startedAtMs: EXITED_AT + 1_000 },
      { pid: 630, ppid: ROOT_PID, image: 'earlier.exe', startedAtMs: SPAWNED_AT - 5_000 },
      { pid: 640, ppid: ROOT_PID, image: 'pwsh.exe', startedAtMs: SPAWNED_AT + 1_000 },
    ]);
    const { steps } = fakeSteps();
    const result = await waitForExitedRootTrees(table.api, [killedRoot()], new Set([640]), steps);
    expect(result).toEqual({ found: [], stillRunning: [], waitedMs: 0 });
  });

  it('waits out an orphan cleanup still asking a natural exit\'s agent to leave, without listing for it', async () => {
    const table = new FakeProcessTable([]);
    let finishCleanup: () => void = () => undefined;
    const orphanCleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const { steps } = fakeSteps();
    let settled = false;
    const done = waitForExitedRootTrees(table.api, [killedRoot({ orphanCleanup })], new Set(), steps).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(AGENT_EXIT_WAIT_MS * 2);
    expect(settled).toBe(false);
    finishCleanup();
    await expect(done).resolves.toMatchObject({ found: [], stillRunning: [] });
    expect(table.listCalls).toBe(0);
  });

  it('stops waiting once the host is quitting', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const { steps, stop } = fakeSteps();
    const done = waitForExitedRootTrees(table.api, [killedRoot()], new Set(), steps);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    stop();
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.waitedMs).toBeLessThan(AGENT_EXIT_WAIT_MS);
    expect(result.stillRunning).toEqual(['claude.exe']);
  });

  it('prunes roots older than the ledger window', () => {
    const fresh = killedRoot({ exitedAtMs: EXITED_AT });
    const old = killedRoot({ exitedAtMs: EXITED_AT - EXITED_ROOT_LEDGER_MS });
    expect(pruneExitedRoots([old, fresh], EXITED_AT)).toEqual([fresh]);
  });

  it('POSIX: waits on the descendants listed before the kill, by pid, with no Win32 API', async () => {
    const alive = new Set([700, 710]);
    const { steps } = fakeSteps(alive);
    const descendants = Promise.resolve([{ pid: 700, image: 'claude' }, { pid: 710, image: 'node' }, { pid: 720, image: 'gone' }]);
    const done = waitForExitedRootTrees(null, [killedRoot({ descendants })], new Set(), steps);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    alive.delete(710);
    alive.delete(700);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.found).toEqual(['claude', 'node', 'gone']);
    expect(result.stillRunning).toEqual([]);
    expect(result.waitedMs).toBeLessThan(AGENT_EXIT_WAIT_MS);
  });

  it('POSIX: gives up at the bound, and never waits on a protected pid', async () => {
    const alive = new Set([700, 800]);
    const { steps } = fakeSteps(alive);
    const descendants = Promise.resolve([{ pid: 700, image: 'claude' }, { pid: 800, image: 'bash' }]);
    const done = waitForExitedRootTrees(null, [killedRoot({ descendants })], new Set([800]), steps);
    await vi.advanceTimersByTimeAsync(AGENT_EXIT_WAIT_MS + DEAD_ROOT_ORPHAN_POLL_MS);
    const result = await done;
    expect(result.found).toEqual(['claude']);
    expect(result.stillRunning).toEqual(['claude']);
  });
});

describe('agentDescendantsOf', () => {
  it('takes the shell\'s children, through a launcher, and nothing the agent started or beside it', () => {
    const rows = [
      { pid: ROOT_PID, ppid: 1, comm: 'bash' },
      // The stub a shell leaves when it execs a native program, then the agent.
      { pid: 700, ppid: ROOT_PID, comm: 'bash' },
      { pid: 705, ppid: 700, comm: 'claude' },
      { pid: 710, ppid: 705, comm: 'node' },
      { pid: 711, ppid: 710, comm: 'sh' },
      { pid: 900, ppid: 1, comm: 'unrelated' },
      { pid: 1, ppid: 1, comm: 'init' },
    ];
    expect(agentDescendantsOf(rows, ROOT_PID)).toEqual([
      { pid: 700, image: 'bash' },
      { pid: 705, image: 'claude' },
    ]);
  });

  it('survives a parent cycle in a torn listing', () => {
    const rows = [
      { pid: 700, ppid: ROOT_PID, comm: 'sh' },
      { pid: 710, ppid: 700, comm: 'bash' },
      { pid: 700, ppid: 710, comm: 'sh' },
    ];
    expect(agentDescendantsOf(rows, ROOT_PID).map((row) => row.pid)).toEqual([700, 710]);
  });
});

interface FakePty {
  pty: nodePty.IPty;
  exit(exitCode: number): void;
}

function createFakePty(pid: number): FakePty {
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
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
    _agent: { inSocket: { writable: true, destroyed: false, write: () => true } },
  } as unknown as nodePty.IPty;
  return { pty, exit: (exitCode) => exitListener?.({ exitCode }) };
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
    exitSequence: ['\x03', '/exit\r'],
    taskId: TASK,
    ...overrides,
  };
}

function makeCore(options: {
  platform?: NodeJS.Platform;
  withOrphanApi?: boolean;
  table: FakeProcessTable;
  listProcessesBeforeKill?: () => Promise<Array<{ pid: number; ppid: number; comm: string }>>;
  isProcessAlive?: (pid: number) => boolean;
}) {
  let clock = SPAWNED_AT;
  const fakes = new Map<number, FakePty>();
  let nextPid = ROOT_PID;
  const loadOrphanApi = vi.fn(async () => options.table.api);
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
    ...(options.listProcessesBeforeKill ? { listProcessesBeforeKill: options.listProcessesBeforeKill } : {}),
    ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
  });
  return {
    core,
    fakeFor: (pid: number) => fakes.get(pid) as FakePty,
    setClock: (value: number) => { clock = value; },
    advanceClock: (ms: number) => { clock += ms; },
  };
}

/** Advances the fake timers and the core's clock together. */
async function advance(rig: { advanceClock: (ms: number) => void }, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += DEAD_ROOT_ORPHAN_POLL_MS) {
    rig.advanceClock(DEAD_ROOT_ORPHAN_POLL_MS);
    await vi.advanceTimersByTimeAsync(DEAD_ROOT_ORPHAN_POLL_MS);
  }
}

/** The order main meets it: the kill lands once the agent is running, then the shell exits. */
function killThenExit(rig: ReturnType<typeof makeCore>): void {
  rig.setClock(EXITED_AT);
  rig.core.handleCommand({ type: 'kill', ptyId: 1 });
  rig.fakeFor(ROOT_PID).exit(1);
}

describe('PtyHostCore.awaitAgentExit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('after a kill, waits for the agent the dead shell started and answers once it has exited', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    killThenExit(rig);

    let answered = false;
    const wait = rig.core.awaitAgentExit([TASK]).then((result) => {
      answered = true;
      return result;
    });
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    expect(answered).toBe(false);
    table.exit(600);
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    await expect(wait).resolves.toMatchObject({ found: ['claude.exe'], stillRunning: [] });
    expect(table.terminated).toEqual([]);
  });

  it('a reap asked for right after the kill, before the shell has exited, already waits', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    rig.setClock(EXITED_AT);
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });

    let answered = false;
    const wait = rig.core.awaitAgentExit([TASK]).then((result) => {
      answered = true;
      return result;
    });
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    expect(answered).toBe(false);
    rig.fakeFor(ROOT_PID).exit(1);
    table.exit(600);
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    await expect(wait).resolves.toMatchObject({ found: ['claude.exe'], stillRunning: [] });
  });

  it('answers at once for a task none of whose shells exited lately', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    killThenExit(rig);
    await expect(rig.core.awaitAgentExit(['another-task'])).resolves.toEqual({ found: [], stillRunning: [], waitedMs: 0 });
    expect(table.listCalls).toBe(0);
  });

  it('forgets a root once the ledger window has passed', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    killThenExit(rig);
    rig.setClock(EXITED_AT + EXITED_ROOT_LEDGER_MS);
    await expect(rig.core.awaitAgentExit([TASK])).resolves.toEqual({ found: [], stillRunning: [], waitedMs: 0 });
  });

  it('after a natural exit, waits until the orphan cleanup has asked the agent and let it go', async () => {
    const table = new FakeProcessTable([
      { pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 },
    ]);
    const rig = makeCore({ table });
    rig.core.spawn(spawnParams());
    rig.setClock(EXITED_AT);
    rig.fakeFor(ROOT_PID).exit(1);
    await vi.advanceTimersByTimeAsync(0);

    let answered = false;
    const wait = rig.core.awaitAgentExit([TASK]).then((result) => {
      answered = true;
      return result;
    });
    // Past this wait's own bound, inside the orphan cleanup's longer grace: it is still asking.
    const pastOwnBoundMs = AGENT_EXIT_WAIT_MS + 1_000;
    expect(pastOwnBoundMs).toBeLessThan(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS);
    await advance(rig, pastOwnBoundMs);
    expect(answered).toBe(false);
    table.exit(600);
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    await expect(wait).resolves.toMatchObject({ stillRunning: [] });
    expect(table.terminated).toEqual([]);
  });

  it('POSIX: lists the shell\'s agent before the kill lands, then waits for it by pid', async () => {
    const table = new FakeProcessTable([]);
    const alive = new Set([700, 710]);
    let finishListing: () => void = () => undefined;
    const listProcessesBeforeKill = vi.fn(() => new Promise<Array<{ pid: number; ppid: number; comm: string }>>((resolve) => {
      finishListing = () => resolve([
        { pid: ROOT_PID, ppid: 1, comm: 'bash' },
        { pid: 700, ppid: ROOT_PID, comm: 'claude' },
        { pid: 710, ppid: 700, comm: 'node' },
        { pid: 900, ppid: 1, comm: 'unrelated' },
      ]);
    }));
    const rig = makeCore({
      platform: 'linux',
      table,
      listProcessesBeforeKill,
      isProcessAlive: (pid) => alive.has(pid),
    });
    rig.core.spawn(spawnParams({ file: '/bin/bash' }));
    rig.setClock(EXITED_AT);
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });
    const rootPty = rig.fakeFor(ROOT_PID).pty;
    // The hangup waits for the listing: once it lands, the children's parent is gone.
    expect(rootPty.kill).not.toHaveBeenCalled();
    finishListing();
    await vi.advanceTimersByTimeAsync(0);
    expect(rootPty.kill).toHaveBeenCalledTimes(1);
    rig.fakeFor(ROOT_PID).exit(129);

    let answered = false;
    const wait = rig.core.awaitAgentExit([TASK]).then((result) => {
      answered = true;
      return result;
    });
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    expect(answered).toBe(false);
    alive.clear();
    await advance(rig, DEAD_ROOT_ORPHAN_POLL_MS * 2);
    await expect(wait).resolves.toMatchObject({ found: ['claude'], stillRunning: [] });
    expect(table.listCalls).toBe(0);
  });

  it('POSIX: a listing that never answers holds the kill only to its cap', async () => {
    const table = new FakeProcessTable([]);
    const rig = makeCore({
      platform: 'linux',
      table,
      listProcessesBeforeKill: () => new Promise(() => undefined),
      isProcessAlive: () => true,
    });
    rig.core.spawn(spawnParams({ file: '/bin/bash' }));
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });
    const rootPty = rig.fakeFor(ROOT_PID).pty;
    await vi.advanceTimersByTimeAsync(KILL_SNAPSHOT_CAP_MS - 1);
    expect(rootPty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rootPty.kill).toHaveBeenCalledTimes(1);
    rig.fakeFor(ROOT_PID).exit(129);
    // Nothing was listed, so there is nothing to wait for.
    await expect(rig.core.awaitAgentExit([TASK])).resolves.toMatchObject({ found: [], stillRunning: [] });
  });

  it('POSIX: kills that arrive together share one listing', async () => {
    const table = new FakeProcessTable([]);
    const listProcessesBeforeKill = vi.fn(async () => [] as Array<{ pid: number; ppid: number; comm: string }>);
    const rig = makeCore({ platform: 'linux', table, listProcessesBeforeKill, isProcessAlive: () => false });
    rig.core.spawn(spawnParams({ file: '/bin/bash' }));
    rig.core.spawn(spawnParams({ ptyId: 2, sessionId: 'session-2', file: '/bin/bash' }));
    rig.core.handleCommand({ type: 'kill', ptyId: 1 });
    rig.core.handleCommand({ type: 'kill', ptyId: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listProcessesBeforeKill).toHaveBeenCalledTimes(1);
    expect(rig.fakeFor(ROOT_PID).pty.kill).toHaveBeenCalledTimes(1);
    expect(rig.fakeFor(ROOT_PID + 1).pty.kill).toHaveBeenCalledTimes(1);
  });

  it('never waits on POSIX without a pre-kill listing, in the in-process core, during a quit, or for a PTY with no task', async () => {
    const processes: FakeProcess[] = [{ pid: 600, ppid: ROOT_PID, image: 'claude.exe', startedAtMs: SPAWNED_AT + 2_000 }];
    const killAndExit = (rig: ReturnType<typeof makeCore>, overrides: Partial<PtyHostSpawnParams> = {}) => {
      rig.core.spawn(spawnParams(overrides));
      killThenExit(rig);
    };
    const posixTable = new FakeProcessTable(processes);
    const posix = makeCore({ platform: 'linux', table: posixTable });
    killAndExit(posix, { file: '/bin/bash' });
    const inProcessTable = new FakeProcessTable(processes);
    const inProcess = makeCore({ withOrphanApi: false, table: inProcessTable });
    killAndExit(inProcess);
    const noTaskTable = new FakeProcessTable(processes);
    const listForNoTask = vi.fn(async () => [] as Array<{ pid: number; ppid: number; comm: string }>);
    const noTask = makeCore({ table: noTaskTable });
    killAndExit(noTask, { taskId: null });
    const posixNoTask = makeCore({ platform: 'linux', table: new FakeProcessTable([]), listProcessesBeforeKill: listForNoTask });
    killAndExit(posixNoTask, { taskId: null, file: '/bin/bash' });
    const quittingTable = new FakeProcessTable(processes);
    const quitting = makeCore({ table: quittingTable });
    quitting.core.spawn(spawnParams());
    quitting.core.handleCommand({ type: 'shutdown' });
    quitting.setClock(EXITED_AT);
    quitting.fakeFor(ROOT_PID).exit(1);

    for (const rig of [posix, inProcess, noTask, posixNoTask, quitting]) {
      await expect(rig.core.awaitAgentExit([TASK])).resolves.toEqual({ found: [], stillRunning: [], waitedMs: 0 });
    }
    for (const table of [posixTable, inProcessTable, noTaskTable, quittingTable]) expect(table.listCalls).toBe(0);
    expect(listForNoTask).not.toHaveBeenCalled();
  });
});
