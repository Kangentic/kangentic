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

function makeContext(): { context: IpcContext; fireSessionChanged: () => void } {
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
  mockBuildSnapshot.mockReturnValue({ rows: [], generatedAt: '2026-01-01T00:00:00.000Z' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('monitor push gate', () => {
  it('with no subscriber, a session event builds and pushes nothing', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);

    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('subscribe returns a snapshot and turns the push pipeline on', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    const snapshot = getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    expect(snapshot).toEqual({ rows: [], generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(mockBuildSnapshot).toHaveBeenCalledTimes(1);

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][1]).toBe(IPC.MONITOR_CHANGED);
  });

  it('unsubscribe turns the pipeline back off', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    getHandler(IPC.MONITOR_UNSUBSCRIBE)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a subscriber vanishing INSIDE the debounce window skips the deferred build', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    vi.advanceTimersByTime(100);
    getHandler(IPC.MONITOR_UNSUBSCRIBE)({ sender });
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS);

    expect(mockBuildSnapshot).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a destroyed renderer drops its subscription without an unsubscribe call', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('destroyed');
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a crashed renderer (render-process-gone) drops its subscription', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('render-process-gone');
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a hard reload (main-frame did-start-navigation) drops the subscription; same-document does not', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_SUBSCRIBE)({ sender });
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true } satisfies FakeNavigationDetails);
    mockBuildSnapshot.mockClear();
    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);

    mockBroadcast.mockClear();
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false } satisfies FakeNavigationDetails);
    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('re-subscribing after a reload works and never stacks navigation listeners', () => {
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
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('the plain getSnapshot fetch does not subscribe', () => {
    const { context, fireSessionChanged } = makeContext();
    registerMonitorHandlers(context);
    const sender = new FakeWebContents(7);

    getHandler(IPC.MONITOR_GET_SNAPSHOT)({ sender });
    mockBuildSnapshot.mockClear();

    fireSessionChanged();
    vi.advanceTimersByTime(MONITOR_PUSH_DEBOUNCE_MS + 50);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
