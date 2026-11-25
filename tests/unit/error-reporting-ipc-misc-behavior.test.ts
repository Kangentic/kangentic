/**
 * What a user loses if these reports go quiet: a step in an IPC handler or one of its
 * helpers that fails and is caught keeps the handler answering, so nothing reaches the
 * IPC wrap and nothing reaches Sentry. A project relocated with every worktree's git left
 * broken, a Command Terminal restart that brings nothing back, a project whose MCP tools
 * never reach its agents, an Earlier row deleted for a lookup that merely threw, a
 * Knowledge Graph picker that lists every project as empty, a task window that opens with
 * no page capture: each would look like a quiet day.
 *
 * Each case runs the real module, makes one dependency throw a code defect (a TypeError
 * whose message quotes text a user could have written), and reads the call that reached
 * `reportHandledError`: its source, its `area` and `step` tags, the fixed message, and
 * that nothing a user wrote is in the serialized call. Where the catch guards an expected
 * outcome (an ENOENT, a plain Error from an agent CLI) a second case pins that it sends
 * nothing. Each case also pins what the user still gets: the handler's answer, the
 * fallback, or the thing that was not destroyed.
 *
 * Modules are imported per test (`vi.resetModules`) because each reporter latches a key
 * once per run, and each test installs only the mocks its module needs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { reportedFailures, reportedText, type ReportedFailure } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

/** Text a user could have written, which must never leave with a report. */
const USER_TEXT = 'Fix Acme billing export';

function defect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
}

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the test's teardown can unmock it. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

interface ReportedCall extends ReportedFailure {
  serialized: string;
}

function reportedCalls(): ReportedCall[] {
  return reportedFailures(reportHandledError).map((failure) => ({
    ...failure,
    // Name, message, whole stack, tags, contexts and fingerprint: everything that leaves.
    serialized: reportedText({ mock: { calls: [[failure.sent, failure.tags, failure.contexts, failure.fingerprint]] } }),
  }));
}

function stepReports(): ReportedCall[] {
  return reportedCalls().filter((call) => call.tags.source === 'handler_step');
}

/** One `handler_step` report went out, under this area and step, carrying no user text. */
function expectOnlyStepReport(area: string, step: string, errorName = 'TypeError'): void {
  const calls = stepReports();
  expect(calls).toHaveLength(1);
  expect(calls[0].tags).toMatchObject({ source: 'handler_step', area, step, error_name: errorName });
  expect(calls[0].sent.message).toBe(`Handled handler_step failure: ${errorName}`);
  expect(calls[0].serialized).not.toMatch(/acme/i);
}

const temporaryFolders: string[] = [];

function makeTemporaryFolder(prefix: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryFolders.push(folder);
  return folder;
}

type CapturedHandler = (...handlerArguments: unknown[]) => unknown;

/** An `electron` mock whose `ipcMain.handle` keeps each handler by channel. */
function capturingIpcMain(): { handlers: Map<string, CapturedHandler>; electronMock: () => unknown } {
  const handlers = new Map<string, CapturedHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: CapturedHandler) => { handlers.set(channel, handler); }),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
  };
  return {
    handlers,
    electronMock: () => ({
      ipcMain,
      app: { getPath: vi.fn(() => os.tmpdir()), getAppPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: vi.fn(() => '0.0.0') },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
    }),
  };
}

function handlerOf(handlers: Map<string, CapturedHandler>, channel: string): CapturedHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler;
}

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const folder of temporaryFolders.splice(0)) {
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// Project relocate
// ---------------------------------------------------------------------------

describe('project relocate', () => {
  const OLD_PATH = path.resolve(path.join('/', 'mock', 'relocate-old'));
  const NEW_PATH = path.resolve(path.join('/', 'mock', 'relocate-new'));

  interface RelocateHarness {
    isGit: boolean;
    runGit: () => Promise<unknown>;
    adapterRelocate: () => Promise<void>;
    discardProjectSpares: ReturnType<typeof vi.fn>;
    updatePath: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    awaitExit: ReturnType<typeof vi.fn>;
    sessions: unknown[];
  }

  function makeHarness(): RelocateHarness {
    return {
      isGit: false,
      runGit: async () => ({ stdout: '', stderr: '' }),
      adapterRelocate: async () => undefined,
      discardProjectSpares: vi.fn(async () => undefined),
      updatePath: vi.fn(),
      kill: vi.fn(),
      awaitExit: vi.fn(async () => undefined),
      sessions: [],
    };
  }

  async function runRelocate(harness: RelocateHarness): Promise<{ project: { path: string }; warnings: string[] }> {
    installMocks({
      '../../src/main/git/original-fs': () => ({
        default: {
          existsSync: vi.fn(() => true),
          statSync: vi.fn(() => ({ isDirectory: () => true })),
        },
      }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/db/repositories/task-repository': () => ({
        TaskRepository: class {
          list() { return [{ id: 'task-aaa00001', worktree_path: path.join(OLD_PATH, '.kangentic', 'worktrees', 'task-one') }]; }
          listArchived() { return []; }
          update() { return undefined; }
        },
      }),
      '../../src/main/db/repositories/session-repository': () => ({
        SessionRepository: class { listAll() { return []; } updateCwd() { return undefined; } },
      }),
      '../../src/main/git/worktree-manager': () => ({ WorktreeManager: class { static clearQueue = vi.fn(); } }),
      '../../src/main/git/git-checks': () => ({ isGitRepo: vi.fn(() => harness.isGit) }),
      '../../src/main/git/git-spawn': () => ({ runGitWithTimeout: vi.fn(() => harness.runGit()) }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn() }),
      '../../src/main/ipc/handlers/session-reconcile': () => ({ applySuspendDbWrites: vi.fn() }),
      '../../src/main/ipc/handlers/session-resume-controllers': () => ({ abortInFlightResume: vi.fn() }),
      '../../src/main/fs/directory-move': () => ({ moveDirectory: vi.fn(), removeDirectoryTree: vi.fn() }),
      '../../src/main/git/removed-worktrees': () => ({ stopRemovedWorktreeDeletion: vi.fn(async () => undefined) }),
      '../../src/main/ipc/helpers/spare-worktrees': () => ({ discardProjectSpares: harness.discardProjectSpares }),
      '../../src/main/agent/agent-registry': () => ({
        agentRegistry: {
          list: () => ['claude'],
          get: () => ({ name: 'claude', onProjectRelocated: vi.fn(() => harness.adapterRelocate()) }),
        },
      }),
    });
    const { relocateProject } = await import('../../src/main/ipc/handlers/project-relocate');
    const project = { id: 'project-1', name: USER_TEXT, path: OLD_PATH };
    const context = {
      projectRepo: {
        getById: vi.fn(() => project),
        list: vi.fn(() => [project]),
        updatePath: harness.updatePath.mockImplementation((_id: string, newPath: string) => ({ ...project, path: newPath })),
      },
      sessionManager: {
        listSessions: vi.fn(() => harness.sessions),
        suspend: vi.fn(async () => undefined),
        kill: harness.kill,
        awaitExit: harness.awaitExit,
      },
      recoveredProjects: new Set<string>(['project-1']),
      currentProjectId: null,
      currentProjectPath: null,
      boardConfigManager: { detach: vi.fn() },
      diffWatcher: { releaseUnder: vi.fn() },
      spareWorktrees: { stop: vi.fn(async () => undefined) },
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    };
    return relocateProject(context as never, 'project-1', NEW_PATH) as never;
  }

  it('reports a terminal that cannot be killed and still relocates the project', async () => {
    const harness = makeHarness();
    harness.sessions = [{ id: 'terminal-session-1', projectId: 'project-1', taskId: 'tag-1', status: 'running', transient: true }];
    harness.kill.mockImplementation(() => { throw defect(); });

    const result = await runRelocate(harness);

    expect(harness.kill).toHaveBeenCalledTimes(1);
    expect(harness.updatePath).toHaveBeenCalledWith('project-1', NEW_PATH);
    expect(result.project.path).toBe(NEW_PATH);
    expectOnlyStepReport('relocate', 'terminal_kill');
  });

  it('reports a git worktree repair that fails, and still discards spares and relocates', async () => {
    const harness = makeHarness();
    harness.isGit = true;
    harness.runGit = async () => { throw defect(); };

    const result = await runRelocate(harness);

    expect(harness.discardProjectSpares).toHaveBeenCalledTimes(1);
    expect(result.project.path).toBe(NEW_PATH);
    expectOnlyStepReport('relocate', 'worktree_repair');
  });

  it('reports an agent adapter whose relocate hook fails and still relocates', async () => {
    const harness = makeHarness();
    harness.adapterRelocate = async () => { throw defect(); };

    const result = await runRelocate(harness);

    expect(result.project.path).toBe(NEW_PATH);
    expect(result.warnings).toEqual([]);
    expectOnlyStepReport('relocate', 'adapter_relocate');
  });

  it('reports nothing when every step works', async () => {
    const harness = makeHarness();
    harness.isGit = true;

    await runRelocate(harness);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Command Terminal restore claim
// ---------------------------------------------------------------------------

describe('Command Terminal restore claim', () => {
  async function claimWith(listOpen: () => unknown[]) {
    const { electronMock } = capturingIpcMain();
    const projectFolder = makeTemporaryFolder('kangentic-restore-');
    installMocks({
      electron: electronMock,
      '../../src/main/ipc/handlers/transient-sessions': () => ({ CommandTerminalStartError: class extends Error {}, startCommandTerminal: vi.fn() }),
      '../../src/main/ipc/helpers/task-cleanup': () => ({ reapTaskLeftovers: vi.fn() }),
      '../../src/main/ipc/helpers/command-terminal-browser': () => ({ endCommandTerminalBrowserIfSlotEmpty: vi.fn() }),
      '../../src/main/ipc/helpers/command-terminal-background-session': () => ({ stopEndedCommandTerminalBackgroundSession: vi.fn() }),
    });
    const { claimCommandTerminalRestore, startCommandTerminalRestore } = await import('../../src/main/ipc/handlers/command-terminal-restore');
    const claimResume = vi.fn(() => true);
    const context = {
      commandTerminalHistory: { listOpen: vi.fn(listOpen), claimResume },
      configManager: { load: () => ({ agent: { autoResumeSessionsOnRestart: true } }) },
      projectRepo: { getById: () => ({ id: 'project-1', name: USER_TEXT, path: projectFolder }) },
    };
    return { claimCommandTerminalRestore, startCommandTerminalRestore, context, claimResume };
  }

  it('reports a history read that throws, claims nothing and lets the start finish', async () => {
    const { claimCommandTerminalRestore, startCommandTerminalRestore, context, claimResume } = await claimWith(() => { throw defect(); });

    expect(() => claimCommandTerminalRestore(context as never, 'project-1')).not.toThrow();
    // The pass is settled: a start has nothing to wait for and nothing to bring back.
    await expect(startCommandTerminalRestore(context as never, 'project-1')).resolves.toBeUndefined();

    expect(claimResume).not.toHaveBeenCalled();
    expectOnlyStepReport('command_terminal', 'restore_claim');
  });

  it('reports nothing when the history has no open row', async () => {
    const { claimCommandTerminalRestore, context } = await claimWith(() => []);

    claimCommandTerminalRestore(context as never, 'project-1');

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Command Terminal history reads
// ---------------------------------------------------------------------------

describe('Command Terminal history reads', () => {
  it('reports a read that throws and answers that no conversation was open', async () => {
    const { CommandTerminalHistory } = await import('../../src/main/ipc/helpers/command-terminal-history');
    const history = new CommandTerminalHistory({
      sessionManager: { listSessions: () => [] } as never,
      getRepository: () => ({ listOpenUsed: vi.fn(() => { throw defect(); }) }) as never,
      conversationAvailable: async () => true,
      notifyChanged: vi.fn(),
      conversationEnded: vi.fn(),
      searchText: vi.fn(),
    });

    expect(history.listOpen('project-1')).toEqual([]);

    expectOnlyStepReport('command_terminal', 'history_read');
  });
});

// ---------------------------------------------------------------------------
// Command Terminal browser cleanup
// ---------------------------------------------------------------------------

describe('Command Terminal browser cleanup', () => {
  const browserOwnerArgs = { projectId: 'project-1', slot: 'slot-1', sessionId: 'session-aaaa0001' };

  interface BrowserHarness {
    destroyLanesForTask: ReturnType<typeof vi.fn>;
    clearUrl: ReturnType<typeof vi.fn>;
    getByTaskId: ReturnType<typeof vi.fn>;
    discardAnnotationDraft: ReturnType<typeof vi.fn>;
  }

  async function loadCleanup(projectPath: string | null): Promise<{ module: typeof import('../../src/main/ipc/helpers/command-terminal-browser'); harness: BrowserHarness }> {
    const harness: BrowserHarness = {
      destroyLanesForTask: vi.fn(() => 0),
      clearUrl: vi.fn(),
      getByTaskId: vi.fn(() => []),
      discardAnnotationDraft: vi.fn(async () => undefined),
    };
    installMocks({
      '../../src/main/browser/browser-pane-registry': () => ({ browserPaneRegistry: { getByTaskId: harness.getByTaskId, markDeliberateClose: vi.fn() } }),
      '../../src/main/browser/browser-lane-manager': () => ({ destroyLanesForTask: harness.destroyLanesForTask }),
      '../../src/main/browser/browser-url-store': () => ({ browserUrlStore: { clear: harness.clearUrl } }),
      '../../src/main/browser/command-terminal-browser-store': () => ({ commandTerminalBrowserStore: { clear: vi.fn() } }),
      '../../src/main/browser/annotation-drafts': () => ({ discardAnnotationDraft: harness.discardAnnotationDraft }),
      '../../src/main/browser/viewport-override': () => ({ releaseViewportOverridesForSession: vi.fn(async () => undefined) }),
      '../../src/main/pop-out/pop-out-window-manager': () => ({ popOutWindowManager: { has: vi.fn(() => false), close: vi.fn() } }),
      '../../src/main/pop-out/window-broadcast': () => ({ broadcast: vi.fn() }),
      '../../src/main/ipc/helpers/project-repos': () => ({ resolveProjectContext: vi.fn(() => ({ projectId: 'project-1', projectPath })) }),
    });
    const module = await import('../../src/main/ipc/helpers/command-terminal-browser');
    return { module, harness };
  }

  it('reports a slot lookup that throws, and leaves the slot\'s page and layout alone', async () => {
    const { module, harness } = await loadCleanup('/mock/project');
    const context = {
      sessionManager: { findLiveCommandTerminalSession: vi.fn(() => { throw defect(); }) },
      mainWindow: { isDestroyed: () => false },
    };

    module.endCommandTerminalBrowserIfSlotEmpty(context as never, browserOwnerArgs.projectId, browserOwnerArgs.slot, browserOwnerArgs.sessionId);

    // No answer is no end: a browser closed in error costs the user a page.
    expect(harness.destroyLanesForTask).not.toHaveBeenCalled();
    expect(harness.clearUrl).not.toHaveBeenCalled();
    expectOnlyStepReport('command_terminal', 'browser_slot_lookup');
  });

  it('reports a browser close that throws, without failing the end of the terminal', async () => {
    const { module, harness } = await loadCleanup('/mock/project');
    harness.getByTaskId.mockImplementation(() => { throw defect(); });
    const context = {
      sessionManager: { findLiveCommandTerminalSession: vi.fn(() => undefined) },
      mainWindow: { isDestroyed: () => false },
    };

    expect(() => module.endCommandTerminalBrowserIfSlotEmpty(context as never, browserOwnerArgs.projectId, browserOwnerArgs.slot, browserOwnerArgs.sessionId)).not.toThrow();

    expectOnlyStepReport('command_terminal', 'browser_end');
  });

  it('reports an annotation draft that cannot be removed, after the rest of the page was cleared', async () => {
    const { module, harness } = await loadCleanup('/mock/project');
    harness.discardAnnotationDraft.mockImplementation(async () => { throw defect(); });
    const context = {
      sessionManager: { findLiveCommandTerminalSession: vi.fn(() => undefined) },
      mainWindow: { isDestroyed: () => false },
    };

    module.endCommandTerminalBrowserIfSlotEmpty(context as never, browserOwnerArgs.projectId, browserOwnerArgs.slot, browserOwnerArgs.sessionId);

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expect(harness.clearUrl).toHaveBeenCalledTimes(1);
    expectOnlyStepReport('command_terminal', 'annotation_draft_remove');
  });

  it('reports nothing when the slot still holds a live terminal', async () => {
    const { module, harness } = await loadCleanup('/mock/project');
    const context = {
      sessionManager: { findLiveCommandTerminalSession: vi.fn(() => ({ id: 'other' })) },
      mainWindow: { isDestroyed: () => false },
    };

    module.endCommandTerminalBrowserIfSlotEmpty(context as never, browserOwnerArgs.projectId, browserOwnerArgs.slot, browserOwnerArgs.sessionId);

    expect(harness.destroyLanesForTask).not.toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The project's MCP config file
// ---------------------------------------------------------------------------

describe('project MCP config', () => {
  async function loadSync(unlinkError: NodeJS.ErrnoException | null, writeError: Error | null) {
    installMocks({
      'node:fs': () => {
        const stub = {
          unlinkSync: vi.fn(() => { if (unlinkError) throw unlinkError; }),
          mkdirSync: vi.fn(),
          writeFileSync: vi.fn(() => { if (writeError) throw writeError; }),
        };
        return { default: stub, ...stub };
      },
      '../../src/main/ipc/handlers/project-relocate': () => ({ relocateProject: vi.fn() }),
    });
    return (await import('../../src/main/ipc/handlers/projects')).syncProjectMcpConfig;
  }

  const enabledContext = {
    configManager: { getEffectiveConfig: () => ({ mcpServer: { enabled: true } }) },
    mcpServerHandle: { urlForProject: () => 'http://127.0.0.1:1/mcp', token: 'token' },
  };
  const disabledContext = {
    configManager: { getEffectiveConfig: () => ({ mcpServer: { enabled: false } }) },
    mcpServerHandle: null,
  };

  it('reports a config write that fails and returns without throwing', async () => {
    const sync = await loadSync(null, defect());

    expect(() => sync(enabledContext as never, 'project-1', '/mock/project')).not.toThrow();

    expectOnlyStepReport('projects', 'mcp_config_write');
  });

  it('reports a stale config file that cannot be removed', async () => {
    const sync = await loadSync(Object.assign(new Error(`EBUSY: resource busy ${USER_TEXT}`), { code: 'EBUSY' }), null);

    expect(() => sync(disabledContext as never, 'project-1', '/mock/project')).not.toThrow();

    const calls = stepReports();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ area: 'projects', step: 'mcp_config_remove', errno: 'EBUSY' });
    expect(calls[0].serialized).not.toMatch(/acme/i);
  });

  it('reports nothing when the file to remove was never there', async () => {
    const sync = await loadSync(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }), null);

    sync(disabledContext as never, 'project-1', '/mock/project');

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Handlers that answer with the failure instead of rejecting
// ---------------------------------------------------------------------------

/** What the retrieval client rejects with while its worker is down: an expected class. */
function workerDown(): Error {
  return Object.assign(new Error('The retrieval worker exited'), { name: 'RetrievalUnavailableError' });
}

describe('Knowledge Graph handlers', () => {
  async function registerSearch(context: Record<string, unknown>, retrievalCall: () => Promise<unknown> = async () => []) {
    const { handlers, electronMock } = capturingIpcMain();
    installMocks({
      electron: electronMock,
      '../../src/main/retrieval/retrieval-service': () => ({ retrievalService: {} }),
      // Registration only hands the service its change callbacks; any method is a no-op.
      '../../src/main/retrieval/graph-facade': () => ({ graphService: new Proxy({}, { get: () => vi.fn() }) }),
      '../../src/main/search/search-core': () => ({ runSearchEverything: vi.fn() }),
      '../../src/main/agent/shared/cli-print': () => ({ runCliForChat: vi.fn(), stopCliRunsForChat: vi.fn() }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: { call: vi.fn(retrievalCall) },
      }),
    });
    const { registerSearchHandlers } = await import('../../src/main/ipc/handlers/search');
    registerSearchHandlers({ currentProjectId: 'project-1', ...context } as never);
    return handlers;
  }

  it('reports a defect thrown inside an answer and still answers the chat with a reason', async () => {
    const thrown = defect();
    const handlers = await registerSearch({ projectRepo: { list: vi.fn(() => { throw thrown; }) } });

    const answer = await handlerOf(handlers, IPC.KNOWLEDGE_GRAPH_ANSWER)({}, 'What changed in billing?', 'project-1');

    expect(answer).toEqual({ ok: false, reason: thrown.message });
    expectOnlyStepReport('search', 'answer');
  });

  it('reports nothing for an agent CLI that failed with a plain Error, and shows its reason', async () => {
    const handlers = await registerSearch({ projectRepo: { list: vi.fn(() => { throw new Error('the agent exited 1'); }) } });

    const answer = await handlerOf(handlers, IPC.KNOWLEDGE_GRAPH_ANSWER)({}, 'What changed in billing?', 'project-1');

    expect(answer).toEqual({ ok: false, reason: 'the agent exited 1' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports an errno failure, which is the machine\'s and not an agent\'s outcome', async () => {
    const handlers = await registerSearch({
      projectRepo: { list: vi.fn(() => { throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }); }) },
    });

    await handlerOf(handlers, IPC.KNOWLEDGE_GRAPH_ANSWER)({}, 'What changed in billing?', 'project-1');

    const calls = stepReports();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ area: 'search', step: 'answer', errno: 'EMFILE' });
  });

  it('reports a project summary read that throws and lists every project as having nothing indexed', async () => {
    const handlers = await registerSearch(
      { projectRepo: { list: vi.fn(() => [{ id: 'project-1', name: USER_TEXT }, { id: 'project-2', name: 'Other' }]) } },
      async () => { throw defect(); },
    );

    const projects = await handlerOf(handlers, IPC.KNOWLEDGE_GRAPH_PROJECTS)({});

    expect(projects).toEqual([
      { id: 'project-1', name: USER_TEXT, conversations: 0, taskRecords: 0, lastActivityMs: null },
      { id: 'project-2', name: 'Other', conversations: 0, taskRecords: 0, lastActivityMs: null },
    ]);
    expectOnlyStepReport('search', 'project_summaries_read');
  });

  it('does not report a project summary read while the retrieval worker is down', async () => {
    const handlers = await registerSearch(
      { projectRepo: { list: vi.fn(() => [{ id: 'project-1', name: 'App' }]) } },
      async () => { throw workerDown(); },
    );

    const projects = await handlerOf(handlers, IPC.KNOWLEDGE_GRAPH_PROJECTS)({}) as unknown[];

    expect(projects).toHaveLength(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('System handlers', () => {
  async function registerSystem(context: Record<string, unknown>) {
    const { handlers, electronMock } = capturingIpcMain();
    const electronBase = electronMock() as Record<string, unknown>;
    installMocks({
      electron: () => ({
        ...electronBase,
        BrowserWindow: { getAllWindows: vi.fn(() => []) },
        Notification: class { static isSupported = vi.fn(() => false); },
        dialog: { showOpenDialog: vi.fn() },
        globalShortcut: { register: vi.fn(), unregister: vi.fn(), unregisterAll: vi.fn() },
        clipboard: { readText: vi.fn(), writeText: vi.fn() },
        nativeImage: { createFromPath: vi.fn() },
      }),
      '../../src/main/ipc/handlers/projects': () => ({ syncProjectMcpConfig: vi.fn() }),
      '../../src/main/agent/agent-list': () => ({
        agentNowInUse: vi.fn(), listAgents: vi.fn(), listAgentsOnHost: vi.fn(), invalidateAgentListCache: vi.fn(), nameLearnedModels: vi.fn(), setAgentListHooks: vi.fn(),
      }),
      '../../src/main/agent/shared/agent-detector': () => ({ setFirstLiveDetectionListener: vi.fn() }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { list: vi.fn(() => []), get: vi.fn() } }),
      '../../src/main/git/git-fetch-scheduler': () => ({ gitFetchScheduler: { stop: vi.fn() } }),
      '../../src/main/plan-approval/plan-approval-writer': () => ({ refreshPlanApprovals: vi.fn() }),
      '../../src/main/config/apply-runtime-config': () => ({ applyRuntimeConfig: vi.fn() }),
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn() }),
      '../../src/main/automations/automation-agent': () => ({ resolveAutomationAgent: vi.fn(), runNamingCall: vi.fn() }),
      '../../src/main/ipc/helpers/automation-agent-deps': () => ({ automationAgentDeps: vi.fn() }),
      '../../src/main/ipc/helpers/background-call-sink': () => ({ backgroundCallSink: vi.fn() }),
      '../../src/main/notifications/custom-sound': () => ({ pickCustomSound: vi.fn(), readCustomSound: vi.fn() }),
    });
    const { registerSystemHandlers } = await import('../../src/main/ipc/handlers/system');
    registerSystemHandlers(context as never);
    return handlers;
  }

  it('reports a defect inside a summarize call and answers the reason as a result', async () => {
    const thrown = defect();
    const handlers = await registerSystem({ configManager: { load: vi.fn(() => { throw thrown; }) } });

    const result = await handlerOf(handlers, IPC.AGENT_SUMMARIZE)({}, { prompt: 'Name this task' });

    expect(result).toEqual({ ok: false, reason: thrown.message });
    expectOnlyStepReport('system', 'summarize');
  });

  it('reports nothing for a naming agent that failed with a plain Error, and answers its reason', async () => {
    const handlers = await registerSystem({ configManager: { load: vi.fn(() => { throw new Error('the agent timed out'); }) } });

    const result = await handlerOf(handlers, IPC.AGENT_SUMMARIZE)({}, { prompt: 'Name this task' });

    expect(result).toEqual({ ok: false, reason: 'the agent timed out' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a branch list that throws and opens the base branch picker empty', async () => {
    const projectFolder = makeTemporaryFolder('kangentic-branches-');
    installMocks({
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: class { listBranchChoices() { return Promise.reject(defect()); } static withGitLock = vi.fn(); },
      }),
      '../../src/main/git/git-checks': () => ({ isGitRepo: vi.fn(() => true), isProjectGitRepo: vi.fn(() => true) }),
    });
    const handlers = await registerSystem({ currentProjectId: 'project-1', currentProjectPath: projectFolder });

    await expect(handlerOf(handlers, IPC.GIT_LIST_BRANCHES)({}, null)).resolves.toEqual([]);

    expectOnlyStepReport('system', 'branch_list');
  });

  it('lists the branches and reports nothing when git answers', async () => {
    const projectFolder = makeTemporaryFolder('kangentic-branches-');
    installMocks({
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: class { listBranchChoices() { return Promise.resolve([{ name: 'main' }]); } static withGitLock = vi.fn(); },
      }),
      '../../src/main/git/git-checks': () => ({ isGitRepo: vi.fn(() => true), isProjectGitRepo: vi.fn(() => true) }),
    });
    const handlers = await registerSystem({ currentProjectId: 'project-1', currentProjectPath: projectFolder });

    await expect(handlerOf(handlers, IPC.GIT_LIST_BRANCHES)({}, null)).resolves.toEqual([{ name: 'main' }]);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('a completed task\'s linked commits', () => {
  async function readChanges(retrievalCall: () => Promise<unknown>) {
    const resolveTaskChanges = vi.fn(async () => ({ commits: [], files: [], emptyReason: null }));
    installMocks({
      electron: () => capturingIpcMain().electronMock(),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: { call: vi.fn(retrievalCall) },
      }),
      '../../src/main/git/task-changes': () => ({ resolveTaskChanges, TASK_CHANGES_MAX_COMMITS: 50 }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        resolveProjectContext: vi.fn(() => ({ projectId: 'project-1', projectPath: '/mock/project' })),
        getProjectRepos: vi.fn(() => ({
          tasks: {
            getById: vi.fn(() => ({ id: 'task-aaa00001', title: USER_TEXT, branch_name: 'feat/work', base_branch: 'main', head_sha: 'abc123' })),
            getForkPointSha: vi.fn(() => null),
          },
        })),
      }),
      '../../src/main/git/git-client': () => ({ gitAt: vi.fn(), runGitCommand: vi.fn() }),
      '../../src/main/git/worktree-head': () => ({ readWorktreeHead: vi.fn() }),
      '../../src/main/git/fetch-throttle': () => ({ fetchAllRemotesIfStale: vi.fn() }),
      '../../src/main/git/local-only-commits': () => ({ countLocalOnlyCommits: vi.fn() }),
      '../../src/main/git/diff-service': () => ({ DiffService: class {} }),
      '../../src/main/git/diff-watcher': () => ({ DiffWatcher: class {} }),
    });
    const { readTaskChanges } = await import('../../src/main/ipc/handlers/git-diff');
    const context = { configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true } }), getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) } };
    const result = await readTaskChanges(context as never, { projectId: 'project-1', taskId: 'task-aaa00001' } as never, { commitWebLinks: false });
    return { result, resolveTaskChanges };
  }

  it('reports an index read that throws and shows the commits git alone finds', async () => {
    const { result, resolveTaskChanges } = await readChanges(async () => { throw defect(); });

    expect(result.commits).toEqual([]);
    // 'unavailable' reaches the resolver as no linked commits, not as "indexing is off".
    expect(resolveTaskChanges).toHaveBeenCalledWith(expect.objectContaining({ linkedCommitShas: [] }));
    expectOnlyStepReport('git_diff', 'linked_commits_read');
  });

  it('reports nothing while the retrieval worker is down', async () => {
    await readChanges(async () => { throw workerDown(); });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The project handlers that finish a delete or an open past a failed step
// ---------------------------------------------------------------------------

describe('project delete and open steps', () => {
  const PROJECT_ID = 'project-1';
  const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'error-report-misc-project'));
  const KANGENTIC_DIR = path.join(PROJECT_PATH, '.kangentic');
  const WORKTREE_PATH = path.join(KANGENTIC_DIR, 'worktrees', 'task-one');

  interface ProjectHarness {
    isGit: boolean;
    prepareWorktreeForRemoval: () => Promise<void>;
    removedPaths: string[];
    removeShellFolder: () => Promise<void>;
    repairToolBreakdown: () => Promise<unknown>;
  }

  function makeHarness(): ProjectHarness {
    return {
      isGit: false,
      prepareWorktreeForRemoval: async () => undefined,
      removedPaths: [],
      removeShellFolder: async () => undefined,
      repairToolBreakdown: async () => ({ completed: true, scanned: 0, repaired: 0, unreadable: 0 }),
    };
  }

  function missingFile(): NodeJS.ErrnoException {
    return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }

  /** The mock graph follows error-reporting-ipc-steps-behavior.test.ts, which drives the same cleanup. */
  async function loadProjects(harness: ProjectHarness) {
    const { handlers, electronMock } = capturingIpcMain();
    const existingPaths = new Set([PROJECT_PATH, KANGENTIC_DIR, WORKTREE_PATH]);
    installMocks({
      electron: electronMock,
      '../../src/main/git/original-fs': () => ({
        default: {
          existsSync: vi.fn((target: string) => existingPaths.has(target)),
          unlinkSync: vi.fn(() => { throw missingFile(); }),
          readdirSync: vi.fn(() => { throw missingFile(); }),
          rmSync: vi.fn((target: string) => { harness.removedPaths.push(target); }),
        },
      }),
      '../../src/main/git/removed-worktrees': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/removed-worktrees')>('../../src/main/git/removed-worktrees')),
        deleteRemovedWorktreesNow: vi.fn(async () => false),
      }),
      '../../src/main/ipc/helpers/spare-worktrees': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/helpers/spare-worktrees')>('../../src/main/ipc/helpers/spare-worktrees')),
        discardProjectSpares: vi.fn(async () => undefined),
      }),
      '../../src/main/git/worktree-links': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/git/worktree-links')>('../../src/main/git/worktree-links')),
        clearWorktreeLinks: vi.fn(async () => true),
      }),
      '../../src/main/ipc/handlers/project-relocate': () => ({ relocateProject: vi.fn() }),
      '../../src/main/transition-engine/session-startup': () => ({
        resumeSuspendedSessions: vi.fn(async () => undefined),
        autoSpawnTasks: vi.fn(async () => undefined),
      }),
      '../../src/main/transition-engine/resource-cleanup': () => ({
        cleanupStaleResourcesAsync: vi.fn(async () => undefined),
        sweepAutomationRuns: vi.fn(() => 0),
      }),
      '../../src/main/git/worktree-manager': () => ({
        WorktreeManager: class {
          static clearQueue = vi.fn();
          withLock = async (job: () => Promise<unknown>) => job();
          removeWorktree = async () => true;
        },
        prepareWorktreeForRemoval: vi.fn(() => harness.prepareWorktreeForRemoval()),
      }),
      '../../src/main/git/git-checks': () => ({
        isGitRepo: vi.fn(() => harness.isGit),
        isInsideWorktree: vi.fn(() => false),
        isKangenticWorktree: vi.fn(() => false),
      }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { list: vi.fn(() => []), get: vi.fn(), getOrThrow: vi.fn() } }),
      '../../src/main/db/database': () => ({
        getProjectDb: vi.fn(() => ({})),
        getExistingProjectDb: vi.fn(() => ({})),
        closeProjectDb: vi.fn(),
        projectDbPath: vi.fn((projectId: string) => path.join(os.tmpdir(), `${projectId}.db`)),
      }),
      // No proof of ownership: the cold open sweeps nothing, and the duration repair still starts.
      '../../src/main/project-ownership/project-ownership': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/project-ownership/project-ownership')>('../../src/main/project-ownership/project-ownership')),
        verifyProjectOwnership: vi.fn(async () => ({ kind: 'unclaimed' })),
      }),
      '../../src/main/config/apply-runtime-config': () => ({ applyRuntimeConfig: vi.fn() }),
      '../../src/main/ipc/helpers': () => ({
        ensureGitignore: vi.fn(async () => undefined),
        reapTaskLeftovers: vi.fn(async () => ({ tasksLeftRunningInWorktree: new Set<string>() })),
        leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => undefined })),
      }),
      '../../src/main/ipc/helpers/task-windows': () => ({ closeTaskWindows: vi.fn(), closeProjectTaskWindows: vi.fn() }),
      '../../src/main/ipc/helpers/project-entry-search': () => ({ searchProjectEntries: vi.fn() }),
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn() }),
      '../../src/main/shutdown-state': () => ({ isShuttingDown: vi.fn(() => false) }),
      '../../src/main/diagnostics/project-log-context': () => ({
        runWithProjectLogContext: vi.fn((_name: string, work: () => unknown) => work()),
      }),
      '../../src/main/pr/pr-refresh-scheduler': () => ({ prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/git/git-fetch-scheduler': () => ({ gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() } }),
      '../../src/main/retrieval/retrieval-service': () => ({
        retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
      }),
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: {
          call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
          closeProject: vi.fn(async () => undefined),
        },
      }),
      '../../src/main/ipc/helpers/tool-breakdown-repair': () => ({
        repairToolBreakdownDurations: vi.fn(() => harness.repairToolBreakdown()),
      }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class { list = () => []; } }),
      '../../src/main/db/repositories/task-repository': () => ({
        TaskRepository: class {
          list = () => [{ id: 'task-aaa00001', title: USER_TEXT, worktree_path: WORKTREE_PATH }];
          listArchived = () => [];
          countAll = () => 1;
        },
      }),
      '../../src/main/workflows/workflow-project-delete': () => ({ detachProjectFromWorkflows: vi.fn() }),
      '../../src/main/workflows/workflow-agent': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/workflows/workflow-agent')>('../../src/main/workflows/workflow-agent')),
        endWorkflowAgentsOfProject: vi.fn(async () => undefined),
      }),
    });
    const projectsModule = await import('../../src/main/ipc/handlers/projects');
    const project = { id: PROJECT_ID, name: USER_TEXT, path: PROJECT_PATH, remote: { hostId: 'host-1', path: '/home/dev/app' } };
    const context = {
      boardConfigManager: { detach: vi.fn(), getBoardProfiles: vi.fn(() => []), getDefaultBaseBranchForPath: vi.fn(() => null) },
      configManager: { load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: false } })), getEffectiveConfig: vi.fn(() => ({})) },
      mcpServerHandle: null,
      sessionManager: {
        closeProjectInPtyHost: vi.fn(async () => undefined),
        kill: vi.fn(),
        awaitExit: vi.fn(async () => undefined),
        remove: vi.fn(),
        removeByTaskId: vi.fn(async () => undefined),
        listSessions: vi.fn(() => []),
        endCommandTerminal: vi.fn(),
      },
      projectRepo: { getById: vi.fn(() => project), delete: vi.fn() },
      remoteHosting: { admin: { removeShellFolder: vi.fn(() => harness.removeShellFolder()) } },
      currentProjectId: null,
      currentProjectPath: null,
      recoveredProjects: new Set<string>(),
      snapshottedProjects: new Set<string>(),
    };
    return { projectsModule, context, handlers, project };
  }

  it('reports a worktree that cannot be detached and still finishes the delete', async () => {
    const harness = makeHarness();
    harness.isGit = true;
    harness.prepareWorktreeForRemoval = async () => { throw defect(); };
    const { projectsModule, context } = await loadProjects(harness);

    await expect(projectsModule.cleanupProject(context as never, PROJECT_ID, PROJECT_PATH)).resolves.toBeUndefined();

    expect(harness.removedPaths).toContain(KANGENTIC_DIR);
    expectOnlyStepReport('projects', 'worktree_detach');
  });

  it('reports a remote project\'s shell folder that cannot be removed, after the project row went', async () => {
    const harness = makeHarness();
    harness.removeShellFolder = async () => { throw defect(); };
    const { projectsModule, context, handlers } = await loadProjects(harness);
    projectsModule.registerProjectHandlers(context as never);

    await expect(handlerOf(handlers, IPC.PROJECT_DELETE)({}, PROJECT_ID)).resolves.toBeUndefined();

    expect(context.projectRepo.delete).toHaveBeenCalledWith(PROJECT_ID);
    expectOnlyStepReport('projects', 'shell_folder_remove');
  });

  it('reports a duration repair that rejects once a cold open finished, and the open still completes', async () => {
    const harness = makeHarness();
    harness.repairToolBreakdown = async () => { throw defect(); };
    const { projectsModule, context, project } = await loadProjects(harness);

    await expect(projectsModule.activateProjects(context as never, [{ ...project, remote: null } as never])).resolves.toBeUndefined();

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expect(context.recoveredProjects.has(PROJECT_ID)).toBe(true);
    expectOnlyStepReport('projects', 'tool_breakdown_repair');
  });

  // The other catch of the same step: the repair threw before it returned a promise,
  // so it never started, and its in-flight mark must not be left behind.
  it('reports a duration repair that could not start, and a later open tries it again', async () => {
    const harness = makeHarness();
    let repairCalls = 0;
    harness.repairToolBreakdown = (() => {
      repairCalls += 1;
      throw defect();
    }) as unknown as typeof harness.repairToolBreakdown;
    const { projectsModule, context, project } = await loadProjects(harness);

    await expect(projectsModule.activateProjects(context as never, [{ ...project, remote: null } as never])).resolves.toBeUndefined();

    expect(repairCalls).toBe(1);
    expect(context.recoveredProjects.has(PROJECT_ID)).toBe(true);
    expectOnlyStepReport('projects', 'tool_breakdown_repair');
  });

  it('reports nothing when the duration repair finishes', async () => {
    const harness = makeHarness();
    const { projectsModule, context, project } = await loadProjects(harness);

    await projectsModule.activateProjects(context as never, [{ ...project, remote: null } as never]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a shell folder that is removed', async () => {
    const harness = makeHarness();
    const { projectsModule, context, handlers } = await loadProjects(harness);
    projectsModule.registerProjectHandlers(context as never);

    await handlerOf(handlers, IPC.PROJECT_DELETE)({}, PROJECT_ID);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The Browser pane's handlers
// ---------------------------------------------------------------------------

describe('Browser pane handlers', () => {
  interface PaneOpenerHost {
    taskExists: (projectId: string, taskId: string) => boolean;
    commandTerminalLive: (projectId: string, slot: string) => boolean;
  }
  interface LaneHandoff {
    hasLiveSession: (taskId: string) => boolean;
  }

  /** A no-op for every method: registration only hands these modules callbacks. */
  function inertModule(): unknown {
    return new Proxy({}, { get: () => vi.fn() });
  }

  async function registerBrowser(context: Record<string, unknown>, extraMocks: Record<string, () => unknown> = {}) {
    const { handlers, electronMock } = capturingIpcMain();
    let openerHost: (() => PaneOpenerHost) | null = null;
    let handoff: LaneHandoff | null = null;
    installMocks({
      electron: () => ({ ...(electronMock() as Record<string, unknown>), session: { fromPartition: vi.fn() }, webContents: { fromId: vi.fn() } }),
      '../../src/main/browser/browser-pane-opener': () => ({
        setBrowserPaneOpenerHost: vi.fn((factory: () => PaneOpenerHost) => { openerHost = factory; }),
        offscreenSurfaceUrl: vi.fn(),
      }),
      '../../src/main/browser/browser-lane-handoff': () => ({
        installLaneHandoff: vi.fn((hooks: LaneHandoff) => { handoff = hooks; }),
      }),
      '../../src/main/browser/browser-lane-manager': () => ({ destroyLane: vi.fn(), laneTaskIds: vi.fn(() => []), setLaneChangeListener: vi.fn(), destroyLanesForTask: vi.fn() }),
      '../../src/main/browser/browser-pane-registry': () => ({ browserPaneRegistry: inertModule() }),
      '../../src/main/browser/browser-url-store': () => ({ browserUrlStore: inertModule() }),
      '../../src/main/browser/command-terminal-browser-store': () => ({ commandTerminalBrowserStore: inertModule(), toCommandTerminalBrowserState: vi.fn() }),
      '../../src/main/browser/pop-out-link-relay': () => ({ relayLinkToPopOut: vi.fn() }),
      '../../src/main/browser/browser-partition-cleanup': () => ({ enumerateProjectPartitions: vi.fn() }),
      '../../src/main/browser/viewport-override': () => ({ releaseViewportOverride: vi.fn() }),
      '../../src/main/browser/viewport-override-store': () => ({ getViewportOverride: vi.fn() }),
      '../../src/main/pop-out/pop-out-window-manager': () => ({ popOutWindowManager: { has: vi.fn(() => false), close: vi.fn() } }),
      '../../src/main/pop-out/window-broadcast': () => ({ broadcast: vi.fn() }),
      '../../src/main/ipc/handlers/task-detail-ownership': () => ({ detailOwnerRegistry: { ownerOf: vi.fn(() => null) } }),
      '../../src/main/ipc/handlers/command-terminal-restore': () => ({ isRestorableAfterHostLoss: vi.fn(() => false) }),
      '../../src/main/ipc/handlers/transient-sessions': () => ({ isCommandTerminalSlotStarting: vi.fn(() => false) }),
      '../../src/main/ipc/helpers/command-terminal-browser': () => ({ installCommandTerminalBrowserCleanup: vi.fn() }),
      '../../src/main/agent/agent-registry': () => ({ agentRegistry: { get: vi.fn() } }),
      '../../src/main/pty/terminal-submit': () => ({ PasteSubmitError: class extends Error {} }),
      '../../src/main/browser/jar-seeder': () => ({ syncJarFromIdentity: vi.fn() }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        getProjectRepos: vi.fn(),
        resolveProjectContext: vi.fn(() => ({ projectId: 'project-1', projectPath: null })),
      }),
      ...extraMocks,
    });
    const { registerBrowserHandlers } = await import('../../src/main/ipc/handlers/browser');
    registerBrowserHandlers({ currentProjectId: 'project-1', mainWindow: { isDestroyed: () => false }, ...context } as never);
    if (!openerHost || !handoff) throw new Error('registerBrowserHandlers did not install the opener host and the lane hand-off');
    return { handlers, host: (openerHost as () => PaneOpenerHost)(), handoff: handoff as LaneHandoff };
  }

  it('reports a Command Terminal slot lookup that throws and answers that nothing is live there', async () => {
    const { host } = await registerBrowser({ sessionManager: { findLiveCommandTerminalSession: vi.fn(() => { throw defect(); }) } });

    expect(host.commandTerminalLive('project-1', 'slot-1')).toBe(false);

    expectOnlyStepReport('browser', 'terminal_slot_lookup');
  });

  it('answers that a Command Terminal is live, and reports nothing, when the slot holds one', async () => {
    const { host } = await registerBrowser({ sessionManager: { findLiveCommandTerminalSession: vi.fn(() => ({ id: 'terminal-1' })) } });

    expect(host.commandTerminalLive('project-1', 'slot-1')).toBe(true);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a task lookup that throws and tells the agent the task does not exist', async () => {
    const { host } = await registerBrowser({ sessionManager: {} }, {
      '../../src/main/ipc/helpers/project-repos': () => ({
        getProjectRepos: vi.fn(() => ({ tasks: { getById: vi.fn(() => { throw defect(); }) } })),
        resolveProjectContext: vi.fn(),
      }),
    });

    expect(host.taskExists('project-1', 'task-aaa00001')).toBe(false);

    expectOnlyStepReport('browser', 'task_exists_read');
  });

  it('reports a live session lookup that throws and hands no page off', async () => {
    const { handoff } = await registerBrowser({ sessionManager: { hasLiveSessionForTask: vi.fn(() => { throw defect(); }) } });

    expect(handoff.hasLiveSession('task-aaa00001')).toBe(false);

    expectOnlyStepReport('browser', 'live_session_lookup');
  });

  it('reports a jar seed that throws and still lets the pane open', async () => {
    const { handlers } = await registerBrowser({ sessionManager: {} }, {
      '../../src/main/browser/jar-seeder': () => ({ syncJarFromIdentity: vi.fn(async () => { throw defect(); }) }),
    });

    await expect(handlerOf(handlers, IPC.BROWSER_JAR_ENSURE)({}, 'task-aaa00001', 'project-1')).resolves.toBeUndefined();

    expectOnlyStepReport('browser', 'jar_seed');
  });

  it('sends the paste without an annotation\'s page capture, and reports the capture that is gone', async () => {
    const projectFolder = makeTemporaryFolder('kangentic-browser-send-');
    const submitContent = vi.fn(async () => undefined);
    const { handlers } = await registerBrowser(
      {
        sessionManager: { getSessionCommandCwd: vi.fn(() => projectFolder), getSessionAgentName: vi.fn(() => undefined) },
        terminalSubmit: { submitContent },
      },
      {
        '../../src/main/ipc/helpers/project-repos': () => ({
          getProjectRepos: vi.fn(),
          resolveProjectContext: vi.fn(() => ({ projectId: 'project-1', projectPath: projectFolder })),
        }),
      },
    );

    const result = await handlerOf(handlers, IPC.BROWSER_CAPTURE_SEND)({}, {
      sessionId: '00000000-0000-4000-8000-000000000001',
      projectId: 'project-1',
      taskId: 'task-aaa00001',
      cwd: projectFolder,
      pngBase64: Buffer.from('png').toString('base64'),
      url: 'https://example.test/',
      viewport: null,
      selectedText: '',
      note: '',
      annotations: [{
        number: 1,
        note: USER_TEXT,
        url: 'https://example.test/',
        onPage: true,
        inViewport: false,
        items: [],
        captureId: '0123456789abcdef',
      }],
    }) as { filePath: string };

    // The screenshot is on disk and the agent got its message, with no capture beside the note.
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(submitContent).toHaveBeenCalledTimes(1);
    const calls = stepReports();
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toMatchObject({ source: 'handler_step', area: 'browser', step: 'annotation_capture_copy', errno: 'ENOENT' });
    expect(calls[0].serialized).not.toMatch(/acme/i);
  });
});

// ---------------------------------------------------------------------------
// The Agent Monitor's snapshots
// ---------------------------------------------------------------------------

describe('Agent Monitor snapshots', () => {
  async function registerMonitor(buildSnapshot: () => Promise<unknown>) {
    const { EventEmitter } = await import('node:events');
    const { handlers, electronMock } = capturingIpcMain();
    const broadcast = vi.fn();
    installMocks({
      electron: electronMock,
      '../../src/main/monitor/monitor-aggregator': () => ({ buildMonitorSnapshot: vi.fn(buildSnapshot) }),
      '../../src/main/monitor/monitor-snapshot-sources': () => ({ monitorSnapshotSources: {} }),
      '../../src/main/browser/browser-pane-registry': () => ({
        browserPaneRegistry: { taskIds: vi.fn(() => []), onMembershipChange: vi.fn() },
      }),
      '../../src/main/workflows/workflow-changed': () => ({ onWorkflowChanged: vi.fn() }),
      '../../src/main/monitor/monitor-peek-tracker': () => ({ MonitorPeekTracker: class {} }),
      '../../src/main/monitor/task-detail-bundle': () => ({ buildTaskDetailBundle: vi.fn() }),
      '../../src/main/pop-out/window-broadcast': () => ({ broadcast }),
    });
    const { registerMonitorHandlers } = await import('../../src/main/ipc/handlers/monitor');
    const sessionManager = new EventEmitter();
    const boardEvents = { onBoardChanged: vi.fn() };
    registerMonitorHandlers({ sessionManager, boardEvents, mainWindow: { isDestroyed: () => false } } as never);
    const sender = Object.assign(new EventEmitter(), { id: 7 });
    return { handlers, sessionManager, sender, broadcast };
  }

  it('reports a snapshot build that throws on a fetch and answers an empty monitor', async () => {
    const { handlers } = await registerMonitor(async () => { throw defect(); });

    const snapshot = await handlerOf(handlers, IPC.MONITOR_GET_SNAPSHOT)({}) as { rows: unknown[]; generatedAt: string };

    expect(snapshot.rows).toEqual([]);
    expectOnlyStepReport('monitor', 'snapshot_fetch');
  });

  it('reports a snapshot build that throws on a push and keeps the rows the monitor has', async () => {
    const { handlers, sessionManager, sender, broadcast } = await registerMonitor(async () => { throw defect(); });
    vi.useFakeTimers();
    // Subscribing seeds the first frame, which fails the same way as a fetch: that one is not the push.
    await handlerOf(handlers, IPC.MONITOR_SUBSCRIBE)({ sender });
    reportHandledError.mockClear();

    sessionManager.emit('session-changed');
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcast).not.toHaveBeenCalled();
    expectOnlyStepReport('monitor', 'snapshot_push');
  });

  it('pushes the snapshot and reports nothing when the build works', async () => {
    const snapshot = { rows: [], generatedAt: '2026-01-01T00:00:00.000Z' };
    const { handlers, sessionManager, sender, broadcast } = await registerMonitor(async () => snapshot);
    vi.useFakeTimers();
    await handlerOf(handlers, IPC.MONITOR_SUBSCRIBE)({ sender });

    sessionManager.emit('session-changed');
    await vi.advanceTimersByTimeAsync(300);

    expect(broadcast).toHaveBeenCalledWith(expect.anything(), IPC.MONITOR_CHANGED, snapshot);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What registerAllIpc wires inline
// ---------------------------------------------------------------------------

describe('registerAllIpc closures', () => {
  interface RegisterAllCapture {
    notifierOptions: { resolveTaskTitle: (projectId: string, taskId: string) => string | undefined; resolveWorkflowTitle: (projectId: string, taskId: string) => string | undefined } | null;
    historyDeps: { conversationAvailable: (agentName: string, agentSessionId: string, cwd: string, cliTarget?: string | null) => Promise<boolean> } | null;
  }

  /**
   * Registers the real `registerAllIpc` over the mock set register-all-idempotency.test.ts and
   * register-all-command-terminal-history.test.ts use, keeping the options the notifier and the
   * Command Terminal history were built with, which hold the closures under test.
   */
  async function registerAll(options: { connectAllFails?: boolean } = {}): Promise<RegisterAllCapture> {
    const capture: RegisterAllCapture = { notifierOptions: null, historyDeps: null };
    const { electronMock } = capturingIpcMain();
    installMocks({
      electron: electronMock,
      'node:fs': () => ({
        default: {
          existsSync: vi.fn(() => true),
          readdirSync: vi.fn(() => []),
          rmSync: vi.fn(),
          readFileSync: vi.fn(),
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
          promises: { readdir: vi.fn(() => Promise.resolve([])), rm: vi.fn(() => Promise.resolve()) },
        },
      }),
      'node:crypto': () => ({ randomUUID: vi.fn(() => 'mock-uuid') }),
      '../../src/main/db/database': () => ({
        // Every project's database fails to open with a code defect: the closures under test read it.
        getProjectDb: vi.fn(() => { throw defect(); }),
        getOpenProjectDb: vi.fn(() => null),
        getGlobalDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) })) })),
      }),
      '../../src/main/notifications/desktop-notifier': () => ({
        DesktopNotifier: class {
          constructor(constructorOptions: RegisterAllCapture['notifierOptions']) { capture.notifierOptions = constructorOptions; }
          start = vi.fn();
          dispose = vi.fn();
        },
      }),
      '../../src/main/ipc/helpers/command-terminal-history': () => ({
        CommandTerminalHistory: class {
          start = vi.fn();
          dispose = vi.fn();
          constructor(deps: RegisterAllCapture['historyDeps']) { capture.historyDeps = deps; }
        },
      }),
      '../../src/main/ipc/handlers/metrics-snapshot-timer': () => ({ startMetricsSnapshotTimer: vi.fn(), stopMetricsSnapshotTimer: vi.fn() }),
      '../../src/main/ipc/handlers/session-metrics': () => ({ fillEarlierRunResultTokens: vi.fn() }),
      '../../src/main/db/repositories/project-repository': () => ({ ProjectRepository: class { list = vi.fn(() => []); getById = vi.fn(); } }),
      '../../src/main/db/repositories/project-group-repository': () => ({ ProjectGroupRepository: class { list = vi.fn(() => []); } }),
      '../../src/main/db/repositories/session-repository': () => ({ SessionRepository: class { getEarlierRunToolTotals = vi.fn(); } }),
      '../../src/main/db/repositories/task-repository': () => ({ TaskRepository: class { list = vi.fn(() => []); } }),
      '../../src/main/db/repositories/action-repository': () => ({ ActionRepository: class { getTransitionsFor = vi.fn(() => []); } }),
      '../../src/main/db/repositories/swimlane-repository': () => ({ SwimlaneRepository: class { list = vi.fn(() => []); getById = vi.fn(); } }),
      '../../src/main/pty/session-manager': async () => {
        const { EventEmitter } = await import('node:events');
        return {
          SessionManager: class extends EventEmitter {
            constructor() { super(); this.setMaxListeners(100); }
            listSessions = vi.fn(() => []);
            getSession = vi.fn();
            getActivityCache = vi.fn(() => ({}));
            getActivityReason = vi.fn();
            spawn = vi.fn();
            kill = vi.fn();
            enableTranscripts = vi.fn();
            setRemoteSessionRelay = vi.fn();
            remoteHostRequest = vi.fn();
            setEarlierRunsSource = vi.fn();
            setTaskWindowLookup = vi.fn();
            setAccountHomeResolver = vi.fn();
            getSessionProjectId = vi.fn();
            getSessionAgentName = vi.fn();
            getSessionHomeAccountId = vi.fn(() => null);
            repointAccount = vi.fn(() => []);
            stopProcessByCreationTime = vi.fn();
            setMaxConcurrent = vi.fn();
            setQueueGate = vi.fn();
            drainQueue = vi.fn();
            listColumnHolders = vi.fn(() => []);
          },
        };
      },
      '../../src/main/pty/host/utility-pty-host-transport': () => ({ UtilityPtyHostTransport: class { start = vi.fn(); } }),
      '../../src/main/agent/adapters/claude/detector': () => ({ ClaudeDetector: class { detect = vi.fn(); } }),
      '../../src/main/git/git-detector': () => ({ GitDetector: class { detect = vi.fn(); } }),
      '../../src/main/agent/adapters/claude/command-builder': () => ({ CommandBuilder: class { build = vi.fn(); } }),
      '../../src/main/config/config-manager': () => ({
        ConfigManager: class {
          getEffectiveConfig = vi.fn(() => ({ agent: { maxConcurrentSessions: 8 }, git: {}, terminal: {} }));
          load = vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: true } }));
        },
      }),
      '../../src/main/config/board-config-manager': () => ({
        BoardConfigManager: class { attach = vi.fn(); detach = vi.fn(); setOnConfigApplied = vi.fn(); },
      }),
      '../../src/main/transition-engine/terminal-submit-scheduler': () => ({ TerminalSubmitScheduler: class { cancelAll = vi.fn(); } }),
      '../../src/main/pty/terminal-submit': () => ({ TerminalSubmit: class { submitContent = vi.fn(); submitKeystrokes = vi.fn(); } }),
      '../../src/main/pty/spawn/shell-resolver': () => ({ ShellResolver: class { resolve = vi.fn(); } }),
      '../../src/main/agent/adapters/claude/trust-manager': () => ({ ensureWorktreeTrust: vi.fn() }),
      '../../src/main/agent/adapters/claude/hook-manager': () => ({ buildHooks: vi.fn(), removeHooks: vi.fn() }),
      '../../src/main/analytics/analytics': () => ({
        trackEvent: vi.fn(),
        sanitizeErrorMessage: vi.fn((message: string) => message),
        MAX_ANALYTICS_STRING_LENGTH: 180,
      }),
      'node-pty': () => ({ spawn: vi.fn() }),
      'better-sqlite3': () => ({ default: vi.fn() }),
      '../../src/main/retrieval/retrieval-service': () => ({ retrievalService: { attach: vi.fn(), scheduleCommandTerminalIndex: vi.fn(), searchCommandTerminalText: vi.fn() } }),
      '../../src/main/ipc/handlers/projects': () => ({
        registerProjectHandlers: vi.fn(),
        cleanupProject: vi.fn(),
        deleteProjectFromIndex: vi.fn(),
        pruneStaleWorktreeProjects: vi.fn(),
        openProjectByPath: vi.fn(),
        activateAllProjects: vi.fn(),
        getLastOpenedProject: vi.fn(),
        recoverSessionsAfterPtyHostLoss: vi.fn(),
        recoverRemoteProjectsOnHost: vi.fn(),
      }),
      '../../src/main/ipc/handlers/task-crud': () => ({ registerTaskCrudHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/task-archive': () => ({ registerTaskArchiveHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/task-move': () => ({ registerTaskMoveHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/task-branch': () => ({ registerTaskBranchHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/task-runtime-override': () => ({ registerTaskRuntimeOverrideHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/sessions': () => ({ registerSessionHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/transient-sessions': () => ({
        registerTransientSessionHandlers: vi.fn(),
        isCommandTerminalSlotStarting: vi.fn(() => false),
      }),
      '../../src/main/ipc/handlers/board': () => ({ registerBoardHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/backlog': () => ({ registerBacklogHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/git-diff': () => ({ registerGitDiffHandlers: vi.fn() }),
      '../../src/main/ipc/handlers/system': () => ({ registerSystemHandlers: vi.fn(), showDesktopNotification: vi.fn() }),
      '../../src/main/ipc/handlers/mobile-bridge': () => ({ registerMobileBridgeHandlers: vi.fn() }),
      '../../src/main/mobile-bridge/mobile-bridge-service': () => ({
        MobileBridgeService: class { attachContext = vi.fn(); reconcile = vi.fn(); dispose = vi.fn(); on = vi.fn(); },
      }),
      '../../src/main/plan-approval/plan-approval-writer': () => ({
        startPlanApprovalWriter: vi.fn(),
        refreshPlanApprovals: vi.fn(),
        PlanApprovalWriter: class {},
      }),
      ...(options.connectAllFails
        ? {
          '../../src/main/remote/remote-hosting': async () => {
            const actual = await vi.importActual<typeof import('../../src/main/remote/remote-hosting')>('../../src/main/remote/remote-hosting');
            return {
              ...actual,
              createRemoteHosting: (...hostingArguments: Parameters<typeof actual.createRemoteHosting>) => {
                const hosting = actual.createRemoteHosting(...hostingArguments);
                return Object.assign(hosting, { connectAll: vi.fn(() => Promise.reject(defect())) });
              },
            };
          },
        }
        : {}),
    });
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');
    registerAllIpc({ id: 1, isDestroyed: () => false, isFocused: () => false, webContents: { send: vi.fn() } } as never);
    return capture;
  }

  it('reports a task title read that throws, and sends the notification with no title', async () => {
    const capture = await registerAll();

    expect(capture.notifierOptions?.resolveTaskTitle('project-1', 'task-aaa00001')).toBeUndefined();

    expectOnlyStepReport('system', 'notification_task_title');
  }, 30000);

  it('reports a workflow title read that throws, and sends the notification with no workflow name', async () => {
    const capture = await registerAll();

    expect(capture.notifierOptions?.resolveWorkflowTitle('project-1', 'task-aaa00001')).toBeUndefined();

    expectOnlyStepReport('system', 'notification_workflow_title');
  }, 30000);

  it('reports a failed pass over the SSH hosts after startup', async () => {
    await registerAll({ connectAllFails: true });

    await vi.waitFor(() => expect(stepReports()).toHaveLength(1));
    expectOnlyStepReport('ssh_connect', 'connect_all');
  }, 30000);

  describe('the Earlier list\'s transcript lookup', () => {
    const resumableAdapter = (locateSessionHistoryFile: () => Promise<string | null>) => ({
      supportsCallerSessionId: true,
      capturesInteractiveSessionId: false,
      createSessionId: undefined,
      locateSessionHistoryFile: vi.fn(locateSessionHistoryFile),
    });

    async function availabilityWith(locateSessionHistoryFile: () => Promise<string | null>) {
      const capture = await registerAll();
      const { agentRegistry } = await import('../../src/main/agent/agent-registry');
      vi.spyOn(agentRegistry, 'get').mockReturnValue(resumableAdapter(locateSessionHistoryFile) as never);
      return capture;
    }

    it('reports a lookup that throws and answers that the conversation is still there, so its row is kept', async () => {
      const capture = await availabilityWith(async () => { throw defect(); });

      await expect(capture.historyDeps?.conversationAvailable('claude', 'conversation-1', '/mock/project')).resolves.toBe(true);

      expectOnlyStepReport('command_terminal', 'history_locate');
    }, 30000);

    it('answers that the conversation is gone, and reports nothing, when the lookup finds no transcript', async () => {
      const capture = await availabilityWith(async () => null);

      await expect(capture.historyDeps?.conversationAvailable('claude', 'conversation-2', '/mock/project')).resolves.toBe(false);

      // The SSH hosting that registerAllIpc builds reports its own start-up steps over mocked fs.
      expect(stepReports()).toHaveLength(0);
    }, 30000);
  });
});
