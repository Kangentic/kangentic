/**
 * Unit tests for the subscriber gate in `registerMonitorHandlers`
 * (src/main/ipc/handlers/monitor.ts).
 *
 * #464 finding 2: `schedulePush` used to build and broadcast the full
 * cross-project snapshot on EVERY session event, monitor mounted or not, so
 * with the monitor closed every spawn/exit/board change still paid the
 * per-session DB reads, the serialization, and each renderer's
 * structured-clone deserialization. The gate makes the push pipeline
 * subscription-driven: main builds only while at least one renderer holds a
 * live `monitor:subscribe` registration, and the subscription handshake
 * returns a fresh snapshot so a mounting monitor needs no catch-up push.
 *
 * `electron` is mocked (ipcMain + a fake WebContents on an EventEmitter, same
 * pattern as task-detail-ownership-handlers.test.ts); the aggregator and
 * broadcast are mocked so the assertions are about WHEN they run, not what
 * they produce. Timers are faked to step through the 250ms debounce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockHandle, mockBroadcast, mockBuildSnapshot } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockBroadcast: vi.fn(),
  mockBuildSnapshot: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle },
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: mockBroadcast,
}));

vi.mock('../../src/main/monitor/monitor-aggregator', () => ({
  buildMonitorSnapshot: mockBuildSnapshot,
}));

vi.mock('../../src/main/monitor/task-detail-bundle', () => ({
  buildTaskDetailBundle: vi.fn(),
}));

import { registerMonitorHandlers } from '../../src/main/ipc/handlers/monitor';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

interface FakeNavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

type InvokeHandler = (event: { sender: FakeWebContents }) => unknown;

function makeContext(): { context: IpcContext; fireSessionChanged: () => void; fireSessionRemoved: () => void } {
  const sessionEvents = new EventEmitter();
  const context = {
    mainWindow: { isDestroyed: () => false },
    sessionManager: {
      on: (event: string, listener: () => void) => sessionEvents.on(event, listener),
    },
    boardEvents: {
      onBoardChanged: (listener: () => void) => sessionEvents.on('board-changed', listener),
    },
  } as unknown as IpcContext;
  return {
    context,
    fireSessionChanged: () => sessionEvents.emit('session-changed'),
    fireSessionRemoved: () => sessionEvents.emit('session-removed'),
  };
}

function getHandler(channel: string): InvokeHandler {
  const registration = mockHandle.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`No ipcMain.handle registration for ${channel}`);
  return registration[1] as InvokeHandler;
}

const MONITOR_PUSH_DEBOUNCE_MS = 250;

beforeEach(() => {
  vi.useFakeTimers();
  mockHandle.mockClear();
  mockBroadcast.mockClear();
  mockBuildSnapshot.mockClear();
  mockBuildSnapshot.mockResolvedValue({ rows: [], generatedAt: '2026-01-01T00:00:00.000Z' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('monitor push gate', () => {
  it('with no subscriber, a session event builds and pushes nothing', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);

    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('subscribe returns a snapshot and turns the push pipeline on', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    const snapshot = await getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    expect(snapshot).toEqual({ rows: [], generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(mockBuildSnapshot).toHaveBeenCalledTimes(1);

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][1]).toBe(IPC.MONITOR_CHANGED);
  });

  it('a session removal schedules a push, so a detached monitor re-lists and drops the row', async () => {
    // A direct remove (project delete, SESSION_RESET, an aborted spawn) has no
    // 'exit' to ride, and the detached monitor's session store refreshes only
    // on MONITOR_CHANGED. Dropping this subscription leaves that window holding
    // a row main no longer has.
    const { context, fireSessionRemoved } = makeContext();
    registerMonitorHandlers(context);
    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender: new FakeWebContents(7) });
    mockBroadcast.mockClear();

    fireSessionRemoved();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][1]).toBe(IPC.MONITOR_CHANGED);
  });

  it('unsubscribe turns the pipeline back off', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    getHandler(IPC.MONITOR_UNSUBSCRIBE)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a subscriber vanishing INSIDE the debounce window skips the deferred build', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(100);
    getHandler(IPC.MONITOR_UNSUBSCRIBE)({ sender });
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS);

    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a destroyed renderer drops its subscription without an unsubscribe call', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('destroyed');
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a crashed renderer (render-process-gone) drops its subscription', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('render-process-gone');
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a hard reload (main-frame did-start-navigation) drops the subscription; same-document does not', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true } satisfies FakeNavigationDetails);
    mockBuildSnapshot.mockClear();
    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);

    mockBroadcast.mockClear();
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false } satisfies FakeNavigationDetails);
    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('re-subscribing after a reload works and never stacks navigation listeners', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);
    const subscribe = getHandler(IPC.MONITOR_SUBSCRIBE);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      subscribe({ sender });
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false } satisfies FakeNavigationDetails);
    }
    expect(sender.listenerCount('did-start-navigation')).toBe(1);

    subscribe({ sender });
    mockBroadcast.mockClear();
    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('the plain getSnapshot fetch does not subscribe', async () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_GET_SNAPSHOT)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

interface FakeSnapshot {
  rows: unknown[];
  generatedAt: string;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * A push build awaits the pty host's output peeks, so two builds started one
 * debounce window apart can settle in either order. The handler numbers each
 * build and refuses to broadcast one older than the newest it has already
 * broadcast, so a slow build can never overwrite a fresher snapshot.
 *
 * Red-green: remove the `build < newestBroadcastBuild` check in `schedulePush`
 * and the older snapshot becomes a second broadcast after the newer one, which
 * is the first test's final assertion (and the last test's count).
 */
describe('monitor push ordering', () => {
  const OLDER_SNAPSHOT: FakeSnapshot = { rows: [], generatedAt: '2026-01-01T00:00:01.000Z' };
  const NEWER_SNAPSHOT: FakeSnapshot = { rows: [], generatedAt: '2026-01-01T00:00:02.000Z' };

  /**
   * One subscribed renderer, then two debounce windows that each start a build
   * whose promise the test settles by hand. The second event fires after the
   * first window has, because an event inside a pending window is coalesced.
   */
  async function startTwoBuilds() {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    await getHandler(IPC.MONITOR_SUBSCRIBE)({ sender: new FakeWebContents(7) });
    mockBuildSnapshot.mockClear();
    mockBroadcast.mockClear();
    const olderBuild = createDeferred<FakeSnapshot>();
    const newerBuild = createDeferred<FakeSnapshot>();
    mockBuildSnapshot.mockReturnValueOnce(olderBuild.promise).mockReturnValueOnce(newerBuild.promise);

    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);
    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);

    // Control: both builds are in flight and nothing has been broadcast yet.
    expect(mockBuildSnapshot).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).not.toHaveBeenCalled();
    return { olderBuild, newerBuild, fireSessionChanged };
  }

  /** Settle a hand-controlled build and let its `.then` handler run. */
  async function settle(build: Deferred<FakeSnapshot>, snapshot: FakeSnapshot): Promise<void> {
    build.resolve(snapshot);
    await vi.advanceTimersByTimeAsync(0);
  }

  function broadcastPayloads(): unknown[] {
    return mockBroadcast.mock.calls.map((call) => call[2]);
  }

  it('does not broadcast a build that resolves after a newer build has broadcast', async () => {
    const { olderBuild, newerBuild } = await startTwoBuilds();

    await settle(newerBuild, NEWER_SNAPSHOT);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][1]).toBe(IPC.MONITOR_CHANGED);
    expect(broadcastPayloads()[0]).toBe(NEWER_SNAPSHOT);

    // Non-occurrence cannot be polled for: the older build has settled and its
    // handler has run (the settle above flushes it), so the count is final.
    await settle(olderBuild, OLDER_SNAPSHOT);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcastPayloads()).toEqual([NEWER_SNAPSHOT]);
  });

  it('broadcasts both builds, in order, when the older one lands first', async () => {
    // Control: the gate drops only a build that is older than one already
    // broadcast, so an in-order pair is untouched.
    const { olderBuild, newerBuild } = await startTwoBuilds();

    await settle(olderBuild, OLDER_SNAPSHOT);
    await settle(newerBuild, NEWER_SNAPSHOT);

    expect(broadcastPayloads()).toEqual([OLDER_SNAPSHOT, NEWER_SNAPSHOT]);
  });

  it('keeps broadcasting later builds after it has dropped a stale one', async () => {
    const { olderBuild, newerBuild, fireSessionChanged } = await startTwoBuilds();
    await settle(newerBuild, NEWER_SNAPSHOT);
    await settle(olderBuild, OLDER_SNAPSHOT);
    expect(broadcastPayloads()).toEqual([NEWER_SNAPSHOT]);

    const latestSnapshot: FakeSnapshot = { rows: [], generatedAt: '2026-01-01T00:00:03.000Z' };
    mockBuildSnapshot.mockResolvedValueOnce(latestSnapshot);
    fireSessionChanged();
    await vi.advanceTimersByTimeAsync(MONITOR_PUSH_DEBOUNCE_MS + 50);

    expect(broadcastPayloads()).toEqual([NEWER_SNAPSHOT, latestSnapshot]);
  });
});
