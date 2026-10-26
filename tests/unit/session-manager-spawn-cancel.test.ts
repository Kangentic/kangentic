/**
 * A spawn waits on the pty host for a round trip, and a teardown can land in
 * that window: a To Do move that kills and removes a queued task's placeholder
 * while its promotion is spawning, a suspend, a task delete. Before the PTY
 * moved to the host, `pty.spawn` was synchronous and no such window existed.
 *
 * Pinned here: a teardown aimed at a session (or its task) while it spawns
 * cancels the spawn. The PTY the host started is stopped, no running row is
 * registered or announced, and a killed placeholder the caller keeps reads
 * exited rather than queued. The spawn fails as an abort, which the board's
 * spawn paths treat as "the task was taken over", not as a failure. A queue
 * promotion also holds a concurrency slot while it spawns.
 *
 * A teardown that is about to remove the working directory waits for the spawn
 * it cancelled to settle, and a spawn settles with the exit of the PTY the host
 * had started for it. Pinned here too: that wait for a direct spawn's `suspend`,
 * for a promotion the task-wide removal's own loop starts, and the two ways the
 * wait is bounded when that PTY never reports an exit (a lost host, and the
 * safety timeout). `killAll` counts a spawn in its host round trip, so the quit
 * drain waits for the host that may have started its PTY.
 *
 * Tier: Unit. Node-pty is mocked; the host core runs in this process behind a
 * transport that holds the `spawn` request until the test releases it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// The real flag is one-way (`setShuttingDown` has no reset), so the quit is
// flagged through this switch, which `beforeEach` clears.
const shutdownSwitch = vi.hoisted(() => ({ shuttingDown: false }));
vi.mock('../../src/main/shutdown-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shutdown-state')>()),
  isShuttingDown: () => shutdownSwitch.shuttingDown,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import { InProcessPtyHostTransport, type PtyHostLifecycleListener } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostCommand, PtyHostMethod, PtyHostRequestMap } from '../../src/main/pty/host/protocol';
import type { AgentParser, Session } from '../../src/shared/types';
import { isAbortError } from '../../src/shared/abort-utils';

/** The in-process host core, holding every `spawn` request while `holdSpawns`
 *  is set, until `releaseSpawns()`. Other requests answer at once. It also has
 *  the two seams a utility-process host has and the in-process one does not (a
 *  lifecycle listener, and a pid), the way session-manager-host-lifecycle.test.ts
 *  gives them to its own transport. */
class HeldSpawnTransport extends InProcessPtyHostTransport {
  holdSpawns = false;
  readonly spawnRequests: string[] = [];
  private readonly held: Array<() => void> = [];
  private lifecycle: PtyHostLifecycleListener | null = null;

  constructor() {
    super({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  }

  setLifecycleListener(listener: PtyHostLifecycleListener): void {
    this.lifecycle = listener;
  }

  /** The host process died, as `UtilityPtyHostTransport` reports it. */
  hostDown(): void {
    this.lifecycle?.onHostDown();
  }

  /** The host's pid, which the in-process host does not have (`hostPid` is an
   *  own field set to null by the base class, so it is redefined, not shadowed). */
  setHostPid(pid: number): void {
    Object.defineProperty(this, 'hostPid', { value: pid, configurable: true });
  }

  override request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
  ): Promise<PtyHostRequestMap[M]['result']> {
    if (method === 'spawn') this.spawnRequests.push((params as PtyHostRequestMap['spawn']['params']).sessionId);
    if (method !== 'spawn' || !this.holdSpawns) return super.request(method, params);
    return new Promise((resolve, reject) => {
      this.held.push(() => {
        super.request(method, params).then(resolve, reject);
      });
    });
  }

  get heldSpawns(): number {
    return this.held.length;
  }

  releaseSpawns(): void {
    for (const release of this.held.splice(0)) release();
  }
}

let tmpDir: string;

/**
 * A node-pty stand-in. A kill ends it, as a real one's does, unless
 * `exitOnKill` is false; `exit()` ends it by hand, for a test that needs the
 * gap between the kill and the exit.
 */
function createMockPty(pid: number, options: { exitOnKill?: boolean } = {}) {
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const exit = (): void => exitListener?.({ exitCode: 0 });
  return {
    pid,
    cols: 120,
    rows: 30,
    onData: vi.fn(() => ({ dispose: () => undefined })),
    onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => undefined };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (options.exitOnKill !== false) exit();
    }),
    exit,
  };
}

function registryRow(manager: SessionManager, sessionId: string): ManagedSession | undefined {
  return (manager as unknown as { registry: { get(id: string): ManagedSession | undefined } }).registry.get(sessionId);
}

/** The manager's map of spawns inside `doSpawn`, by session id. */
function spawnsInFlight(manager: SessionManager): Map<string, unknown> {
  const inFlight = (manager as unknown as { spawnsInFlight?: Map<string, unknown> }).spawnsInFlight;
  // Defined first: a renamed field would otherwise read as an empty map.
  expect(inFlight).toBeInstanceOf(Map);
  return inFlight as Map<string, unknown>;
}

/** The `cancelSpawn` commands the manager has posted to the host since `postSpy`
 *  was installed on the transport (the client's `post` calls it at call time). */
function cancelSpawnPosts(postSpy: MockInstance<(command: PtyHostCommand) => void>): PtyHostCommand[] {
  return postSpy.mock.calls.map(([command]) => command).filter((command) => command.type === 'cancelSpawn');
}

/** The public teardowns aimed at one session id. Each reaches `cancelSpawnInFlight`
 *  (`remove` through `kill`), so each must tell the host. */
const SINGLE_SESSION_TEARDOWNS = {
  kill: async (manager: SessionManager, sessionId: string): Promise<void> => {
    manager.kill(sessionId);
  },
  remove: async (manager: SessionManager, sessionId: string): Promise<void> => {
    manager.remove(sessionId);
  },
  suspend: (manager: SessionManager, sessionId: string): Promise<void> => manager.suspend(sessionId),
};

/** Let promise continuations run until `done` holds, without advancing timers. */
async function flushUntil(done: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns && !done(); turn++) await Promise.resolve();
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

function makeManager() {
  const transport = new HeldSpawnTransport();
  const manager = new SessionManager({ ptyHostTransport: transport });
  const changes: Array<{ sessionId: string; status: string }> = [];
  manager.on('session-changed', (sessionId: string, session: Session) => {
    changes.push({ sessionId, status: session.status });
  });
  return { manager, transport, changes };
}

/**
 * One running session at a limit of one, and a second task queued behind it;
 * then the limit is raised so the queued one is promoted, and its spawn is
 * held at the host. Returns the queued placeholder and the PTY its promotion
 * will be given.
 */
async function promotionHeldAtTheHost(manager: SessionManager, transport: HeldSpawnTransport) {
  manager.setMaxConcurrent(1);
  vi.mocked(pty.spawn).mockReturnValue(createMockPty(301) as unknown as pty.IPty);
  await manager.spawn({ taskId: 'task-running', command: '', cwd: tmpDir });
  const queued = await manager.spawn({ taskId: 'task-queued', command: '', cwd: tmpDir });
  expect(queued.status).toBe('queued');

  const promotedPty = createMockPty(302);
  vi.mocked(pty.spawn).mockReturnValue(promotedPty as unknown as pty.IPty);
  transport.holdSpawns = true;
  manager.setMaxConcurrent(2);
  await flushUntil(() => transport.heldSpawns === 1);
  expect(transport.heldSpawns).toBe(1);
  return { queued, promotedPty };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued `mockReturnValueOnce` PTYs, so a test that
  // failed before using its own would hand them to the next one.
  vi.mocked(pty.spawn).mockReset();
  shutdownSwitch.shuttingDown = false;
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-spawn-cancel-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager: a teardown while a queue promotion spawns at the host', () => {
  it('a remove leaves no row, stops the PTY the host started, and announces no running session', async () => {
    const { manager, transport, changes } = makeManager();
    const { queued, promotedPty } = await promotionHeldAtTheHost(manager, transport);
    // The exit must land while the row still exists: the DB listener reads the
    // session's project from it to mark the record exited, so an exit after
    // the removal (or none) leaves the record 'queued'.
    const exits: Array<{ sessionId: string; exitCode: number; intentional: boolean | undefined; rowPresent: boolean }> = [];
    manager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
      exits.push({ sessionId, exitCode, intentional, rowPresent: registryRow(manager, sessionId) !== undefined });
    });

    manager.remove(queued.id);
    transport.releaseSpawns();
    await flush();

    expect(registryRow(manager, queued.id)).toBeUndefined();
    expect(promotedPty.kill).toHaveBeenCalledTimes(1);
    expect(changes.filter((change) => change.sessionId === queued.id && change.status === 'running')).toEqual([]);
    expect(exits).toEqual([{ sessionId: queued.id, exitCode: -1, intentional: true, rowPresent: true }]);
  });

  it('a kill the caller announces as ended keeps the row exited', async () => {
    const { manager, transport } = makeManager();
    const { queued, promotedPty } = await promotionHeldAtTheHost(manager, transport);

    manager.killByTaskId('task-queued');
    manager.announceSessionEnded(queued.id);
    transport.releaseSpawns();
    await flush();

    expect(registryRow(manager, queued.id)?.status).toBe('exited');
    expect(registryRow(manager, queued.id)?.pty).toBeNull();
    expect(promotedPty.kill).toHaveBeenCalledTimes(1);
  });

  it('a kill the caller keeps the row for marks it exited, with an intentional exit', async () => {
    const { manager, transport } = makeManager();
    const { queued, promotedPty } = await promotionHeldAtTheHost(manager, transport);
    const exits: Array<{ sessionId: string; exitCode: number; intentional: boolean | undefined }> = [];
    manager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
      exits.push({ sessionId, exitCode, intentional });
    });

    // The To Do move's shape: kill every row of the task, keep them for the
    // cleanup that waits on their exit.
    manager.killByTaskId('task-queued');
    transport.releaseSpawns();
    await flush();

    expect(registryRow(manager, queued.id)?.status).toBe('exited');
    expect(promotedPty.kill).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([{ sessionId: queued.id, exitCode: -1, intentional: true }]);
  });

  it('a suspend keeps the row suspended', async () => {
    const { manager, transport } = makeManager();
    const { queued, promotedPty } = await promotionHeldAtTheHost(manager, transport);

    const suspending = manager.suspend(queued.id);
    transport.releaseSpawns();
    await suspending;
    await flush();

    expect(registryRow(manager, queued.id)?.status).toBe('suspended');
    expect(registryRow(manager, queued.id)?.pty).toBeNull();
    expect(promotedPty.kill).toHaveBeenCalledTimes(1);
  });

  it('registers no failed-spawn row for a removed session whose host spawn also failed', async () => {
    const { manager, transport } = makeManager();
    const { queued } = await promotionHeldAtTheHost(manager, transport);

    manager.remove(queued.id);
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn failed');
    });
    transport.releaseSpawns();
    await flush();

    expect(registryRow(manager, queued.id)).toBeUndefined();
  });

  it('holds a concurrency slot while the promotion spawns, so a direct spawn queues', async () => {
    const { manager, transport } = makeManager();
    await promotionHeldAtTheHost(manager, transport);

    // Two allowed: the running session and the promotion in flight.
    let direct: Session | null = null;
    void manager.spawn({ taskId: 'task-direct', command: '', cwd: tmpDir }).then((session) => {
      direct = session;
    });
    await flush();

    expect(direct).not.toBeNull();
    expect((direct as Session | null)?.status).toBe('queued');
    expect(transport.heldSpawns).toBe(1);
  });

  it('control: with nothing torn down the promotion registers and runs', async () => {
    const { manager, transport, changes } = makeManager();
    const { queued, promotedPty } = await promotionHeldAtTheHost(manager, transport);

    transport.releaseSpawns();
    await flush();

    expect(registryRow(manager, queued.id)?.status).toBe('running');
    expect(promotedPty.kill).not.toHaveBeenCalled();
    expect(changes.some((change) => change.sessionId === queued.id && change.status === 'running')).toBe(true);
  });
});

describe('SessionManager: what a cancelled spawn leaves for the teardown', () => {
  it('a suspend during the promotion leaves the suspended sibling\'s scrollback in the host', async () => {
    const { manager, transport } = makeManager();
    manager.setMaxConcurrent(2);
    // The task's earlier session, suspended, with what it printed still in the host.
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(501) as unknown as pty.IPty);
    const earlier = await manager.spawn({ taskId: 'task-shared', command: '', cwd: tmpDir });
    transport.post({ type: 'initSession', sessionId: earlier.id, scrollback: 'earlier output', cols: 120 });
    const earlierRow = registryRow(manager, earlier.id);
    if (!earlierRow) throw new Error('expected the earlier row');
    earlierRow.status = 'suspended';
    earlierRow.pty = null;
    // Another task holds the one slot, so the task's next session queues.
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(502) as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-other', command: '', cwd: tmpDir });
    manager.setMaxConcurrent(1);
    const queued = await manager.spawn({ taskId: 'task-shared', command: '', cwd: tmpDir });
    expect(queued.status).toBe('queued');

    vi.mocked(pty.spawn).mockReturnValue(createMockPty(503) as unknown as pty.IPty);
    transport.holdSpawns = true;
    manager.setMaxConcurrent(2);
    await flushUntil(() => transport.heldSpawns === 1);
    const suspending = manager.suspend(queued.id);
    transport.releaseSpawns();
    await suspending;

    expect(registryRow(manager, queued.id)?.status).toBe('suspended');
    expect(registryRow(manager, earlier.id)?.status).toBe('suspended');
    expect(await manager.getRawScrollback(earlier.id)).toBe('earlier output');
  });

  it('removeByTaskId resolves only once the PTY the cancelled spawn started has exited', async () => {
    const { manager, transport } = makeManager();
    const directPty = createMockPty(601, { exitOnKill: false });
    vi.mocked(pty.spawn).mockReturnValue(directPty as unknown as pty.IPty);
    transport.holdSpawns = true;
    const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
    void spawning.catch(() => undefined);
    await flushUntil(() => transport.heldSpawns === 1);

    let settled = false;
    void manager.removeByTaskId('task-direct').then(() => {
      settled = true;
    });
    transport.releaseSpawns();
    await flush();

    // Killed, but its process still holds the working directory.
    expect(directPty.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    directPty.exit();
    await flush();
    expect(settled).toBe(true);
  });

  it('awaitExit after a kill waits for the PTY a cancelled promotion started', async () => {
    const { manager, transport } = makeManager();
    manager.setMaxConcurrent(1);
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(701) as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-running', command: '', cwd: tmpDir });
    const queued = await manager.spawn({ taskId: 'task-queued', command: '', cwd: tmpDir });
    const promotedPty = createMockPty(702, { exitOnKill: false });
    vi.mocked(pty.spawn).mockReturnValue(promotedPty as unknown as pty.IPty);
    transport.holdSpawns = true;
    manager.setMaxConcurrent(2);
    await flushUntil(() => transport.heldSpawns === 1);

    // The To Do cleanup's order: kill, then wait for the exit, then remove.
    manager.kill(queued.id);
    let exited = false;
    void manager.awaitExit(queued.id).then(() => {
      exited = true;
    });
    transport.releaseSpawns();
    await flush();

    expect(promotedPty.kill).toHaveBeenCalledTimes(1);
    expect(exited).toBe(false);

    promotedPty.exit();
    await flush();
    expect(exited).toBe(true);
  });
});

/**
 * A direct spawn (no queue) with its host reply held, so the session has no
 * registry row yet. Its PTY is the one the host starts when the reply is
 * released; with `exitOnKill: false` the abandoned spawn's kill does not end it,
 * so a test decides when (and whether) the exit is reported.
 */
async function holdDirectSpawn(manager: SessionManager, transport: HeldSpawnTransport, pid: number) {
  const directPty = createMockPty(pid, { exitOnKill: false });
  vi.mocked(pty.spawn).mockReturnValue(directPty as unknown as pty.IPty);
  transport.holdSpawns = true;
  const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
  void spawning.catch(() => undefined);
  await flushUntil(() => transport.heldSpawns === 1);
  expect(transport.heldSpawns).toBe(1);
  expect(registryRow(manager, 'direct-session')).toBeUndefined();
  return { directPty, spawning };
}

describe('SessionManager: a teardown waits for the spawn it cancelled to settle', () => {
  // Pins the `if (inFlight) await this.awaitSpawnsSettled([inFlight])` in
  // `suspend()`'s no-row branch. A direct spawn has no row until its host reply
  // lands, so before it `suspend(id)` returned at once, and a Done move removed
  // the worktree under the PTY the host had started.
  it('suspend of a direct spawn held at the host resolves only once the abandoned PTY has exited', async () => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 611);

    let suspended = false;
    void manager.suspend('direct-session').then(() => {
      suspended = true;
    });
    transport.releaseSpawns();
    await flush();

    // The host's reply landed, the spawn saw the cancel and killed the PTY it
    // had started, and that PTY has not reported its exit: its process still
    // holds the working directory.
    expect(directPty.kill).toHaveBeenCalledTimes(1);
    expect(suspended).toBe(false);

    directPty.exit();
    await flush();
    expect(suspended).toBe(true);
    expect(registryRow(manager, 'direct-session')).toBeUndefined();
  });

  // Pins that `removeByTaskId` reads the spawns in flight AFTER its removal
  // loop. Each `remove` frees a slot, and the queue starts the task's next
  // queued row inside the loop (here: removing the first queued row promotes the
  // second, the running row's slot already being free). Read before the loop,
  // that promotion was not in the set, so the removal resolved at once and the
  // caller removed a worktree the promotion's shell and PTY were about to use.
  // The shell is held, so the promotion is parked where only the wait can see it.
  it('removeByTaskId waits for a promotion its own removal loop started, and for the rows it removed', async () => {
    const { manager, transport } = makeManager();
    manager.setMaxConcurrent(1);
    // Ended by hand: the running row is young, so its kill is parked for the
    // exit-sequence grace and its PTY still holds the directory meanwhile.
    const runningPty = createMockPty(801, { exitOnKill: false });
    vi.mocked(pty.spawn).mockReturnValue(runningPty as unknown as pty.IPty);
    const running = await manager.spawn({ taskId: 'task-shared', command: '', cwd: tmpDir });
    const firstQueued = await manager.spawn({ taskId: 'task-shared', command: '', cwd: tmpDir });
    const secondQueued = await manager.spawn({ taskId: 'task-shared', command: '', cwd: tmpDir });
    expect(firstQueued.status).toBe('queued');
    expect(secondQueued.status).toBe('queued');
    // Nothing is in flight when the removal is called, so a read taken before
    // the loop is an empty set.
    expect(spawnsInFlight(manager).size).toBe(0);

    let resolveShell: (shell: string) => void = () => undefined;
    vi.spyOn(manager, 'getShell').mockReturnValue(new Promise((resolve) => {
      resolveShell = resolve;
    }));
    let settled = false;
    void manager.removeByTaskId('task-shared').then(() => {
      settled = true;
    });

    // Precondition: the loop's removals started the second row's promotion, and
    // it is tracked. Without this the assertions below would pass for a
    // removal that never promoted anything.
    expect(spawnsInFlight(manager).has(secondQueued.id)).toBe(true);
    await flush();
    expect(settled).toBe(false);

    resolveShell('/bin/bash');
    await flush();

    // The promotion saw its cancel before the host was asked for anything: the
    // only spawn the host ever saw is the running row's, from the setup.
    expect(spawnsInFlight(manager).size).toBe(0);
    expect(transport.spawnRequests).toEqual([running.id]);
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(registryRow(manager, secondQueued.id)).toBeUndefined();
    // Red-green: the row exits captured inside the loop. Without them the
    // removal resolved here, with the running row's PTY still alive.
    expect(settled).toBe(false);

    runningPty.exit();
    await flush();
    expect(settled).toBe(true);
  });
});

describe('SessionManager: a cancelled spawn whose PTY never reports its exit still settles', () => {
  // `SPAWN_SETTLE_TIMEOUT_MS` in session-manager.ts, which is not exported.
  // Pinned here as the contract: a teardown never waits on a cancelled spawn
  // longer than awaitExit waits for a PTY.
  const SPAWN_SETTLE_TIMEOUT_MS = 10_000;

  // Pins that the abandoned PTY's exit listener is among those the client
  // reports when the host dies (`PtyHostClient.reportHostLost`). The host takes
  // its PTYs with it, so no exit event will ever come; if the listener were not
  // reached, the removal would sit out the whole safety timeout on a host that
  // is gone. No timer is advanced here, so the budget cannot be what resolved it.
  it('a lost host settles the spawn, and the removal that waits on it, with no timer advanced', async () => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 621);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let settled = false;
      void manager.removeByTaskId('task-direct').then(() => {
        settled = true;
      });
      transport.releaseSpawns();
      await flush();

      // Precondition: the abandoned PTY was killed and has not exited, and the
      // removal is waiting on it.
      expect(directPty.kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(spawnsInFlight(manager).size).toBe(1);

      transport.hostDown();
      await flush();

      expect(settled).toBe(true);
      expect(spawnsInFlight(manager).size).toBe(0);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('did not settle in time'));
    } finally {
      warn.mockRestore();
    }
  });

  // Pins `awaitSpawnsSettled`'s safety timeout: a PTY that reports no exit and a
  // host that stays up must not hold the teardown forever.
  it('with no exit at all, the removal resolves after the safety timeout, with a warning', async () => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 631);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let settled = false;
      void manager.removeByTaskId('task-direct').then(() => {
        settled = true;
      });
      transport.releaseSpawns();
      await flush();
      expect(directPty.kill).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SPAWN_SETTLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('did not settle in time'));

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not settle in time'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SessionManager: killAll with a spawn in its host round trip', () => {
  const HOST_PID = 4242;

  // Pins the `this.spawnsInFlight.size === 0` term in `killAll`'s host-pid
  // condition. The host may have started the spawn's PTY, which the spawn flow
  // stops when the reply lands; with no row for it `killedCount` is 0, so
  // before the change the report left the host out and the quit drain let the
  // host be torn down with that kill in flight.
  it('includes the host pid while a spawn is held at the host, though no session exists yet', async () => {
    const { manager, transport } = makeManager();
    transport.setHostPid(HOST_PID);
    await holdDirectSpawn(manager, transport, 641);

    const report = manager.killAll();

    expect(report.pids).toEqual([HOST_PID]);
    expect(report.killedCount).toBe(1);
    expect(report.deferredCount).toBe(0);

    // Let the held spawn finish, so nothing is left parked on the transport.
    transport.releaseSpawns();
    await flush();
  });

  // Control for the test above, on its own manager and before any spawn: with no
  // session and no spawn in flight the host pid is not added, so the report
  // above is the in-flight spawn and not a host pid that is always appended.
  it('leaves the host out of the report when nothing was killed and no spawn is in flight', () => {
    const { manager, transport } = makeManager();
    transport.setHostPid(HOST_PID);

    const report = manager.killAll();

    expect(report.pids).toEqual([]);
    expect(report.killedCount).toBe(0);
  });
});

describe('SessionManager: a teardown while a direct spawn is in flight', () => {
  it('a task-wide remove during the host spawn fails the spawn as an abort and leaves no row', async () => {
    const { manager, transport } = makeManager();
    const directPty = createMockPty(401);
    vi.mocked(pty.spawn).mockReturnValue(directPty as unknown as pty.IPty);
    transport.holdSpawns = true;

    const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
    const outcome = spawning.then(() => 'resolved', (error: unknown) => error);
    await flushUntil(() => transport.heldSpawns === 1);
    manager.removeByTaskId('task-direct');
    transport.releaseSpawns();

    const result = await outcome;
    expect(isAbortError(result)).toBe(true);
    expect(registryRow(manager, 'direct-session')).toBeUndefined();
    expect(directPty.kill).toHaveBeenCalledTimes(1);
  });

  it('a task-wide kill before the shell resolves stops the spawn before the host starts anything', async () => {
    const { manager, transport } = makeManager();
    let resolveShell: (shell: string) => void = () => undefined;
    vi.spyOn(manager, 'getShell').mockReturnValue(new Promise((resolve) => {
      resolveShell = resolve;
    }));

    const spawning = manager.spawn({ id: 'early-session', taskId: 'task-early', command: '', cwd: tmpDir });
    const outcome = spawning.then(() => 'resolved', (error: unknown) => error);
    await flush();
    manager.killByTaskId('task-early');
    resolveShell('/bin/bash');

    const result = await outcome;
    expect(isAbortError(result)).toBe(true);
    expect(transport.spawnRequests).toEqual([]);
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(registryRow(manager, 'early-session')).toBeUndefined();
  });

  it('control: an unrelated task\'s teardown does not cancel the spawn, and nothing is left tracked', async () => {
    const { manager, transport } = makeManager();
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(402) as unknown as pty.IPty);
    transport.holdSpawns = true;

    const spawning = manager.spawn({ id: 'kept-session', taskId: 'task-kept', command: '', cwd: tmpDir });
    await flushUntil(() => transport.heldSpawns === 1);
    manager.removeByTaskId('task-unrelated');
    transport.releaseSpawns();

    const session = await spawning;
    expect(session.status).toBe('running');
    expect(registryRow(manager, 'kept-session')?.status).toBe('running');
    const inFlight = (manager as unknown as { spawnsInFlight?: Map<string, unknown> }).spawnsInFlight;
    // Defined first: a renamed field would otherwise read as an empty map.
    expect(inFlight).toBeInstanceOf(Map);
    expect(inFlight?.size).toBe(0);
  });
});

describe('SessionManager: a teardown while the host waits on a ConPTY whose output never connected', () => {
  // The host spawns such a PTY once more before it answers (root-pid-gate.ts),
  // which would hold a teardown waiting on the spawn to settle through a whole
  // second attempt. The cancel reaches the host (`cancelSpawn`), so it does not.

  /** A ConPTY stand-in: pid 0 until its output connects, which it never does. */
  function createUnconnectedPty() {
    let exitListener: ((event: { exitCode: number }) => void) | null = null;
    return {
      pid: 0,
      cols: 120,
      rows: 30,
      onData: vi.fn(() => ({ dispose: () => undefined })),
      onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
        exitListener = listener;
        return { dispose: () => { exitListener = null; } };
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      /** node-pty's connect timeout: an exit carrying -1 with the pid still 0. */
      failToConnect: (): void => exitListener?.({ exitCode: -1 }),
    };
  }

  it('a task-wide remove keeps the host from spawning it again, and settles with the first attempt', async () => {
    const { manager } = makeManager();
    const unconnected = createUnconnectedPty();
    vi.mocked(pty.spawn).mockReturnValue(unconnected as unknown as pty.IPty);
    const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
    const outcome = spawning.then(() => 'resolved', (error: unknown) => error);
    await flushUntil(() => vi.mocked(pty.spawn).mock.calls.length === 1);
    expect(pty.spawn).toHaveBeenCalledTimes(1);

    let settled = false;
    void manager.removeByTaskId('task-direct').then(() => {
      settled = true;
    });
    unconnected.failToConnect();
    await flush();

    // Red-green: without the cancel reaching the host, a second spawn starts here.
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(isAbortError(await outcome)).toBe(true);
    await flush();
    expect(settled).toBe(true);
    expect(registryRow(manager, 'direct-session')).toBeUndefined();
  });

  // The single-session path (`cancelSpawnInFlight`), as the test above is the
  // task-wide one. Not `remove`: it also posts `removeSession`, and the host
  // declines a retry for a session it no longer holds, so a `remove` would show
  // no second attempt with the cancel gone. Its cancel is pinned below instead.
  it.each(['kill', 'suspend'] as const)('a single-session %s keeps the host from spawning it again, and tells it once', async (teardown) => {
    const { manager, transport } = makeManager();
    const unconnected = createUnconnectedPty();
    vi.mocked(pty.spawn).mockReturnValue(unconnected as unknown as pty.IPty);
    const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
    const outcome = spawning.then(() => 'resolved', (error: unknown) => error);
    await flushUntil(() => vi.mocked(pty.spawn).mock.calls.length === 1);
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    const post = vi.spyOn(transport, 'post');

    const tornDown = SINGLE_SESSION_TEARDOWNS[teardown](manager, 'direct-session');
    expect(cancelSpawnPosts(post)).toEqual([{ type: 'cancelSpawn', sessionId: 'direct-session' }]);
    unconnected.failToConnect();
    await flush();

    // Red-green: without the cancel reaching the host, a second spawn starts here.
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(isAbortError(await outcome)).toBe(true);
    await tornDown;
    expect(registryRow(manager, 'direct-session')).toBeUndefined();
  });

  it('control: with no teardown the host spawns it once more', async () => {
    const { manager } = makeManager();
    const first = createUnconnectedPty();
    const second = createUnconnectedPty();
    vi.mocked(pty.spawn).mockReturnValueOnce(first as unknown as pty.IPty).mockReturnValueOnce(second as unknown as pty.IPty);
    const spawning = manager.spawn({ id: 'direct-session', taskId: 'task-direct', command: '', cwd: tmpDir });
    await flushUntil(() => vi.mocked(pty.spawn).mock.calls.length === 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      first.failToConnect();
      await flushUntil(() => vi.mocked(pty.spawn).mock.calls.length === 2);
      expect(pty.spawn).toHaveBeenCalledTimes(2);

      // The second attempt fails the same way: the spawn ends as a failed one.
      second.failToConnect();
      const session = await spawning;
      expect(session.status).toBe('exited');
    } finally {
      warn.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe('SessionManager: the host hears of a cancelled spawn once, and only for that spawn', () => {
  // `markSpawnCancelled` posts `cancelSpawn` at most once per spawn, however many
  // teardown paths reach it: `removeByTaskId` alone reaches it twice, before and
  // after its removal loop. The post is read off the transport the manager posts
  // through; `pty.spawn` counts cannot see it for a PTY that connects.

  it.each(['kill', 'remove', 'suspend'] as const)('a single-session %s posts cancelSpawn for that session and not for another spawn in flight', async (teardown) => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 651);
    const bystanderPty = createMockPty(652);
    // The held spawns reach the host in the order they were sent. A queue the
    // implementation drains, not `mockReturnValueOnce`, so a failed run cannot
    // leave an unused PTY queued for the next test.
    const startedPtys = [directPty, bystanderPty];
    vi.mocked(pty.spawn).mockImplementation(() => startedPtys.shift() as unknown as pty.IPty);
    void manager.spawn({ id: 'bystander-session', taskId: 'task-bystander', command: '', cwd: tmpDir });
    await flushUntil(() => transport.heldSpawns === 2);
    expect(transport.heldSpawns).toBe(2);
    const post = vi.spyOn(transport, 'post');

    const tornDown = SINGLE_SESSION_TEARDOWNS[teardown](manager, 'direct-session');

    expect(cancelSpawnPosts(post)).toEqual([{ type: 'cancelSpawn', sessionId: 'direct-session' }]);

    transport.releaseSpawns();
    await flush();
    directPty.exit();
    await flush();
    await tornDown;
    // The other spawn was not cancelled in the manager either: it registered and runs.
    expect(registryRow(manager, 'bystander-session')?.status).toBe('running');
    expect(registryRow(manager, 'direct-session')).toBeUndefined();
  });

  it('posts one cancelSpawn when a task-wide remove reaches the spawn on both of its cancels', async () => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 661);
    const post = vi.spyOn(transport, 'post');

    const removing = manager.removeByTaskId('task-direct');

    expect(cancelSpawnPosts(post)).toEqual([{ type: 'cancelSpawn', sessionId: 'direct-session' }]);

    transport.releaseSpawns();
    await flush();
    directPty.exit();
    await flush();
    await removing;
  });

  it('posts one cancelSpawn when a single-session kill, a task-wide remove and a task-wide kill all reach the same spawn', async () => {
    const { manager, transport } = makeManager();
    const { directPty } = await holdDirectSpawn(manager, transport, 662);
    const post = vi.spyOn(transport, 'post');

    manager.kill('direct-session');
    const removing = manager.removeByTaskId('task-direct');
    manager.killByTaskId('task-direct');

    expect(cancelSpawnPosts(post)).toEqual([{ type: 'cancelSpawn', sessionId: 'direct-session' }]);

    transport.releaseSpawns();
    await flush();
    directPty.exit();
    await flush();
    await removing;
  });
});

describe('SessionManager: a spawn that never runs releases its command\'s hold', () => {
  // A folder-shared adapter (Gemini, Cursor, ...) takes its hold in
  // buildCommand under the session's own id. A spawn that never becomes a
  // running session has no PTY exit to release it, and a hold never released
  // keeps the folder's file in place for the rest of the run. SessionManager
  // releases every spawn it took that did not run. No row exists for a
  // cancelled spawn, so the release comes from the spawn's own input.
  //
  // Red-green: dropping the release in doSpawn's catch, on its failed-spawn
  // branch, in kill()'s dequeue branch, or in spawn()'s shutdown refusal fails
  // the matching test. Making doSpawn's catch release unconditionally (not only
  // for a spawn with no PTY row) fails the "keeps the hold" test below.

  function holdingParser() {
    const removeHooks = vi.fn();
    const parser = {
      detectFirstOutput: () => false,
      removeHooks,
      runtime: { sessionId: { fromOutput: () => null } },
    } as unknown as AgentParser;
    return { parser, removeHooks };
  }

  it('a direct spawn a teardown cancelled at the host releases with its id and requested cwd', async () => {
    const { manager, transport } = makeManager();
    const { parser, removeHooks } = holdingParser();
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(501) as unknown as pty.IPty);
    transport.holdSpawns = true;

    const spawning = manager.spawn({ id: 'cancelled-session', taskId: 'task-cancelled', command: '', cwd: tmpDir, agentParser: parser });
    const outcome = spawning.then(() => 'resolved', (error: unknown) => error);
    await flushUntil(() => transport.heldSpawns === 1);
    manager.removeByTaskId('task-cancelled');
    transport.releaseSpawns();

    expect(isAbortError(await outcome)).toBe(true);
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'cancelled-session');
  });

  it('a spawn whose host spawn failed releases, since its exited row has no PTY to exit', async () => {
    const { manager } = makeManager();
    const { parser, removeHooks } = holdingParser();
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const session = await manager.spawn({ id: 'failed-session', taskId: 'task-failed', command: '', cwd: tmpDir, agentParser: parser });

    expect(session.status).toBe('exited');
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'failed-session');
  });

  it('a queued placeholder killed before its promotion releases', async () => {
    const { manager } = makeManager();
    const { parser, removeHooks } = holdingParser();
    manager.setMaxConcurrent(1);
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(502) as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-running', command: '', cwd: tmpDir });
    const queued = await manager.spawn({ id: 'queued-session', taskId: 'task-queued', command: '', cwd: tmpDir, agentParser: parser });
    expect(queued.status).toBe('queued');

    manager.kill(queued.id);

    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'queued-session');
  });

  // The caller handed the built command over by calling spawn(), so it does not
  // release it itself; the refusal at the top of spawn() is then the only thing
  // left to end a hold taken for a spawn that will never run.
  it('a spawn refused because the quit began releases with its id and requested cwd', async () => {
    const { manager, transport } = makeManager();
    const { parser, removeHooks } = holdingParser();
    shutdownSwitch.shuttingDown = true;

    await expect(
      manager.spawn({ id: 'refused-session', taskId: 'task-refused', command: '', cwd: tmpDir, agentParser: parser }),
    ).rejects.toThrow('Cannot spawn session during shutdown');

    expect(removeHooks).toHaveBeenCalledTimes(1);
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'refused-session');
    // Refused before the host or the registry heard of it.
    expect(transport.spawnRequests).toEqual([]);
    expect(registryRow(manager, 'refused-session')).toBeUndefined();
  });

  // Control for the refusal above. A hold is taken under the id the caller
  // passed, so a spawn with no id took none and has nothing to release.
  it('control: a spawn with no id refused for the quit rejects without releasing', async () => {
    const { manager } = makeManager();
    const { parser, removeHooks } = holdingParser();
    shutdownSwitch.shuttingDown = true;

    await expect(
      manager.spawn({ taskId: 'task-refused', command: '', cwd: tmpDir, agentParser: parser }),
    ).rejects.toThrow('Cannot spawn session during shutdown');

    expect(removeHooks).not.toHaveBeenCalled();
  });

  // performSpawn announces a new session with `session-changed` right after it
  // registers the row and the PTY's exit listener, so a listener that throws
  // there fails the spawn with a running PTY behind it (a stand-in for any
  // late failure in the spawn flow). Stripping the folder's file now would pull
  // the agent's hooks or MCP entry from under it, so the hold waits for the exit.
  it('a spawn that fails after its PTY was registered keeps the hold until that PTY exits', async () => {
    const { manager } = makeManager();
    const { parser, removeHooks } = holdingParser();
    const startedPty = createMockPty(504, { exitOnKill: false });
    vi.mocked(pty.spawn).mockReturnValue(startedPty as unknown as pty.IPty);
    let announcementsOfFailingSession = 0;
    manager.on('session-changed', (sessionId: string) => {
      if (sessionId !== 'failing-session') return;
      // Only the spawn's own announcement fails; a later push for the row must not.
      announcementsOfFailingSession++;
      if (announcementsOfFailingSession === 1) throw new Error('listener failed');
    });

    await expect(
      manager.spawn({ id: 'failing-session', taskId: 'task-failing', command: '', cwd: tmpDir, agentParser: parser }),
    ).rejects.toThrow('listener failed');

    // Precondition: the failure came after the row got its PTY, so the agent
    // is running with nothing else to end its hold.
    expect(registryRow(manager, 'failing-session')?.pty).toBeTruthy();
    expect(removeHooks).not.toHaveBeenCalled();

    startedPty.exit();
    await flush();

    expect(removeHooks).toHaveBeenCalledTimes(1);
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'failing-session');
  });

  it('control: a spawn that runs keeps its hold until its own end', async () => {
    const { manager } = makeManager();
    const { parser, removeHooks } = holdingParser();
    vi.mocked(pty.spawn).mockReturnValue(createMockPty(503) as unknown as pty.IPty);

    const session = await manager.spawn({ id: 'running-session', taskId: 'task-runs', command: '', cwd: tmpDir, agentParser: parser });

    expect(session.status).toBe('running');
    expect(removeHooks).not.toHaveBeenCalled();
    manager.killAll();
  });
});
