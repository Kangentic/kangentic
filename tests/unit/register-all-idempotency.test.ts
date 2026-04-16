/**
 * Unit tests for registerAllIpc idempotency guard.
 *
 * On macOS, closing all windows doesn't quit the app. Re-clicking the dock
 * icon fires `activate` → `createWindow()` → `registerAllIpc()` again.
 * The idempotency guard must update the window reference without
 * re-registering ipcMain.handle handlers (which throws on duplicates).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../../src/main/agent/git-detector', () => ({
  GitDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig = vi.fn(() => ({ claude: {}, git: {}, terminal: {} })); },
}));
vi.mock('../../src/main/config/board-config-manager', () => ({
  BoardConfigManager: class {
    constructor() {}
    attach = vi.fn();
    detach = vi.fn();
  },
}));
vi.mock('../../src/main/engine/command-injector', () => ({
  CommandInjector: class {
    constructor() {}
    cancelAll = vi.fn();
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
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((msg: string) => msg),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));

// Mock all handler registration functions (they call ipcMain.handle internally)
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  registerProjectHandlers: vi.fn(),
  cleanupProject: vi.fn(),
  deleteProjectFromIndex: vi.fn(),
  pruneStaleWorktreeProjects: vi.fn(),
  openProjectByPath: vi.fn(),
  activateAllProjects: vi.fn(),
  getLastOpenedProject: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/tasks', () => ({
  registerTaskHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({
  registerSessionHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/board', () => ({
  registerBoardHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/system', () => ({
  registerSystemHandlers: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMockWindow(id: number) {
  return { id, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('registerAllIpc idempotency', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the module-level `context` singleton between tests
    vi.resetModules();
  });

  it('first call initializes context and registers handlers', async () => {
    const { registerAllIpc, getSessionManager } = await import('../../src/main/ipc/register-all');
    const { registerProjectHandlers } = await import('../../src/main/ipc/handlers/projects');
    const { registerTaskHandlers } = await import('../../src/main/ipc/handlers/tasks');

    const window = makeMockWindow(1);
    registerAllIpc(window);

    // Handler registration functions were called
    expect(registerProjectHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskHandlers).toHaveBeenCalledTimes(1);

    // Context is initialized (wrappers don't throw)
    expect(() => getSessionManager()).not.toThrow();
  });

  it('second call updates mainWindow without re-registering handlers', async () => {
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');
    const { registerProjectHandlers } = await import('../../src/main/ipc/handlers/projects');
    const { registerTaskHandlers } = await import('../../src/main/ipc/handlers/tasks');
    const { registerSessionHandlers } = await import('../../src/main/ipc/handlers/sessions');
    const { registerBoardHandlers } = await import('../../src/main/ipc/handlers/board');
    const { registerSystemHandlers } = await import('../../src/main/ipc/handlers/system');

    const window1 = makeMockWindow(1);
    const window2 = makeMockWindow(2);

    registerAllIpc(window1);
    const handleCountAfterFirst = mockHandle.mock.calls.length;
    const onCountAfterFirst = mockOn.mock.calls.length;

    registerAllIpc(window2);

    // No additional ipcMain.handle or ipcMain.on calls
    expect(mockHandle).toHaveBeenCalledTimes(handleCountAfterFirst);
    expect(mockOn).toHaveBeenCalledTimes(onCountAfterFirst);

    // Handler registration functions were NOT called a second time
    expect(registerProjectHandlers).toHaveBeenCalledTimes(1);
    expect(registerTaskHandlers).toHaveBeenCalledTimes(1);
    expect(registerSessionHandlers).toHaveBeenCalledTimes(1);
    expect(registerBoardHandlers).toHaveBeenCalledTimes(1);
    expect(registerSystemHandlers).toHaveBeenCalledTimes(1);
  });

  it('second call preserves existing services', async () => {
    const { registerAllIpc, getSessionManager, getCommandInjector, getBoardConfigManager } = await import('../../src/main/ipc/register-all');

    const window1 = makeMockWindow(1);
    const window2 = makeMockWindow(2);

    registerAllIpc(window1);
    const sessionManager1 = getSessionManager();
    const commandInjector1 = getCommandInjector();
    const boardConfigManager1 = getBoardConfigManager();

    registerAllIpc(window2);
    const sessionManager2 = getSessionManager();
    const commandInjector2 = getCommandInjector();
    const boardConfigManager2 = getBoardConfigManager();

    // Same object references (services not recreated)
    expect(sessionManager2).toBe(sessionManager1);
    expect(commandInjector2).toBe(commandInjector1);
    expect(boardConfigManager2).toBe(boardConfigManager1);
  });
});
