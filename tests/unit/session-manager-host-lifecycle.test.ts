/**
 * SessionManager's side of the pty host: what it does when the host dies and
 * comes back, and which host events it refuses to apply.
 *
 * Separate from session-manager.test.ts for the same reason the other
 * session-manager-*.test.ts files are: it needs its own transport. This one is
 * the in-process host core plus the two seams a utility-process host offers
 * and the default in-process transport does not, a lifecycle listener (the
 * host dying, the host coming back) and a way to inject a host event.
 *
 * Pinned here:
 *  - The 'pty-host-lost' payload lists only the sessions the host took down. A
 *    row main was already ending (status 'suspended', or `intentionalExit`) is
 *    left out so recovery does not resume it against that intent; a running row
 *    and an id whose row is already gone are kept.
 *  - A restart replays the focus and tap sets and announces itself; a first
 *    start does neither.
 *  - A `firstOutput` or `altScreen` host event for a session no longer in the
 *    registry is dropped. Applying it would re-create the first-output latch and
 *    the alt-screen mirror that `remove()` just cleared, for a session that is gone.
 *  - A suspend asks the host for the raw scrollback (its last-resort agent
 *    session id scan) only while the id is unknown, and then waits at most 2 s.
 *
 * Tier: Unit. Node-pty is mocked, the host core runs in this process.
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
import {
  InProcessPtyHostTransport,
  type PtyHostLifecycleListener,
} from '../../src/main/pty/host/pty-host-client';
import type {
  PtyHostCommand,
  PtyHostEvent,
  PtyHostMethod,
  PtyHostRequestMap,
} from '../../src/main/pty/host/protocol';
import { PTY_HOST_LOST_EXIT_CODE } from '../../src/shared/pty-host';

/**
 * The in-process host core, with a hand on the host's lifecycle and event
 * stream. `hostDown()` and `hostUp()` call the listener `PtyHostClient`
 * installs, exactly as `UtilityPtyHostTransport` does when the process exits
 * and when its replacement says ready.
 */
class ControllableHostTransport extends InProcessPtyHostTransport {
  readonly posted: PtyHostCommand[] = [];
  /** Every request main made, with the per-request options the in-process
   *  transport itself ignores (a utility-process transport honors `timeoutMs`). */
  readonly requested: Array<{ method: PtyHostMethod; params: unknown; options: { timeoutMs?: number } | undefined }> = [];
  private lifecycle: PtyHostLifecycleListener | null = null;
  private deliver: ((event: PtyHostEvent) => void) | null = null;

  constructor() {
    super({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  }

  setLifecycleListener(listener: PtyHostLifecycleListener): void {
    this.lifecycle = listener;
  }

  override setEventListener(listener: (event: PtyHostEvent) => void): void {
    this.deliver = listener;
    super.setEventListener(listener);
  }

  override post(command: PtyHostCommand): void {
    this.posted.push(command);
    super.post(command);
  }

  override request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: { timeoutMs?: number },
  ): Promise<PtyHostRequestMap[M]['result']> {
    this.requested.push({ method, params, options });
    return super.request(method, params);
  }

  hostDown(): void {
    this.lifecycle?.onHostDown();
  }

  hostUp(restarted: boolean): void {
    this.lifecycle?.onHostUp(restarted);
  }

  /** A host event as the utility process would send it. */
  emitHostEvent(event: PtyHostEvent): void {
    this.deliver?.(event);
  }
}

let tmpDir: string;

/** A node-pty stand-in that never exits on its own: a host loss ends it. */
function createMockPty(pid: number) {
  return {
    pid,
    cols: 120,
    rows: 30,
    onData: vi.fn(() => ({ dispose: () => undefined })),
    onExit: vi.fn(() => ({ dispose: () => undefined })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

function registryRow(manager: SessionManager, sessionId: string): ManagedSession | undefined {
  return (manager as unknown as { registry: { get(id: string): ManagedSession | undefined } }).registry.get(sessionId);
}

/** Main's synchronous mirror of each session's alternate-screen state. */
function altScreenMirror(manager: SessionManager): Map<string, boolean> {
  return (manager as unknown as { inAltScreen: Map<string, boolean> }).inAltScreen;
}

async function spawnSession(manager: SessionManager, taskId: string, pid: number) {
  vi.mocked(pty.spawn).mockReturnValue(createMockPty(pid) as unknown as pty.IPty);
  return manager.spawn({ taskId, command: '', cwd: tmpDir });
}

function makeManager() {
  const transport = new ControllableHostTransport();
  const manager = new SessionManager({ ptyHostTransport: transport });
  return { manager, transport };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-lifecycle-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionManager: 'pty-host-lost' lists only what the host took down", () => {
  // Red-green: emit `sessionIds` unfiltered and the suspended and
  // intentionally-ended ids appear; drop the `!session ||` arm and the removed
  // id disappears; flip the status test and the running id disappears.
  it('keeps a running row and an id with no row, and leaves out a suspended or intentionally ended one', async () => {
    const { manager, transport } = makeManager();
    const running = await spawnSession(manager, 'task-running', 101);
    const suspending = await spawnSession(manager, 'task-suspending', 102);
    const killing = await spawnSession(manager, 'task-killing', 103);
    const removed = await spawnSession(manager, 'task-removed', 104);

    // main was already ending two of them when the host died: a suspend inside
    // its exit window, a kill inside its grace.
    const suspendingRow = registryRow(manager, suspending.id);
    const killingRow = registryRow(manager, killing.id);
    if (!suspendingRow || !killingRow) throw new Error('expected both rows to exist');
    suspendingRow.status = 'suspended';
    killingRow.intentionalExit = true;
    // And one was removed outright: its row is gone, the host still holds the PTY.
    manager.remove(removed.id);
    expect(registryRow(manager, removed.id)).toBeUndefined();

    const exitListener = vi.fn();
    const lostListener = vi.fn();
    manager.on('exit', exitListener);
    manager.on('pty-host-lost', lostListener);

    transport.hostDown();

    // Control: the host held all four, and each was reported exited through
    // its own exit listener, so what the list omits it omitted on purpose.
    expect(exitListener.mock.calls.map((call) => call[0]).sort()).toEqual(
      [running.id, suspending.id, killing.id, removed.id].sort(),
    );
    expect(exitListener.mock.calls.every((call) => call[1] === PTY_HOST_LOST_EXIT_CODE)).toBe(true);

    expect(lostListener).toHaveBeenCalledTimes(1);
    // Spawn order, which is the order the client holds its handles in.
    expect(lostListener.mock.calls[0][0]).toEqual([running.id, removed.id]);
  });

  it('announces an empty list when the host held nothing', async () => {
    const { manager, transport } = makeManager();
    const lostListener = vi.fn();
    manager.on('pty-host-lost', lostListener);

    transport.hostDown();

    expect(lostListener).toHaveBeenCalledTimes(1);
    expect(lostListener.mock.calls[0][0]).toEqual([]);
  });
});

describe("SessionManager: 'pty-host-restarted'", () => {
  it('replays the focus and tap sets to the replacement host and announces the restart', async () => {
    const { manager, transport } = makeManager();
    const session = await spawnSession(manager, 'task-focused', 201);
    manager.setFocusedSessions([session.id]);
    manager.subscribeDataTap(session.id);
    const restartedListener = vi.fn();
    manager.on('pty-host-restarted', restartedListener);
    transport.posted.length = 0;

    transport.hostUp(true);

    // The new host knows nothing, so it gets what gates its output.
    expect(transport.posted).toContainEqual({ type: 'setFocused', sessionIds: [session.id] });
    expect(transport.posted).toContainEqual({ type: 'setTapped', sessionIds: [session.id] });
    expect(restartedListener).toHaveBeenCalledTimes(1);
  });

  it('does nothing for the host coming up the first time', async () => {
    const { manager, transport } = makeManager();
    const session = await spawnSession(manager, 'task-first-start', 202);
    manager.setFocusedSessions([session.id]);
    const restartedListener = vi.fn();
    manager.on('pty-host-restarted', restartedListener);
    transport.posted.length = 0;

    transport.hostUp(false);

    expect(transport.posted).toEqual([]);
    expect(restartedListener).not.toHaveBeenCalled();
  });
});

describe('SessionManager: host events for a session no longer in the registry', () => {
  // A young session's kill waits out its exit grace, so after `remove()` its
  // PTY can still paint an exit screen and the host still reports it.
  //
  // Red-green: drop the `registry.has` guard on `firstOutput` and the removed id
  // is marked emitted and 'first-output' fires for it; drop it on `altScreen` and
  // the mirror regains an entry for it.

  it('drops a firstOutput event, and still applies one for a session main holds', async () => {
    const { manager, transport } = makeManager();
    const live = await spawnSession(manager, 'task-live', 301);
    const removed = await spawnSession(manager, 'task-gone', 302);
    manager.remove(removed.id);
    const firstOutputListener = vi.fn();
    manager.on('first-output', firstOutputListener);

    transport.emitHostEvent({ type: 'firstOutput', sessionId: removed.id, inAltScreen: false });
    expect(firstOutputListener).not.toHaveBeenCalled();

    // Control: the same event for a held session is applied, so the silence
    // above is the guard and not an event that never arrives.
    transport.emitHostEvent({ type: 'firstOutput', sessionId: live.id, inAltScreen: false });
    expect(firstOutputListener).toHaveBeenCalledTimes(1);
    expect(firstOutputListener).toHaveBeenCalledWith(live.id);
  });

  it('drops an altScreen event, and still mirrors one for a session main holds', async () => {
    const { manager, transport } = makeManager();
    const live = await spawnSession(manager, 'task-live', 311);
    const removed = await spawnSession(manager, 'task-gone', 312);
    manager.remove(removed.id);

    transport.emitHostEvent({ type: 'altScreen', sessionId: removed.id, inAltScreen: true });
    expect(altScreenMirror(manager).has(removed.id)).toBe(false);

    // Control: the same event for a held session lands in the mirror and
    // stamps the first alt-screen entry.
    transport.emitHostEvent({ type: 'altScreen', sessionId: live.id, inAltScreen: true });
    expect(altScreenMirror(manager).get(live.id)).toBe(true);
    expect(registryRow(manager, live.id)?.altScreenEnteredAt).toBeTypeOf('number');
  });
});

describe('SessionManager: suspend and the last-resort scrollback scan', () => {
  // `SUSPEND_SCROLLBACK_SCAN_TIMEOUT_MS` in session-manager.ts, which is not
  // exported. Pinned here as the contract: a suspend never waits on the host's
  // scrollback longer than this, whatever the transport's default budget is.
  const SCAN_TIMEOUT_MS = 2_000;

  // Red-green: drop the `hasAgentSessionId` guard and the known-id case makes a
  // `getRawScrollback` request; drop the timeout argument and the unknown-id
  // case's request carries no options (it waits the transport's whole default
  // budget), so `toEqual({ timeoutMs: 2000 })` fails on `undefined`.

  /** Suspend a session whose mock PTY never exits, to the end of the suspend. */
  async function suspendToCompletion(manager: SessionManager, sessionId: string): Promise<void> {
    const suspending = manager.suspend(sessionId);
    // The exit sequence gets 1500 ms to end the agent, then the force-kill gets
    // 1500 ms to propagate. The mock PTY never exits, so both run out.
    await vi.advanceTimersByTimeAsync(3_100);
    await suspending;
  }

  function rawScrollbackRequests(transport: ControllableHostTransport) {
    return transport.requested.filter((request) => request.method === 'getRawScrollback');
  }

  it('asks the host for the raw scrollback, waiting at most 2 s, while the agent session id is unknown', async () => {
    const { manager, transport } = makeManager();
    const session = await spawnSession(manager, 'task-unknown-id', 401);
    expect(registryRow(manager, session.id)?.agentSessionId).toBeFalsy();
    transport.requested.length = 0;

    await suspendToCompletion(manager, session.id);

    const requests = rawScrollbackRequests(transport);
    expect(requests).toHaveLength(1);
    expect(requests[0].params).toEqual({ sessionId: session.id });
    expect(requests[0].options).toEqual({ timeoutMs: SCAN_TIMEOUT_MS });
    expect(registryRow(manager, session.id)?.status).toBe('suspended');
  });

  it('does not ask the host for the raw scrollback once the agent session id is known', async () => {
    const { manager, transport } = makeManager();
    const session = await spawnSession(manager, 'task-known-id', 402);
    // The id arrives the way a real capture does: the host reports it.
    transport.emitHostEvent({ type: 'agentSessionId', sessionId: session.id, capturedId: 'agent-session-402' });
    // Control: the capture landed, so the silence below is the guard and not an
    // id the manager never received.
    expect(registryRow(manager, session.id)?.agentSessionId).toBe('agent-session-402');
    transport.requested.length = 0;

    await suspendToCompletion(manager, session.id);

    // Any request at all, not one carrying the 2 s option: the call before the
    // fix passed no options, so a filter on the option would stay empty, and
    // green, against that code.
    expect(rawScrollbackRequests(transport)).toEqual([]);
    expect(registryRow(manager, session.id)?.status).toBe('suspended');
    expect(registryRow(manager, session.id)?.agentSessionId).toBe('agent-session-402');
  });
});
