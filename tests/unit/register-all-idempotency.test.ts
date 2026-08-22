/**
 * Unit tests for registerAllIpc idempotency guard.
 *
 * On macOS, closing all windows doesn't quit the app. Re-clicking the dock
 * icon fires `activate` → `createWindow()` → `registerAllIpc()` again.
 * The idempotency guard must update the window reference without
 * re-registering ipcMain.handle handlers (which throws on duplicates).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KANGENTIC_HOSTED_RELAY_URL } from '../../src/shared/relay';
import { IPC } from '../../src/shared/ipc-channels';
import type { RendererErrorContext } from '../../src/shared/types';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockHandle = vi.fn();
const mockOn = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      readdir: vi.fn(() => Promise.resolve([])),
      rm: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'mock-uuid') }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/project-group-repository', () => ({
  ProjectGroupRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getLatestForTask = vi.fn(); updateStatus = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { getTransitionsFor = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list = vi.fn(() => []); getById = vi.fn(); },
}));
vi.mock('../../src/main/pty/session-manager', () => {
  const { EventEmitter } = require('node:events');
  return {
    SessionManager: class extends EventEmitter {
      listSessions = vi.fn(() => []);
      spawn = vi.fn();
      kill = vi.fn();
    },
  };
});
vi.mock('../../src/main/agent/adapters/claude/detector', () => ({
  ClaudeDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/git/git-detector', () => ({
  GitDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
// Hoisted (not an inline factory closure) so a single test can override its
// return value for one call via mockReturnValueOnce, e.g. to pin the startup
// reconcile against a persisted mobileBridge.enabled: true.
const getEffectiveConfigMock = vi.fn(() => ({ claude: {}, git: {}, terminal: {} }));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig = getEffectiveConfigMock; },
}));
vi.mock('../../src/main/config/board-config-manager', () => ({
  BoardConfigManager: class {
    constructor() {}
    attach = vi.fn();
    detach = vi.fn();
  },
}));
vi.mock('../../src/main/transition-engine/terminal-submit-scheduler', () => ({
  TerminalSubmitScheduler: class {
    constructor() {}
    cancelAll = vi.fn();
  },
}));
vi.mock('../../src/main/pty/terminal-submit', () => ({
  TerminalSubmit: class {
    constructor() {}
    submitContent = vi.fn();
    submitKeystrokes = vi.fn();
  },
}));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => ({
  ShellResolver: class { resolve = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(),
}));
vi.mock('../../src/main/agent/adapters/claude/hook-manager', () => ({
  buildHooks: vi.fn(),
  removeHooks: vi.fn(),
}));
// Must mirror every export register-all.ts imports from this module. A missing one
// is invisible here (this suite only counts registrations, it never invokes a
// handler) but throws "is not a function" the moment a test calls one.
//
// `summarizeComponentStack` is deliberately NOT importOriginal'd here: the real
// analytics.ts module-level-imports `@aptabase/electron/main`, a real node_modules
// package whose own internal `from 'electron'` import is externalized by vitest
// (bypasses the `vi.mock('electron', ...)` above entirely) and resolves to the
// real 'electron' npm shim, which has no named exports outside a real Electron
// process - importOriginal here throws "Named export 'ipcMain' not found" for
// EVERY test in this file, not just the new ones. So it stays a stub, but a
// deliberately non-constant one: it returns a fixed non-empty trail only when
// handed a non-empty string, so the TRACK_RENDERER_ERROR handler's
// `if (components) props.components = ...` conditional is exercised truthfully
// in both directions without duplicating the real regex coverage already
// pinned in tests/unit/summarize-component-stack.test.ts.
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
  summarizeComponentStack: vi.fn((stack: string | undefined) =>
    typeof stack === 'string' && stack.length > 0 ? 'Foo < Bar' : ''
  ),
  MAX_ANALYTICS_STRING_LENGTH: 180,
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));

// registerAllIpc calls retrievalService.attach(context) directly at startup
// (so the central embedding engine's drain loop is alive from boot, not just
// on the first project:open). Left unmocked, the real
// retrievalService.attach() pulls in the full retrieval subsystem
// (ConversationIndexer -> the real agent-registry -> every agent adapter) and
// subscribes to context.sessionManager events - the same isolation problem
// config-handler-wiring.test.ts hit and stubs away for the same reason.
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: {
    attach: vi.fn(),
    startForProject: vi.fn(),
    reconcileEmbedWorker: vi.fn(),
    getStatus: vi.fn(),
    getEmbedder: vi.fn(),
    stop: vi.fn(),
    purgeProjectIndex: vi.fn(),
    rebuildProjectIndex: vi.fn(),
    dispose: vi.fn(),
  },
}));

// Mock every handler-registration function that `registerAllIpc` imports.
// If `register-all.ts` grows a new `registerXxxHandlers` call, add a mock
// here - otherwise the real implementation runs, pulls its full dependency
// graph into the test worker, and the import either times out or pollutes
// parallel test files' module state.
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  registerProjectHandlers: vi.fn(),
  cleanupProject: vi.fn(),
  deleteProjectFromIndex: vi.fn(),
  pruneStaleWorktreeProjects: vi.fn(),
  openProjectByPath: vi.fn(),
  activateAllProjects: vi.fn(),
  getLastOpenedProject: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-crud', () => ({
  registerTaskCrudHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-archive', () => ({
  registerTaskArchiveHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  registerTaskMoveHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-branch', () => ({
  registerTaskBranchHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({
  registerTaskRuntimeOverrideHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({
  registerSessionHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/transient-sessions', () => ({
  registerTransientSessionHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/board', () => ({
  registerBoardHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({
  registerBacklogHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-diff', () => ({
  registerGitDiffHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/system', () => ({
  registerSystemHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/mobile-bridge', () => ({
  registerMobileBridgeHandlers: vi.fn(),
}));

// MobileBridgeService is constructed directly by register-all.ts (unlike the
// other services above, which are all injected via a registerXHandlers mock),
// so it needs its own lightweight class mock: a real .reconcile() spy to
// assert the effective-config wiring below, and no real fs/electron/identity
// work (the real class already covers that in mobile-bridge-service.test.ts).
const mobileBridgeReconcileSpy = vi.fn();
const mobileBridgeDisposeSpy = vi.fn();
const mobileBridgeAttachContextSpy = vi.fn();
vi.mock('../../src/main/mobile-bridge/mobile-bridge-service', () => ({
  MobileBridgeService: class {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    attachContext = mobileBridgeAttachContextSpy;
    reconcile = mobileBridgeReconcileSpy;
    dispose = mobileBridgeDisposeSpy;
    on = vi.fn();
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMockWindow(id: number) {
  return { id, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('registerAllIpc idempotency', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mobileBridgeReconcileSpy.mockClear();
    mobileBridgeDisposeSpy.mockClear();
    getEffectiveConfigMock.mockClear();
    // Reset the module-level `context` singleton between tests
    vi.resetModules();
  });

  // These tests vi.resetModules() then re-import the entire main-process IPC
  // graph (even with everything mocked, vitest re-transforms the module tree).
  // The default 5s timeout is too tight when the machine is under load (a
  // dogfooding `npm start` plus the full 4773-test suite starve CPU and the
  // re-import alone can exceed 5s). The explicit 30s timeout on each test keeps
  // them green under load; they still complete in ~1s when run scoped.
  it('first call initializes context and registers handlers', async () => {
    const { registerAllIpc, getSessionManager, getOptionalIpcContext } = await import('../../src/main/ipc/register-all');
    const { registerProjectHandlers } = await import('../../src/main/ipc/handlers/projects');
    const { registerTaskCrudHandlers } = await import('../../src/main/ipc/handlers/task-crud');
    const { registerTaskArchiveHandlers } = await import('../../src/main/ipc/handlers/task-archive');
    const { registerTaskMoveHandlers } = await import('../../src/main/ipc/handlers/task-move');
    const { registerTaskBranchHandlers } = await import('../../src/main/ipc/handlers/task-branch');
    const { registerTaskRuntimeOverrideHandlers } = await import('../../src/main/ipc/handlers/task-runtime-override');
    const { registerMobileBridgeHandlers } = await import('../../src/main/ipc/handlers/mobile-bridge');
    const { retrievalService } = await import('../../src/main/retrieval/retrieval-service');

    const window = makeMockWindow(1);
    registerAllIpc(window);

    // Handler registration functions were called
    expect(registerProjectHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskCrudHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskArchiveHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskMoveHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskBranchHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskRuntimeOverrideHandlers).toHaveBeenCalledTimes(1);
    expect(registerMobileBridgeHandlers).toHaveBeenCalledTimes(1);

    // The central embedding engine's drain loop is started at boot (not just
    // lazily on the first project:open), so the drain loop is already alive
    // before any project is opened.
    expect(retrievalService.attach).toHaveBeenCalledTimes(1);

    // MobileBridgeService.reconcile() is called once at startup with the
    // real effective config's mobileBridge fields resolved through
    // resolveRelayUrl() (defaulted, since the mocked
    // ConfigManager.getEffectiveConfig() here returns no mobileBridge key) -
    // not left at the { enabled: false, relayUrl: '' } placeholder the
    // constructor takes before configManager is available, and not the raw
    // '' relayUrl either: resolveRelayUrl() never returns '', it infers
    // 'hosted' mode from the missing mobileBridge key and falls back to the
    // hosted relay (src/shared/relay.ts).
    expect(mobileBridgeReconcileSpy).toHaveBeenCalledTimes(1);
    expect(mobileBridgeReconcileSpy).toHaveBeenCalledWith({
      enabled: false,
      relayUrl: KANGENTIC_HOSTED_RELAY_URL,
    });

    // attachContext() wires the capability-verb handlers and must run once,
    // before reconcile() (which drives syncSessions()) so the first sync has
    // handlers to route into.
    expect(mobileBridgeAttachContextSpy).toHaveBeenCalledTimes(1);

    // Context is initialized (wrappers don't throw)
    expect(() => getSessionManager()).not.toThrow();

    // The desktop notifier is constructed, wired into IpcContext, and
    // start()-ed exactly once, attaching one 'activity' and one 'exit'
    // listener to the real (unmocked) SessionManager EventEmitter. The
    // ActivityIntervalRecorder (also real and unmocked here - it is
    // constructed and .start()-ed the same way as desktopNotifier, just
    // below it in register-all.ts) attaches its own 'activity'/'exit' pair
    // to write the session_activity_intervals ledger.
    //
    // The counts are DIFFERENT and that asymmetry is the point:
    //   activity: desktopNotifier (1) + activityIntervalRecorder (1)       = 2
    //   exit:     those two, plus registerMonitorHandlers (1)              = 3
    //
    // `registerMonitorHandlers` is deliberately NOT mocked below, so its real
    // `sessionManager.on('exit', schedulePush)` attaches here - that is how the
    // Agent Monitor learns a session ended and debounces a MONITOR_CHANGED push
    // to every window. It takes no 'activity' listener, because live activity
    // rides the unbuffered `session:activity` push and is patched onto rows in
    // place rather than triggering a snapshot rebuild.
    //
    // If this ever needs to change, re-attribute the count explicitly rather
    // than just bumping the number.
    expect(getOptionalIpcContext()?.desktopNotifier).toBeDefined();
    expect(getSessionManager().listenerCount('activity')).toBe(2);
    expect(getSessionManager().listenerCount('exit')).toBe(3);
  }, 30000);

  it('second call updates mainWindow without re-registering handlers', async () => {
    const { registerAllIpc, getSessionManager } = await import('../../src/main/ipc/register-all');
    const { registerProjectHandlers } = await import('../../src/main/ipc/handlers/projects');
    const { registerTaskCrudHandlers } = await import('../../src/main/ipc/handlers/task-crud');
    const { registerTaskArchiveHandlers } = await import('../../src/main/ipc/handlers/task-archive');
    const { registerTaskMoveHandlers } = await import('../../src/main/ipc/handlers/task-move');
    const { registerTaskBranchHandlers } = await import('../../src/main/ipc/handlers/task-branch');
    const { registerTaskRuntimeOverrideHandlers } = await import('../../src/main/ipc/handlers/task-runtime-override');
    const { registerSessionHandlers } = await import('../../src/main/ipc/handlers/sessions');
    const { registerTransientSessionHandlers } = await import('../../src/main/ipc/handlers/transient-sessions');
    const { registerBoardHandlers } = await import('../../src/main/ipc/handlers/board');
    const { registerBacklogHandlers } = await import('../../src/main/ipc/handlers/backlog');
    const { registerGitDiffHandlers } = await import('../../src/main/ipc/handlers/git-diff');
    const { registerSystemHandlers } = await import('../../src/main/ipc/handlers/system');
    const { registerMobileBridgeHandlers } = await import('../../src/main/ipc/handlers/mobile-bridge');
    const { retrievalService } = await import('../../src/main/retrieval/retrieval-service');

    const window1 = makeMockWindow(1);
    const window2 = makeMockWindow(2);

    registerAllIpc(window1);
    const handleCountAfterFirst = mockHandle.mock.calls.length;
    const onCountAfterFirst = mockOn.mock.calls.length;

    registerAllIpc(window2);

    // No additional ipcMain.handle or ipcMain.on calls -- this is the load-bearing
    // invariant (ipcMain throws on duplicate channel registration).
    expect(mockHandle).toHaveBeenCalledTimes(handleCountAfterFirst);
    expect(mockOn).toHaveBeenCalledTimes(onCountAfterFirst);

    // Every handler-registration function was called exactly once. Keep this
    // list in sync with register-all.ts; a missing entry here means a new
    // handler module can silently double-register on macOS re-activate.
    expect(registerProjectHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskCrudHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskArchiveHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskMoveHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskBranchHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskRuntimeOverrideHandlers).toHaveBeenCalledTimes(1);
    expect(registerSessionHandlers).toHaveBeenCalledTimes(1);
    expect(registerTransientSessionHandlers).toHaveBeenCalledTimes(1);
    expect(registerBoardHandlers).toHaveBeenCalledTimes(1);
    expect(registerBacklogHandlers).toHaveBeenCalledTimes(1);
    expect(registerGitDiffHandlers).toHaveBeenCalledTimes(1);
    expect(registerSystemHandlers).toHaveBeenCalledTimes(1);
    expect(registerMobileBridgeHandlers).toHaveBeenCalledTimes(1);

    // The second call short-circuits before reaching retrievalService.attach,
    // so it stays called exactly once total across both registerAllIpc calls.
    expect(retrievalService.attach).toHaveBeenCalledTimes(1);

    // Same idempotency guarantee for the mobile bridge: a re-activate on
    // macOS must not construct a second MobileBridgeService (which would
    // hold a second relay connection) nor re-run reconcile() a second time.
    expect(mobileBridgeReconcileSpy).toHaveBeenCalledTimes(1);
    // Nor re-run attachContext() - re-registering the same verb on the
    // router a second time would be a correctness bug even if the mock
    // doesn't throw the way a real double-registration might.
    expect(mobileBridgeAttachContextSpy).toHaveBeenCalledTimes(1);

    // Same guarantee for the desktop notifier, the ActivityIntervalRecorder AND
    // the Agent Monitor's push scheduler: a re-activate on macOS must not attach
    // a second set of SessionManager listeners for any of them (which would
    // double-fire every idle/crash notification, double-write every committed
    // disposition transition to session_activity_intervals, and schedule the
    // monitor's debounced snapshot push twice per session exit). All are reached
    // inside the `if (context) return` idempotency guard at the top of
    // registerAllIpc, so this assertion genuinely exercises that guard rather
    // than passing by accident - it goes red the moment any of those listeners
    // stops being reused across a second registerAllIpc call.
    //
    // Counts as attributed in the first test: activity is the notifier plus the
    // recorder; exit is those two plus registerMonitorHandlers.
    expect(getSessionManager().listenerCount('activity')).toBe(2);
    expect(getSessionManager().listenerCount('exit')).toBe(3);
  }, 30000);

  it('second call preserves existing services', async () => {
    const { registerAllIpc, getSessionManager, getTerminalSubmitScheduler, getBoardConfigManager } = await import('../../src/main/ipc/register-all');

    const window1 = makeMockWindow(1);
    const window2 = makeMockWindow(2);

    registerAllIpc(window1);
    const sessionManager1 = getSessionManager();
    const scheduler1 = getTerminalSubmitScheduler();
    const boardConfigManager1 = getBoardConfigManager();

    registerAllIpc(window2);
    const sessionManager2 = getSessionManager();
    const scheduler2 = getTerminalSubmitScheduler();
    const boardConfigManager2 = getBoardConfigManager();

    // Same object references (services not recreated)
    expect(sessionManager2).toBe(sessionManager1);
    expect(scheduler2).toBe(scheduler1);
    expect(boardConfigManager2).toBe(boardConfigManager1);
  }, 30000);

  it('reconciles the startup mobile bridge with a persisted enabled: true', async () => {
    // Regression guard for the mobile-bridge launch un-gate: the startup
    // reconcile in register-all.ts must forward a persisted enabled bit
    // as-is, not force it to false the way the removed __KANGENTIC_DEV__
    // gate did.
    getEffectiveConfigMock.mockReturnValueOnce({
      claude: {},
      git: {},
      terminal: {},
      mobileBridge: { enabled: true, relayMode: 'custom', relayUrl: 'wss://relay.example.com' },
    });
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');

    registerAllIpc(makeMockWindow(1));

    expect(mobileBridgeReconcileSpy).toHaveBeenCalledWith({
      enabled: true,
      relayUrl: new URL('wss://relay.example.com').href,
    });
  }, 30000);

  describe('TRACK_RENDERER_ERROR analytics handler', () => {
    // register-all.ts wires exactly one direct `ipcMain.on(...)` call (the
    // rest of the suite only exercises `registerXxxHandlers`, which are
    // themselves mocked out and never touch the real ipcMain.on). Coverage
    // hole this closes: nothing else in the repo ever invokes this callback,
    // so reverting its second parameter to the old one-arg form, or removing
    // a runtime guard, would fail nothing without these tests.
    type TrackRendererErrorCallback = (
      event: unknown,
      message: string,
      context?: RendererErrorContext,
    ) => void;

    function getTrackRendererErrorCallback(): TrackRendererErrorCallback {
      const entry = mockOn.mock.calls.find((call) => call[0] === IPC.TRACK_RENDERER_ERROR);
      if (!entry) {
        throw new Error('ipcMain.on was never called with IPC.TRACK_RENDERER_ERROR');
      }
      return entry[1] as TrackRendererErrorCallback;
    }

    it('sends boundary, panel, and a real component trail when full context is provided', async () => {
      const { registerAllIpc } = await import('../../src/main/ipc/register-all');
      const { trackEvent } = await import('../../src/main/analytics/analytics');
      registerAllIpc(makeMockWindow(1));

      const callback = getTrackRendererErrorCallback();
      callback({}, 'Cannot read properties of undefined (reading split)', {
        boundary: 'panel',
        panel: 'Changes panel',
        componentStack: '    at Foo (x)\n    at Bar (y)',
      });

      // `components` is produced by the REAL summarizeComponentStack (see the
      // importOriginal mock above), not a stub - this would go red if the
      // trail-building logic broke, not just if the call were dropped.
      expect(vi.mocked(trackEvent)).toHaveBeenCalledWith('app_error', {
        source: 'error_boundary',
        message: 'Cannot read properties of undefined (reading split)',
        boundary: 'panel',
        panel: 'Changes panel',
        components: 'Foo < Bar',
      });
    }, 30000);

    it('omits boundary, panel, and components when no context argument is given', async () => {
      const { registerAllIpc } = await import('../../src/main/ipc/register-all');
      const { trackEvent } = await import('../../src/main/analytics/analytics');
      registerAllIpc(makeMockWindow(1));

      const callback = getTrackRendererErrorCallback();
      callback({}, 'boom');

      const trackEventMock = vi.mocked(trackEvent);
      expect(trackEventMock).toHaveBeenCalledTimes(1);
      const [, props] = trackEventMock.mock.calls[0];
      // An explicit key-presence check, not toEqual/toHaveBeenCalledWith:
      // Jest/vitest's default object equality treats a key present with an
      // `undefined` value the same as a key that is genuinely absent, so
      // toEqual({ source, message }) would pass even if the handler
      // regressed to unconditionally writing `props.boundary = undefined`.
      // The keys must be ABSENT, which only Object.keys can prove.
      expect(Object.keys(props ?? {}).sort()).toEqual(['message', 'source']);
      expect(props).toMatchObject({ source: 'error_boundary', message: 'boom' });
    }, 30000);

    it('does not throw on a malformed payload and omits only the malformed fields', async () => {
      const { registerAllIpc } = await import('../../src/main/ipc/register-all');
      const { trackEvent } = await import('../../src/main/analytics/analytics');
      registerAllIpc(makeMockWindow(1));

      const callback = getTrackRendererErrorCallback();
      // RendererErrorContext is erased at the IPC boundary: a renderer could
      // send a payload that violates the compile-time type at runtime.
      // `panel` as a number and `componentStack` as an object are exactly the
      // shapes that would throw inside `.slice()` / `.split()` without the
      // per-field typeof guards - a throw here silently drops the error
      // report (the global uncaughtException handler swallows it).
      const malformedContext = {
        boundary: 'panel',
        panel: 42,
        componentStack: { not: 'a string' },
      } as unknown as RendererErrorContext;

      expect(() => {
        callback({}, undefined as unknown as string, malformedContext);
      }).not.toThrow();

      const trackEventMock = vi.mocked(trackEvent);
      expect(trackEventMock).toHaveBeenCalledTimes(1);
      const [, props] = trackEventMock.mock.calls[0];
      expect(Object.keys(props ?? {}).sort()).toEqual(['boundary', 'message', 'source']);
      expect(props).toMatchObject({
        source: 'error_boundary',
        message: 'Unknown error',
        boundary: 'panel',
      });
    }, 30000);

    it('truncates panel to MAX_ANALYTICS_STRING_LENGTH characters', async () => {
      const { registerAllIpc } = await import('../../src/main/ipc/register-all');
      const { trackEvent, MAX_ANALYTICS_STRING_LENGTH } = await import(
        '../../src/main/analytics/analytics'
      );
      registerAllIpc(makeMockWindow(1));

      const callback = getTrackRendererErrorCallback();
      const longPanel = 'p'.repeat(MAX_ANALYTICS_STRING_LENGTH + 20);
      callback({}, 'boom', { boundary: 'panel', panel: longPanel });

      const trackEventMock = vi.mocked(trackEvent);
      const [, props] = trackEventMock.mock.calls[0];
      expect(props?.panel).toBe(longPanel.slice(0, MAX_ANALYTICS_STRING_LENGTH));
      expect(props?.panel).toHaveLength(MAX_ANALYTICS_STRING_LENGTH);
    }, 30000);
  });
});
