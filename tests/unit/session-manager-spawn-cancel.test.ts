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
 * Tier: Unit. Node-pty is mocked; the host core runs in this process behind a
 * transport that holds the `spawn` request until the test releases it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostMethod, PtyHostRequestMap } from '../../src/main/pty/host/protocol';
import type { Session } from '../../src/shared/types';
import { isAbortError } from '../../src/shared/abort-utils';

/** The in-process host core, holding every `spawn` request while `holdSpawns`
 *  is set, until `releaseSpawns()`. Other requests answer at once. */
class HeldSpawnTransport extends InProcessPtyHostTransport {
  holdSpawns = false;
  readonly spawnRequests: string[] = [];
  private readonly held: Array<() => void> = [];

  constructor() {
    super({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
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
    expect(inFlight?.size ?? 0).toBe(0);
  });
});
