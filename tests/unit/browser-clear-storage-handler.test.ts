/**
 * Unit tests for the BROWSER_CLEAR_STORAGE IPC handler in
 * src/main/ipc/handlers/browser.ts.
 *
 * The handler must:
 *   - call session.fromPartition with the exact BROWSER_PARTITION constant
 *   - call clearStorageData with the exact storages array
 *   - then call clearCache, then clearAuthCache, in that order
 *   - propagate rejection when any sub-call throws
 *
 * Strategy mirrors agent-list-handler.test.ts: capture ipcMain.handle
 * registrations via a mocked electron module, then invoke the captured
 * handler directly without a running Electron process.
 *
 * vi.hoisted() is required for the fake session spies because vi.mock()
 * factories are hoisted to the top of the module by Vitest's transform,
 * which means they execute before any top-level variable declarations.
 * Wrapping the spies in vi.hoisted() ensures they are initialized before
 * the factory runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy objects
// ---------------------------------------------------------------------------

const {
  capturedHandlers,
  fakeClearStorageData,
  fakeClearCache,
  fakeClearAuthCache,
  fakeFromPartition,
  fakeReaddirSync,
  fakeRegistryRegister,
  fakeRegistryUnregister,
} = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const fakeClearStorageData = vi.fn(async () => undefined);
  const fakeClearCache = vi.fn(async () => undefined);
  const fakeClearAuthCache = vi.fn(async () => undefined);

  const fakeSession = {
    clearStorageData: fakeClearStorageData,
    clearCache: fakeClearCache,
    clearAuthCache: fakeClearAuthCache,
  };

  const fakeFromPartition = vi.fn((_partition: string) => fakeSession);

  const fakeReaddirSync = vi.fn(() => [] as { isDirectory: () => boolean; name: string }[]);

  const fakeRegistryRegister = vi.fn();
  const fakeRegistryUnregister = vi.fn();

  return {
    capturedHandlers,
    fakeClearStorageData,
    fakeClearCache,
    fakeClearAuthCache,
    fakeFromPartition,
    fakeReaddirSync,
    fakeRegistryRegister,
    fakeRegistryUnregister,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  session: {
    fromPartition: fakeFromPartition,
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    },
    readdirSync: fakeReaddirSync,
  },
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: fakeRegistryRegister,
    unregister: fakeRegistryUnregister,
  },
}));

// ---------------------------------------------------------------------------
// Import under test (must come after all vi.mock() calls)
// ---------------------------------------------------------------------------

import path from 'node:path';
import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { BROWSER_PARTITION, browserPartitionForWorktree } from '../../src/shared/browser-partition';
import { browserUrlStore } from '../../src/main/browser/browser-url-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext() {
  // The clear-storage handler does not exercise the paste path; no
  // terminalSubmit mock is needed here. If a future browser-handler test
  // does need paste, mock `terminalSubmit: { submitContent: vi.fn(...) }`
  // instead - PasteEngine is no longer reachable directly through the
  // IpcContext.
  return {
    currentProjectPath: null,
    currentProjectId: null,
    configManager: {
      loadProjectOverrides: vi.fn(() => null),
    },
    // registerPane backfills the pane's project from the session registry, the
    // only authoritative source (the renderer's value is ambient and goes stale
    // in a pop-out). Tests override the return per case.
    sessionManager: {
      getSessionProjectId: fakeGetSessionProjectId,
    },
  };
}

const fakeGetSessionProjectId = vi.fn<(sessionId: string) => string | undefined>(() => undefined);

async function invokeClearStorage(): Promise<unknown> {
  const handler = capturedHandlers.get('browser:clearStorage');
  if (!handler) throw new Error('browser:clearStorage handler not registered');
  // Pass undefined as the first arg to match ipcMain.handle's (_event) signature
  // without needing a real IpcMainInvokeEvent object.
  return handler(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BROWSER_CLEAR_STORAGE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeFromPartition.mockClear();
    fakeClearStorageData.mockClear();
    fakeClearCache.mockClear();
    fakeClearAuthCache.mockClear();
    // Restore default resolving behavior before each test.
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockResolvedValue(undefined);
    fakeClearAuthCache.mockResolvedValue(undefined);

    const context = makeContext();
    registerBrowserHandlers(context as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('calls session.fromPartition with the BROWSER_PARTITION constant', async () => {
    await invokeClearStorage();

    expect(fakeFromPartition).toHaveBeenCalledOnce();
    expect(fakeFromPartition).toHaveBeenCalledWith(BROWSER_PARTITION);
    expect(fakeFromPartition).toHaveBeenCalledWith('persist:kangentic-browser');
  });

  it('calls clearStorageData with the exact storages array', async () => {
    await invokeClearStorage();

    expect(fakeClearStorageData).toHaveBeenCalledOnce();
    expect(fakeClearStorageData).toHaveBeenCalledWith({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'cachestorage', 'serviceworkers'],
    });
  });

  it('calls clearCache after clearStorageData, then clearAuthCache after clearCache', async () => {
    const callOrder: string[] = [];

    fakeClearStorageData.mockImplementation(async () => { callOrder.push('clearStorageData'); });
    fakeClearCache.mockImplementation(async () => { callOrder.push('clearCache'); });
    fakeClearAuthCache.mockImplementation(async () => { callOrder.push('clearAuthCache'); });

    await invokeClearStorage();

    expect(callOrder).toEqual(['clearStorageData', 'clearCache', 'clearAuthCache']);
  });

  it('propagates rejection when clearStorageData throws', async () => {
    fakeClearStorageData.mockRejectedValue(new Error('disk full'));

    await expect(invokeClearStorage()).rejects.toThrow('disk full');
  });

  it('propagates rejection when clearCache throws after clearStorageData resolves', async () => {
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockRejectedValue(new Error('cache error'));

    await expect(invokeClearStorage()).rejects.toThrow('cache error');
  });

  it('propagates rejection when clearAuthCache throws after clearStorageData and clearCache resolve', async () => {
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockResolvedValue(undefined);
    fakeClearAuthCache.mockRejectedValue(new Error('auth cache error'));

    await expect(invokeClearStorage()).rejects.toThrow('auth cache error');
  });

  it('does not call clearCache when clearStorageData rejects (partial-failure stops the chain)', async () => {
    fakeClearStorageData.mockRejectedValue(new Error('storage error'));

    await expect(invokeClearStorage()).rejects.toThrow();

    expect(fakeClearCache).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Hole #4: multi-partition enumeration when a project path is set
// ---------------------------------------------------------------------------

// Fake project root used only as a path string for partition computation.
// readdirSync is mocked, so nothing is read from disk.
const FAKE_PROJECT_ROOT = '/mock/kangentic-clear-test';

async function invokeClearStorageForProject(): Promise<unknown> {
  const handler = capturedHandlers.get('browser:clearStorage');
  if (!handler) throw new Error('browser:clearStorage handler not registered');
  return handler(undefined);
}

describe('BROWSER_CLEAR_STORAGE IPC handler - with project path (multi-partition)', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeFromPartition.mockClear();
    fakeClearStorageData.mockClear();
    fakeClearCache.mockClear();
    fakeClearAuthCache.mockClear();
    fakeReaddirSync.mockClear();
    fakeClearStorageData.mockResolvedValue(undefined);
    fakeClearCache.mockResolvedValue(undefined);
    fakeClearAuthCache.mockResolvedValue(undefined);

    // Two fake worktree directories under the project's .kangentic/worktrees/
    fakeReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'wt-a' },
      { isDirectory: () => true, name: 'wt-b' },
    ]);

    const context = {
      currentProjectPath: FAKE_PROJECT_ROOT,
      currentProjectId: null,
      configManager: {
        loadProjectOverrides: vi.fn(() => null),
      },
    };
    registerBrowserHandlers(context as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('clears all 4 partitions: legacy + project-root + 2 worktrees', async () => {
    await invokeClearStorageForProject();

    const worktreesDir = path.join(FAKE_PROJECT_ROOT, '.kangentic', 'worktrees');
    const expectedPartitions = [
      BROWSER_PARTITION,
      browserPartitionForWorktree(FAKE_PROJECT_ROOT),
      browserPartitionForWorktree(path.join(worktreesDir, 'wt-a')),
      browserPartitionForWorktree(path.join(worktreesDir, 'wt-b')),
    ];

    // Handler uses Promise.all so clearing is concurrent; assert on presence
    // not ordering.
    expect(fakeFromPartition).toHaveBeenCalledTimes(4);
    for (const partition of expectedPartitions) {
      expect(fakeFromPartition).toHaveBeenCalledWith(partition);
    }
  });

  it('calls the three-step clear sequence once per partition (4 partitions = 4x each)', async () => {
    await invokeClearStorageForProject();

    expect(fakeClearStorageData).toHaveBeenCalledTimes(4);
    expect(fakeClearCache).toHaveBeenCalledTimes(4);
    expect(fakeClearAuthCache).toHaveBeenCalledTimes(4);
  });

  it('skips a worktree entry that is not a directory', async () => {
    fakeReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'wt-a' },
      { isDirectory: () => false, name: 'README.md' }, // file, not dir
    ]);

    await invokeClearStorageForProject();

    // Only 3 partitions: legacy + project-root + wt-a (file entry excluded)
    expect(fakeFromPartition).toHaveBeenCalledTimes(3);
    const worktreesDir = path.join(FAKE_PROJECT_ROOT, '.kangentic', 'worktrees');
    expect(fakeFromPartition).toHaveBeenCalledWith(
      browserPartitionForWorktree(path.join(worktreesDir, 'wt-a')),
    );
    expect(fakeFromPartition).not.toHaveBeenCalledWith(
      browserPartitionForWorktree(path.join(worktreesDir, 'README.md')),
    );
  });

  it('clears only legacy + project-root when readdirSync throws (no worktrees dir yet)', async () => {
    fakeReaddirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await invokeClearStorageForProject();

    // Graceful: 2 partitions (legacy + project-root), no throw propagated
    expect(fakeFromPartition).toHaveBeenCalledTimes(2);
    expect(fakeFromPartition).toHaveBeenCalledWith(BROWSER_PARTITION);
    expect(fakeFromPartition).toHaveBeenCalledWith(
      browserPartitionForWorktree(FAKE_PROJECT_ROOT),
    );
  });
});

// ---------------------------------------------------------------------------
// Hole #5: BROWSER_PANE_REGISTER / BROWSER_PANE_UNREGISTER input validation
// ---------------------------------------------------------------------------

const VALID_SESSION_ID = '12345678-1234-1234-1234-123456789012';

async function invokeRegisterPane(input: unknown): Promise<unknown> {
  const handler = capturedHandlers.get('browser:paneRegister');
  if (!handler) throw new Error('browser:paneRegister handler not registered');
  return handler(undefined, input);
}

async function invokeUnregisterPane(sessionId: string): Promise<unknown> {
  const handler = capturedHandlers.get('browser:paneUnregister');
  if (!handler) throw new Error('browser:paneUnregister handler not registered');
  return handler(undefined, sessionId);
}

describe('BROWSER_PANE_REGISTER IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeRegistryRegister.mockClear();
    fakeRegistryUnregister.mockClear();
    fakeGetSessionProjectId.mockReset();
    fakeGetSessionProjectId.mockReturnValue(undefined);

    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('throws on null input', async () => {
    await expect(invokeRegisterPane(null)).rejects.toThrow('malformed sessionId');
  });

  it('throws when sessionId is missing from the input object', async () => {
    await expect(
      invokeRegisterPane({ webContentsId: 1, taskId: 't', projectId: 'p' }),
    ).rejects.toThrow('malformed sessionId');
  });

  it('throws when sessionId is not a UUID', async () => {
    await expect(
      invokeRegisterPane({ sessionId: 'not-a-uuid', webContentsId: 1, taskId: 't' }),
    ).rejects.toThrow('malformed sessionId');
  });

  it('throws when webContentsId is a float', async () => {
    await expect(
      invokeRegisterPane({ sessionId: VALID_SESSION_ID, webContentsId: 1.5, taskId: 't' }),
    ).rejects.toThrow('invalid webContentsId');
  });

  it('throws when webContentsId is zero', async () => {
    await expect(
      invokeRegisterPane({ sessionId: VALID_SESSION_ID, webContentsId: 0, taskId: 't' }),
    ).rejects.toThrow('invalid webContentsId');
  });

  it('throws when webContentsId is negative', async () => {
    await expect(
      invokeRegisterPane({ sessionId: VALID_SESSION_ID, webContentsId: -1, taskId: 't' }),
    ).rejects.toThrow('invalid webContentsId');
  });

  it('calls browserPaneRegistry.register with the correct fields on valid input', async () => {
    await invokeRegisterPane({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-1',
      projectId: 'proj-1',
      webContentsId: 42,
      url: 'http://localhost:3000',
    });

    expect(fakeRegistryRegister).toHaveBeenCalledOnce();
    expect(fakeRegistryRegister).toHaveBeenCalledWith({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-1',
      projectId: 'proj-1',
      webContentsId: 42,
      url: 'http://localhost:3000',
    });
  });

  it('maps missing projectId to null and missing url to null', async () => {
    await invokeRegisterPane({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-2',
      webContentsId: 7,
    });

    expect(fakeRegistryRegister).toHaveBeenCalledWith({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-2',
      projectId: null,
      webContentsId: 7,
      url: null,
    });
  });

  // The registered projectId is what resolveTarget scopes MCP access by, so it
  // must come from the session registry (stamped at spawn) rather than the
  // renderer's ambient currentProject, which a pop-out window holds stale
  // across a project switch.
  it('prefers the session registry project over a stale renderer value', async () => {
    fakeGetSessionProjectId.mockReturnValue('proj-real');
    await invokeRegisterPane({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-1',
      projectId: 'proj-stale',
      webContentsId: 42,
      url: null,
    });
    expect(fakeRegistryRegister).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-real' }),
    );
  });

  it('falls back to the renderer value for a session the registry does not know', async () => {
    fakeGetSessionProjectId.mockReturnValue(undefined);
    await invokeRegisterPane({
      sessionId: VALID_SESSION_ID,
      taskId: 'task-1',
      projectId: 'proj-from-renderer',
      webContentsId: 42,
      url: null,
    });
    expect(fakeRegistryRegister).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-from-renderer' }),
    );
  });
});

describe('BROWSER_PANE_UNREGISTER IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeRegistryUnregister.mockClear();

    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('returns without calling unregister when sessionId is malformed', async () => {
    await invokeUnregisterPane('not-a-uuid');
    expect(fakeRegistryUnregister).not.toHaveBeenCalled();
  });

  it('returns without calling unregister when sessionId is an empty string', async () => {
    await invokeUnregisterPane('');
    expect(fakeRegistryUnregister).not.toHaveBeenCalled();
  });

  it('calls browserPaneRegistry.unregister with the sessionId on valid input', async () => {
    await invokeUnregisterPane(VALID_SESSION_ID);
    expect(fakeRegistryUnregister).toHaveBeenCalledOnce();
    expect(fakeRegistryUnregister).toHaveBeenCalledWith(VALID_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Hole #6: BROWSER_URL_GET / BROWSER_URL_SET_TASK / BROWSER_URL_CLEAR_TASK
// project-scoped routing.
//
// These three handlers now resolve their project via
// resolveProjectContext(context, projectId) instead of reading the ambient
// context.currentProjectPath directly (see the comment above them in
// src/main/ipc/handlers/browser.ts). resolveProjectContext itself is fully
// unit-tested in isolation as a pure function
// (tests/unit/resolve-project-context.test.ts); what is NOT covered
// anywhere is that these three handlers actually THREAD the caller's
// explicit projectId argument into it and use the RESULT (not the raw
// ambient context fields) for the browserUrlStore / configManager calls.
// That wiring is exactly what a popped-out pane's cross-project URL-mixup
// bug (see the handler's own comment) depends on.
// ---------------------------------------------------------------------------

const URL_CURRENT_PROJECT_ID = 'proj-url-current';
const URL_CURRENT_PROJECT_PATH = '/mock/browser-url-current';
const URL_OTHER_PROJECT_ID = 'proj-url-other';
const URL_OTHER_PROJECT_PATH = '/mock/browser-url-other';

function makeUrlContext(opts: {
  currentProjectId?: string | null;
  currentProjectPath?: string | null;
  getByIdResult?: { path: string } | undefined;
} = {}) {
  const getById = vi.fn(() => opts.getByIdResult);
  // Note: 'currentProjectId' in opts, not `?? URL_CURRENT_PROJECT_ID` - an
  // explicit `null` in opts (the "no project open" cases) must NOT be
  // coalesced back to the default project, since `??` treats `null` as
  // nullish the same as `undefined`.
  return {
    currentProjectId: 'currentProjectId' in opts ? opts.currentProjectId : URL_CURRENT_PROJECT_ID,
    currentProjectPath: 'currentProjectPath' in opts ? opts.currentProjectPath : URL_CURRENT_PROJECT_PATH,
    configManager: {
      loadProjectOverrides: vi.fn(() => null),
    },
    projectRepo: { getById },
    sessionManager: {
      getSessionProjectId: vi.fn(() => undefined),
    },
  };
}

async function invokeUrlGet(taskId: string, projectId?: string | null): Promise<unknown> {
  const handler = capturedHandlers.get('browser:urlGet');
  if (!handler) throw new Error('browser:urlGet handler not registered');
  return handler(undefined, taskId, projectId);
}

async function invokeUrlSetTask(taskId: string, url: string, projectId?: string | null): Promise<unknown> {
  const handler = capturedHandlers.get('browser:urlSetTask');
  if (!handler) throw new Error('browser:urlSetTask handler not registered');
  return handler(undefined, taskId, url, projectId);
}

async function invokeUrlClearTask(taskId: string, projectId?: string | null): Promise<unknown> {
  const handler = capturedHandlers.get('browser:urlClearTask');
  if (!handler) throw new Error('browser:urlClearTask handler not registered');
  return handler(undefined, taskId, projectId);
}

describe('BROWSER_URL_GET / SET_TASK / CLEAR_TASK IPC handlers - project-scoped routing', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.mocked(browserUrlStore.get).mockClear();
    vi.mocked(browserUrlStore.set).mockClear();
    vi.mocked(browserUrlStore.clear).mockClear();
    vi.mocked(browserUrlStore.get).mockReturnValue(null);
  });

  it('BROWSER_URL_GET: omitted projectId falls back to the ambient current project', async () => {
    const context = makeUrlContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeUrlGet('task-1');

    expect(context.configManager.loadProjectOverrides).toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH);
    expect(browserUrlStore.get).toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH, 'task-1');
    // No explicit projectId was passed, so resolveProjectContext must not
    // consult the project repo at all.
    expect(context.projectRepo.getById).not.toHaveBeenCalled();
  });

  it('BROWSER_URL_GET: an explicit projectId for a DIFFERENT project routes to that project, not the ambient one', async () => {
    // This is the cross-project bug fix: a popped-out pane whose task belongs
    // to project OTHER navigates while project CURRENT is in the foreground.
    // Before routing through resolveProjectContext, the handler read
    // context.currentProjectPath unconditionally and would have read/written
    // OTHER's task URL against CURRENT's browser-urls.json instead.
    const context = makeUrlContext({ getByIdResult: { path: URL_OTHER_PROJECT_PATH } });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeUrlGet('task-1', URL_OTHER_PROJECT_ID);

    expect(context.projectRepo.getById).toHaveBeenCalledWith(URL_OTHER_PROJECT_ID);
    expect(context.configManager.loadProjectOverrides).toHaveBeenCalledWith(URL_OTHER_PROJECT_PATH);
    expect(context.configManager.loadProjectOverrides).not.toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH);
    expect(browserUrlStore.get).toHaveBeenCalledWith(URL_OTHER_PROJECT_PATH, 'task-1');
    expect(browserUrlStore.get).not.toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH, 'task-1');
  });

  it('BROWSER_URL_GET: no project open and no explicit projectId returns nulls without touching the store', async () => {
    const context = makeUrlContext({ currentProjectId: null, currentProjectPath: null });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    const result = await invokeUrlGet('task-1');

    expect(result).toEqual({ projectDefault: null, taskOverride: null });
    expect(browserUrlStore.get).not.toHaveBeenCalled();
    expect(context.configManager.loadProjectOverrides).not.toHaveBeenCalled();
  });

  it('BROWSER_URL_SET_TASK: an explicit projectId for a DIFFERENT project writes to that project, not the ambient one', async () => {
    const context = makeUrlContext({ getByIdResult: { path: URL_OTHER_PROJECT_PATH } });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeUrlSetTask('task-1', 'http://localhost:3000', URL_OTHER_PROJECT_ID);

    expect(browserUrlStore.set).toHaveBeenCalledWith(URL_OTHER_PROJECT_PATH, 'task-1', 'http://localhost:3000');
    expect(browserUrlStore.set).not.toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH, 'task-1', 'http://localhost:3000');
  });

  it('BROWSER_URL_SET_TASK: throws "No project open" when no project resolves', async () => {
    const context = makeUrlContext({ currentProjectId: null, currentProjectPath: null });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await expect(invokeUrlSetTask('task-1', 'http://localhost:3000')).rejects.toThrow('No project open');
    expect(browserUrlStore.set).not.toHaveBeenCalled();
  });

  it('BROWSER_URL_SET_TASK: throws "URL is required" when url is empty, even with a project resolved', async () => {
    const context = makeUrlContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await expect(invokeUrlSetTask('task-1', '')).rejects.toThrow('URL is required');
    expect(browserUrlStore.set).not.toHaveBeenCalled();
  });

  it('BROWSER_URL_CLEAR_TASK: an explicit projectId for a DIFFERENT project clears that project, not the ambient one', async () => {
    const context = makeUrlContext({ getByIdResult: { path: URL_OTHER_PROJECT_PATH } });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeUrlClearTask('task-1', URL_OTHER_PROJECT_ID);

    expect(browserUrlStore.clear).toHaveBeenCalledWith(URL_OTHER_PROJECT_PATH, 'task-1');
    expect(browserUrlStore.clear).not.toHaveBeenCalledWith(URL_CURRENT_PROJECT_PATH, 'task-1');
  });

  it('BROWSER_URL_CLEAR_TASK: no-ops without throwing when no project resolves', async () => {
    const context = makeUrlContext({ currentProjectId: null, currentProjectPath: null });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await expect(invokeUrlClearTask('task-1')).resolves.toBeUndefined();
    expect(browserUrlStore.clear).not.toHaveBeenCalled();
  });
});
