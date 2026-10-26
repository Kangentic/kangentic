/**
 * Behavior tests for the renderer-port broker in registerSessionHandlers
 * (src/main/ipc/handlers/sessions.ts).
 *
 * Each renderer has its own MessagePort to the pty host, so typing never waits
 * on main's event loop. Main only brokers the pair: `issueRendererPort` makes a
 * `MessageChannelMain`, posts one end to the renderer and hands the other to the
 * session manager for the host. `tests/unit/terminal-input-path.test.ts` pins
 * the SOURCE TEXT of that path with regexes. This file drives the real handlers
 * with a mocked `electron` and checks what they DO:
 *
 *  1. The renderer's end is posted first, then the host's end is attached, then
 *     the teardown watch is armed.
 *  2. A post that throws (a frame torn down between the isDestroyed() check and
 *     the post) closes the host's end, attaches nothing, arms nothing, and
 *     throws nothing out.
 *  3. A destroyed target gets nothing.
 *  4. `renderer-ports-lost` (a restarted host) re-issues a port to every
 *     renderer that still exists, and one renderer's failure does not stop the
 *     loop.
 *  5. The teardown watch forgets the renderer on `destroyed` or
 *     `render-process-gone`, with the id read when the watch was set up, removes
 *     BOTH listeners, and never stacks a second pair for a live renderer.
 *  6. `SESSION_GET_SCROLLBACK` routes a numeric request id to the per-renderer
 *     answer and anything else to the plain read.
 *
 * Harness: the shape of session-removed-forwarding.test.ts (electron, the DB
 * helpers and the transition-engine chain stubbed so registerSessionHandlers
 * runs headless). The webContents fakes extend EventEmitter so `once` and
 * `removeListener` are the real ones and the listener counts mean something.
 * `MessageChannelMain` is a class because the code under test calls `new` on it.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports of the mocked modules)
// ---------------------------------------------------------------------------

type IpcHandler = (...args: unknown[]) => unknown;

const {
  createdChannels,
  MockMessageChannelMain,
  mockIpcMainOn,
  mockIpcMainHandle,
  mockFromId,
} = vi.hoisted(() => {
  interface FakePort {
    label: string;
    close: ReturnType<typeof vi.fn>;
  }
  const createdChannels: Array<{ port1: FakePort; port2: FakePort }> = [];
  class MockMessageChannelMain {
    port1: FakePort = { label: 'host-end', close: vi.fn() };
    port2: FakePort = { label: 'renderer-end', close: vi.fn() };
    constructor() {
      createdChannels.push(this);
    }
  }
  return {
    createdChannels,
    MockMessageChannelMain,
    mockIpcMainOn: vi.fn<(channel: string, listener: (...args: unknown[]) => unknown) => void>(),
    mockIpcMainHandle: vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(),
    mockFromId: vi.fn<(rendererId: number) => unknown>(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    on: mockIpcMainOn,
  },
  webContents: {
    fromId: mockFromId,
  },
  MessageChannelMain: MockMessageChannelMain,
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
    findByAnyId = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
  trackMilestone: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(() => 'main'),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/agent/message-trail-tracker', () => ({
  MessageTrailTracker: class {
    on = vi.fn();
    snapshot = vi.fn(() => ({}));
  },
}));

// Import under test AFTER all mocks are registered.
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A webContents stand-in with real `once` / `removeListener` / `listenerCount`. */
class FakeWebContents extends EventEmitter {
  postMessage = vi.fn();
  private gone = false;

  constructor(public id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.gone;
  }

  markDestroyed(): void {
    this.gone = true;
  }
}

/** Every webContents `webContents.fromId` can find, by id. */
const liveWebContents = new Map<number, FakeWebContents>();

const capturedSessionEventHandlers = new Map<string, IpcHandler[]>();

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => 'task-1' as string | null | undefined),
      getSessionProjectId: vi.fn(() => 'proj-1' as string | null | undefined),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: IpcHandler) => {
        const handlers = capturedSessionEventHandlers.get(event) ?? [];
        handlers.push(handler);
        capturedSessionEventHandlers.set(event, handlers);
      }),
      listSessions: vi.fn(() => []),
      off: vi.fn(),
      attachRendererPort: vi.fn(),
      detachRendererPort: vi.fn(),
      clearFocusedSessionsFor: vi.fn(),
      getScrollback: vi.fn(),
      getScrollbackForRenderer: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

function addRenderer(rendererId: number): FakeWebContents {
  const renderer = new FakeWebContents(rendererId);
  liveWebContents.set(rendererId, renderer);
  return renderer;
}

function findIpcOnHandler(channel: string): IpcHandler {
  const registration = mockIpcMainOn.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`ipcMain.on(${channel}) was not registered`);
  return registration[1];
}

function findIpcHandleHandler(channel: string): IpcHandler {
  const registration = mockIpcMainHandle.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!registration) throw new Error(`ipcMain.handle(${channel}) was not registered`);
  return registration[1];
}

function findPortsLostListener(): IpcHandler {
  const handlers = capturedSessionEventHandlers.get('renderer-ports-lost');
  if (!handlers || handlers.length === 0) throw new Error("sessionManager.on('renderer-ports-lost') was not registered");
  return handlers[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessions.ts renderer port broker', () => {
  let context: ReturnType<typeof createMockContext>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function requestPort(sender: FakeWebContents): void {
    findIpcOnHandler(IPC.PTY_PORT_REQUEST)({ sender });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    createdChannels.length = 0;
    liveWebContents.clear();
    mockFromId.mockImplementation((rendererId: number) => liveWebContents.get(rendererId));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    context = createMockContext();
    // A fresh registration per test also gives a fresh focusTeardownWatched set.
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  describe('PTY_PORT_REQUEST', () => {
    it('posts the renderer its end first, then hands the host the other end, then arms the teardown watch', () => {
      const renderer = addRenderer(7);

      requestPort(renderer);

      expect(createdChannels).toHaveLength(1);
      const channel = createdChannels[0];
      expect(renderer.postMessage).toHaveBeenCalledTimes(1);
      expect(renderer.postMessage).toHaveBeenCalledWith(IPC.PTY_PORT, null, [channel.port2]);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledWith(7, channel.port1);
      // Order: the post comes before the attach. An attach-before-post would
      // hand the host an end nobody holds whenever the post throws.
      expect(renderer.postMessage.mock.invocationCallOrder[0])
        .toBeLessThan(context.sessionManager.attachRendererPort.mock.invocationCallOrder[0]);
      expect(channel.port1.close).not.toHaveBeenCalled();
      expect(channel.port2.close).not.toHaveBeenCalled();
      // The teardown watch is armed after a successful hand-off.
      expect(renderer.listenerCount('destroyed')).toBe(1);
      expect(renderer.listenerCount('render-process-gone')).toBe(1);
    });

    it('closes the host end, attaches nothing, arms no watch and throws nothing when the post throws', () => {
      const renderer = addRenderer(7);
      renderer.postMessage.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });

      expect(() => requestPort(renderer)).not.toThrow();

      expect(createdChannels).toHaveLength(1);
      expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).not.toHaveBeenCalled();
      // A watch armed before the post would leave a pair of listeners on a
      // renderer that was never attached.
      expect(renderer.listenerCount('destroyed')).toBe(0);
      expect(renderer.listenerCount('render-process-gone')).toBe(0);
    });

    it('gives a destroyed target nothing: no channel, no post, no attach, no listeners', () => {
      const renderer = addRenderer(7);
      renderer.markDestroyed();

      requestPort(renderer);

      expect(createdChannels).toHaveLength(0);
      expect(renderer.postMessage).not.toHaveBeenCalled();
      expect(context.sessionManager.attachRendererPort).not.toHaveBeenCalled();
      expect(renderer.listenerCount('destroyed')).toBe(0);
      expect(renderer.listenerCount('render-process-gone')).toBe(0);
    });

    it('gives a second request from the same live renderer a fresh channel without a second pair of listeners', () => {
      const renderer = addRenderer(7);

      requestPort(renderer);
      requestPort(renderer);

      expect(createdChannels).toHaveLength(2);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledTimes(2);
      expect(context.sessionManager.attachRendererPort).toHaveBeenNthCalledWith(1, 7, createdChannels[0].port1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenNthCalledWith(2, 7, createdChannels[1].port1);
      expect(createdChannels[0].port1).not.toBe(createdChannels[1].port1);
      expect(renderer.listenerCount('destroyed')).toBe(1);
      expect(renderer.listenerCount('render-process-gone')).toBe(1);
    });
  });

  describe("sessionManager 'renderer-ports-lost' (a restarted host)", () => {
    it('re-issues a port to every renderer id, each posted its end and attached by its own id', () => {
      const firstRenderer = addRenderer(4);
      const secondRenderer = addRenderer(5);

      findPortsLostListener()([4, 5]);

      expect(mockFromId).toHaveBeenCalledWith(4);
      expect(mockFromId).toHaveBeenCalledWith(5);
      expect(createdChannels).toHaveLength(2);
      expect(firstRenderer.postMessage).toHaveBeenCalledWith(IPC.PTY_PORT, null, [createdChannels[0].port2]);
      expect(secondRenderer.postMessage).toHaveBeenCalledWith(IPC.PTY_PORT, null, [createdChannels[1].port2]);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledTimes(2);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledWith(4, createdChannels[0].port1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledWith(5, createdChannels[1].port1);
    });

    it('skips an id with no webContents and keeps going', () => {
      const survivingRenderer = addRenderer(9);

      expect(() => findPortsLostListener()([8, 9])).not.toThrow();

      expect(mockFromId).toHaveBeenCalledWith(8);
      expect(createdChannels).toHaveLength(1);
      expect(survivingRenderer.postMessage).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledWith(9, createdChannels[0].port1);
    });

    it('does not stop at a renderer whose post throws: later renderers still get their port', () => {
      const failingRenderer = addRenderer(1);
      failingRenderer.postMessage.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      // Id 2 has no webContents at all.
      const healthyRenderer = addRenderer(3);

      expect(() => findPortsLostListener()([1, 2, 3])).not.toThrow();

      // The failing renderer's channel was made, its host end closed, nothing attached for it.
      expect(createdChannels).toHaveLength(2);
      expect(createdChannels[0].port1.close).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).not.toHaveBeenCalledWith(1, expect.anything());
      // The renderer AFTER the failure still got its port.
      expect(healthyRenderer.postMessage).toHaveBeenCalledWith(IPC.PTY_PORT, null, [createdChannels[1].port2]);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.attachRendererPort).toHaveBeenCalledWith(3, createdChannels[1].port1);
      expect(createdChannels[1].port1.close).not.toHaveBeenCalled();
    });
  });

  describe('renderer teardown watch', () => {
    it.each(['destroyed', 'render-process-gone'])(
      'forgets the renderer on %s and removes BOTH listeners, so nothing stays behind and a later event does nothing',
      (firstEvent) => {
        const renderer = addRenderer(7);
        requestPort(renderer);
        const otherEvent = firstEvent === 'destroyed' ? 'render-process-gone' : 'destroyed';

        renderer.emit(firstEvent, {}, { reason: 'crashed' });

        expect(context.sessionManager.clearFocusedSessionsFor).toHaveBeenCalledTimes(1);
        expect(context.sessionManager.clearFocusedSessionsFor).toHaveBeenCalledWith(7);
        expect(context.sessionManager.detachRendererPort).toHaveBeenCalledTimes(1);
        expect(context.sessionManager.detachRendererPort).toHaveBeenCalledWith(7);
        // The listener of the event that did NOT fire is the one a missing
        // removeListener would leave behind.
        expect(renderer.listenerCount(firstEvent)).toBe(0);
        expect(renderer.listenerCount(otherEvent)).toBe(0);

        renderer.emit(otherEvent, {}, { reason: 'crashed' });

        expect(context.sessionManager.clearFocusedSessionsFor).toHaveBeenCalledTimes(1);
        expect(context.sessionManager.detachRendererPort).toHaveBeenCalledTimes(1);
      },
    );

    it('uses the id captured when the watch was set up, not whatever the webContents answers at teardown', () => {
      const renderer = addRenderer(7);
      requestPort(renderer);
      // A destroyed webContents no longer answers for its id.
      renderer.id = 999;

      renderer.emit('destroyed');

      expect(context.sessionManager.clearFocusedSessionsFor).toHaveBeenCalledWith(7);
      expect(context.sessionManager.detachRendererPort).toHaveBeenCalledWith(7);
      expect(context.sessionManager.clearFocusedSessionsFor).not.toHaveBeenCalledWith(999);
      expect(context.sessionManager.detachRendererPort).not.toHaveBeenCalledWith(999);
    });

    it('re-arms the watch after a crash, so a renderer that crashes and reloads repeatedly is forgotten each time without gathering listeners', () => {
      const renderer = addRenderer(7);

      requestPort(renderer);
      renderer.emit('render-process-gone', {}, { reason: 'crashed' });
      // The reloaded page asks again.
      requestPort(renderer);

      expect(renderer.listenerCount('destroyed')).toBe(1);
      expect(renderer.listenerCount('render-process-gone')).toBe(1);

      renderer.emit('render-process-gone', {}, { reason: 'crashed' });

      expect(context.sessionManager.detachRendererPort).toHaveBeenCalledTimes(2);
      expect(context.sessionManager.detachRendererPort).toHaveBeenNthCalledWith(1, 7);
      expect(context.sessionManager.detachRendererPort).toHaveBeenNthCalledWith(2, 7);
      expect(context.sessionManager.clearFocusedSessionsFor).toHaveBeenCalledTimes(2);
      expect(renderer.listenerCount('destroyed')).toBe(0);
      expect(renderer.listenerCount('render-process-gone')).toBe(0);
    });

    it('watches each renderer on its own: tearing one down leaves another renderer attached and watched', () => {
      const closingRenderer = addRenderer(7);
      const survivingRenderer = addRenderer(8);
      requestPort(closingRenderer);
      requestPort(survivingRenderer);

      closingRenderer.emit('destroyed');

      expect(context.sessionManager.detachRendererPort).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.detachRendererPort).toHaveBeenCalledWith(7);
      expect(survivingRenderer.listenerCount('destroyed')).toBe(1);
      expect(survivingRenderer.listenerCount('render-process-gone')).toBe(1);
    });
  });

  describe('SESSION_GET_SCROLLBACK', () => {
    it('answers a numeric request id through the per-renderer path, keyed by the asking renderer', () => {
      context.sessionManager.getScrollbackForRenderer.mockReturnValue('answered-on-port');
      const handler = findIpcHandleHandler(IPC.SESSION_GET_SCROLLBACK);

      const result = handler({ sender: { id: 7 } }, 'sess-1', 42);

      expect(context.sessionManager.getScrollbackForRenderer).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.getScrollbackForRenderer).toHaveBeenCalledWith('sess-1', 7, 42);
      expect(context.sessionManager.getScrollback).not.toHaveBeenCalled();
      expect(result).toBe('answered-on-port');
    });

    it('treats request id 0 as numeric: 0 is a valid id, not "no request id"', () => {
      context.sessionManager.getScrollbackForRenderer.mockReturnValue('answered-on-port');
      const handler = findIpcHandleHandler(IPC.SESSION_GET_SCROLLBACK);

      handler({ sender: { id: 7 } }, 'sess-1', 0);

      expect(context.sessionManager.getScrollbackForRenderer).toHaveBeenCalledWith('sess-1', 7, 0);
      expect(context.sessionManager.getScrollback).not.toHaveBeenCalled();
    });

    it('reads the plain scrollback when no request id is given', () => {
      context.sessionManager.getScrollback.mockReturnValue('plain-scrollback');
      const handler = findIpcHandleHandler(IPC.SESSION_GET_SCROLLBACK);

      const result = handler({ sender: { id: 7 } }, 'sess-1');

      expect(context.sessionManager.getScrollback).toHaveBeenCalledTimes(1);
      expect(context.sessionManager.getScrollback).toHaveBeenCalledWith('sess-1');
      expect(context.sessionManager.getScrollbackForRenderer).not.toHaveBeenCalled();
      expect(result).toBe('plain-scrollback');
    });
  });
});
