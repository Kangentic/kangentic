/**
 * Unit tests for the renderer subscribe/teardown wiring inside
 * `registerMonitorHandlers`'s `MONITOR_SET_PEEK_SUBSCRIBED` handler
 * (src/main/ipc/handlers/monitor.ts).
 *
 * The regression this protects: the handler used to re-register
 * `sender.once('destroyed', ...)` on every subscribe call, so a monitor
 * overlay that mounts/unmounts repeatedly on the SAME long-lived webContents
 * (the main window, which never closes across a dogfooding session) stacked
 * one 'destroyed' listener per open. `peekTeardownWatched` guards that: this
 * file proves the guard, the did-start-navigation reload-vs-same-document
 * gating, and the destroyed/render-process-gone teardown paths against the
 * REAL `ipcMain.handle` registration and a real `EventEmitter` standing in
 * for webContents - mirrors the pattern in
 * tests/unit/task-detail-ownership-handlers.test.ts.
 *
 * `MonitorPeekTracker` itself (the sampling / change-gate logic) is mocked
 * out - it already has full coverage in tests/unit/monitor-peek-tracker.test.ts.
 * This file is scoped to the wiring AROUND it: the Set-keyed dedup and the
 * three teardown event routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Hoisted mocks
//
// electron is mocked broadly enough to satisfy the whole import chain
// registerMonitorHandlers pulls in via `broadcast` (window-broadcast ->
// pop-out-window-manager -> window-utils), none of which is exercised by
// these tests - only their module-level imports need to resolve without
// throwing.
// ---------------------------------------------------------------------------

const { mockHandle } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: vi.fn() },
  BrowserWindow: class {},
  nativeImage: {},
  app: { isPackaged: false, getAppPath: () => '', getPath: () => '' },
  screen: {},
}));

const { mockSubscribe, mockUnsubscribe } = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockUnsubscribe: vi.fn(),
}));

vi.mock('../../src/main/monitor/monitor-peek-tracker', () => ({
  MonitorPeekTracker: class {
    subscribe(rendererId: number): void {
      mockSubscribe(rendererId);
    }
    unsubscribe(rendererId: number): void {
      mockUnsubscribe(rendererId);
    }
  },
}));

vi.mock('../../src/main/monitor/monitor-aggregator', () => ({
  buildMonitorSnapshot: vi.fn(() => ({ rows: [], generatedAt: '2026-01-01T00:00:00.000Z' })),
}));

vi.mock('../../src/main/monitor/task-detail-bundle', () => ({
  buildTaskDetailBundle: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerMonitorHandlers } from '../../src/main/ipc/handlers/monitor';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Stands in for a renderer's webContents. A real EventEmitter so
 *  `.once('destroyed', ...)` / `.on('did-start-navigation', ...)` behave
 *  exactly like the production listeners, once-semantics included. */
class FakeWebContents extends EventEmitter {
  readonly id: number;

  constructor(webContentsId: number) {
    super();
    this.id = webContentsId;
  }
}

interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

type SetPeekSubscribedHandler = (event: { sender: FakeWebContents }, subscribed: boolean) => void;

function getSubscribeHandler(): SetPeekSubscribedHandler {
  const registeredCall = mockHandle.mock.calls.find((call) => call[0] === IPC.MONITOR_SET_PEEK_SUBSCRIBED);
  if (!registeredCall) throw new Error('MONITOR_SET_PEEK_SUBSCRIBED handler was not registered');
  return registeredCall[1] as SetPeekSubscribedHandler;
}

function makeContext(): IpcContext {
  return {
    mainWindow: { isDestroyed: () => false },
    sessionManager: { on: vi.fn(), off: vi.fn() },
    boardEvents: { onBoardChanged: vi.fn() },
  } as unknown as IpcContext;
}

beforeEach(() => {
  mockHandle.mockReset();
  mockSubscribe.mockReset();
  mockUnsubscribe.mockReset();
  // Registered fresh per test: peekTeardownWatched is a closure-local Set
  // created inside registerMonitorHandlers, so a new call starts with an
  // empty guard - no vi.resetModules() needed.
  registerMonitorHandlers(makeContext());
});

describe('MONITOR_SET_PEEK_SUBSCRIBED - renderer subscribe/teardown wiring', () => {
  it('subscribing twice for the SAME sender id registers the destroyed hook exactly once (regression guard)', () => {
    // Pre-fix, this handler called `sender.once('destroyed', forget)` on
    // every subscribe with no dedup, so two subscribes from the same
    // renderer (the monitor overlay mounting twice on the main window)
    // stacked two 'destroyed' listeners. peekTeardownWatched is what makes
    // this assertion 1, not 2.
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(1);

    handler({ sender }, true);
    handler({ sender }, true);

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(sender.listenerCount('destroyed')).toBe(1);
    expect(sender.listenerCount('render-process-gone')).toBe(1);
    expect(sender.listenerCount('did-start-navigation')).toBe(1);
  });

  it('a reload (did-start-navigation, main frame, not same-document) unsubscribes', () => {
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(2);
    handler({ sender }, true);
    mockUnsubscribe.mockClear();

    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false } satisfies NavigationDetails);

    expect(mockUnsubscribe).toHaveBeenCalledWith(2);
  });

  it('a same-document navigation (hash change) does NOT unsubscribe', () => {
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(3);
    handler({ sender }, true);
    mockUnsubscribe.mockClear();

    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true } satisfies NavigationDetails);

    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("firing 'destroyed' unsubscribes", () => {
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(4);
    handler({ sender }, true);
    mockUnsubscribe.mockClear();

    sender.emit('destroyed');

    expect(mockUnsubscribe).toHaveBeenCalledWith(4);
  });

  it("firing 'render-process-gone' also unsubscribes", () => {
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(5);
    handler({ sender }, true);
    mockUnsubscribe.mockClear();

    sender.emit('render-process-gone');

    expect(mockUnsubscribe).toHaveBeenCalledWith(5);
  });

  it("teardown re-arms the guard: after 'destroyed', a FRESH sender carrying the same renderer id gets its own listeners", () => {
    // Pins `peekTeardownWatched.delete(rendererId)` inside forget(). Without
    // it, the guard keeps the id forever, and a later subscribe under the
    // SAME renderer id (webContents ids are reused after the original is
    // destroyed) would silently get zero teardown hooks - permanently
    // unteardownable, and the exact class of leak this Set exists to fix.
    const handler = getSubscribeHandler();
    const firstSender = new FakeWebContents(6);
    handler({ sender: firstSender }, true);
    firstSender.emit('destroyed');

    const secondSender = new FakeWebContents(6);
    handler({ sender: secondSender }, true);

    expect(secondSender.listenerCount('destroyed')).toBe(1);
  });

  it('subscribed=false calls unsubscribe directly without registering any teardown hooks', () => {
    const handler = getSubscribeHandler();
    const sender = new FakeWebContents(7);

    handler({ sender }, false);

    expect(mockUnsubscribe).toHaveBeenCalledWith(7);
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
});
