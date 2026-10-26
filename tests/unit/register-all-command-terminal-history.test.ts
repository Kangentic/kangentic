/**
 * The `CommandTerminalHistory` deps that `registerAllIpc` builds inline
 * (src/main/ipc/register-all.ts): the glue between the history class and the
 * rest of main.
 *
 * `command-terminal-history.test.ts` drives the class against a stub for both
 * deps, and the repository has its own tests. Nothing drove the two closures
 * register-all.ts passes in, so a dropped resume gate, a transposed argument or
 * a throw that escapes stayed green everywhere else:
 *
 *  - `getRepository(projectId)` builds a repository on that project's database
 *    and answers null when the database cannot be opened.
 *  - `conversationAvailable(agentName, agentSessionId, cwd)` answers whether the
 *    Earlier list may still offer the conversation: false for an agent nobody
 *    registered, false for one that cannot resume by id (without ever looking for
 *    a transcript), false when the transcript is gone or the lookup throws, and
 *    true when the adapter finds the file.
 *
 * Like register-all-earlier-runs-source.test.ts this registers the real
 * `registerAllIpc` over the same mock set and swaps `CommandTerminalHistory` for
 * a class that records the deps it was built with.
 *
 * Red-green, from toggling register-all.ts and restoring it:
 *  - drop `|| !canResumeConversationById(adapter)`: the cannot-resume test sees
 *    true (its adapter finds a transcript) and fails.
 *  - drop the `try`/`catch` around `locateSessionHistoryFile`: the throwing
 *    lookup rejects and its test fails.
 *  - swap `agentSessionId` and `cwd` in the `locateSessionHistoryFile` call: the
 *    argument-order test fails.
 *  - drop the `try`/`catch` around `getProjectDb`: `getRepository` throws
 *    instead of answering null, and the unopenable-database test fails.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { CommandTerminalHistoryDeps } from '../../src/main/ipc/helpers/command-terminal-history';

// Hoisted spies, referenced inside the vi.mock factories below.

const {
  mockHandle,
  mockOn,
  mockGetProjectDb,
  capturedHistoryDeps,
  constructedRepositories,
} = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  mockGetProjectDb: vi.fn(),
  capturedHistoryDeps: [] as unknown[],
  constructedRepositories: [] as Array<{ database: unknown }>,
}));

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

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: mockGetProjectDb,
  getOpenProjectDb: vi.fn(),
}));

// Keeps the database it was built from, so a test can tell which one a repository holds.
vi.mock('../../src/main/db/repositories/command-terminal-history-repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/db/repositories/command-terminal-history-repository')>();
  return {
    ...original,
    CommandTerminalHistoryRepository: class {
      database: unknown;
      constructor(database: unknown) {
        this.database = database;
        constructedRepositories.push(this);
      }
    },
  };
});

// Records the deps register-all.ts hands it. The class itself is covered in
// command-terminal-history.test.ts.
vi.mock('../../src/main/ipc/helpers/command-terminal-history', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/ipc/helpers/command-terminal-history')>();
  return {
    ...original,
    CommandTerminalHistory: class {
      start = vi.fn();
      dispose = vi.fn();
      constructor(deps: unknown) {
        capturedHistoryDeps.push(deps);
      }
    },
  };
});

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  fillEarlierRunResultTokens: vi.fn(),
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
  readTranscriptToolResultTokens: vi.fn(),
}));

// A real timer would start; the snapshot timer is irrelevant to this wiring.
vi.mock('../../src/main/ipc/handlers/metrics-snapshot-timer', () => ({
  startMetricsSnapshotTimer: vi.fn(),
  stopMetricsSnapshotTimer: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { getEarlierRunToolTotals = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/project-group-repository', () => ({
  ProjectGroupRepository: class { list = vi.fn(() => []); },
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
vi.mock('../../src/main/pty/session-manager', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    SessionManager: class extends EventEmitter {
      listSessions = vi.fn(() => []);
      spawn = vi.fn();
      kill = vi.fn();
      enableTranscripts = vi.fn();
      setEarlierRunsSource = vi.fn();
      getSessionProjectId = vi.fn((_sessionId: string): string | undefined => undefined);
      setMaxConcurrent = vi.fn();
    },
  };
});
// The real transport forks the pty host utility process.
vi.mock('../../src/main/pty/host/utility-pty-host-transport', () => ({
  UtilityPtyHostTransport: class { start = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/detector', () => ({
  ClaudeDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/git/git-detector', () => ({
  GitDetector: class { detect = vi.fn(); },
}));
vi.mock('../../src/main/agent/adapters/claude/command-builder', () => ({
  CommandBuilder: class { build = vi.fn(); },
}));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig = vi.fn(() => ({ agent: { maxConcurrentSessions: 8 }, git: {}, terminal: {} })); },
}));
vi.mock('../../src/main/config/board-config-manager', () => ({
  BoardConfigManager: class {
    attach = vi.fn();
    detach = vi.fn();
  },
}));
vi.mock('../../src/main/transition-engine/terminal-submit-scheduler', () => ({
  TerminalSubmitScheduler: class { cancelAll = vi.fn(); },
}));
vi.mock('../../src/main/pty/terminal-submit', () => ({
  TerminalSubmit: class {
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
// Not importOriginal'd: the real analytics.ts pulls in a package whose own
// `from 'electron'` bypasses the mock above (see register-all-idempotency.test.ts).
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
  MAX_ANALYTICS_STRING_LENGTH: 180,
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));
vi.mock('simple-git', () => ({ simpleGit: vi.fn(() => ({})) }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { attach: vi.fn() },
}));

// Every handler registration register-all.ts calls that the idempotency suite
// mocks. Anything left real pulls its whole dependency graph into this worker.
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  registerProjectHandlers: vi.fn(),
  cleanupProject: vi.fn(),
  deleteProjectFromIndex: vi.fn(),
  pruneStaleWorktreeProjects: vi.fn(),
  openProjectByPath: vi.fn(),
  activateAllProjects: vi.fn(),
  getLastOpenedProject: vi.fn(),
  recoverSessionsAfterPtyHostLoss: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-crud', () => ({ registerTaskCrudHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-archive', () => ({ registerTaskArchiveHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ registerTaskMoveHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-branch', () => ({ registerTaskBranchHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({
  registerTaskRuntimeOverrideHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/transient-sessions', () => ({
  registerTransientSessionHandlers: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/board', () => ({ registerBoardHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ registerBacklogHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/git-diff', () => ({ registerGitDiffHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ registerSystemHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/mobile-bridge', () => ({ registerMobileBridgeHandlers: vi.fn() }));
vi.mock('../../src/main/mobile-bridge/mobile-bridge-service', () => ({
  MobileBridgeService: class {
    attachContext = vi.fn();
    reconcile = vi.fn();
    dispose = vi.fn();
    on = vi.fn();
  },
}));
// registerAllIpc starts the plan approval writer, which calls
// sessionManager.setPlanApprovalLookup. The fake SessionManager above does not
// model that, and the registration is pinned in register-all-idempotency.test.ts.
vi.mock('../../src/main/plan-approval/plan-approval-writer', () => ({
  startPlanApprovalWriter: vi.fn(),
  refreshPlanApprovals: vi.fn(),
  PlanApprovalWriter: class {},
}));

// Imported after the mocks. The same module instance register-all.ts reads, so a
// spy on it is seen by the closure under test.
import { agentRegistry } from '../../src/main/agent/agent-registry';

// Fixtures.

type AdapterResumeFields = Pick<AgentAdapter, 'supportsCallerSessionId' | 'capturesInteractiveSessionId' | 'createSessionId'>;

/** An adapter that can resume a conversation by id, because Kangentic chose the id. */
const RESUMABLE_BY_ID: AdapterResumeFields = {
  supportsCallerSessionId: true,
  capturesInteractiveSessionId: false,
  createSessionId: undefined,
};

/** An adapter with no way to resume by id: no caller id, no id of its own, no capture. */
const NOT_RESUMABLE_BY_ID: AdapterResumeFields = {
  supportsCallerSessionId: false,
  capturesInteractiveSessionId: false,
  createSessionId: undefined,
};

function makeAdapter(
  resume: AdapterResumeFields,
  locateSessionHistoryFile: (agentSessionId: string, cwd: string) => Promise<string | null>,
): AgentAdapter {
  return { ...resume, locateSessionHistoryFile: vi.fn(locateSessionHistoryFile) } as unknown as AgentAdapter;
}

function locateMock(adapter: AgentAdapter): ReturnType<typeof vi.fn> {
  return adapter.locateSessionHistoryFile as unknown as ReturnType<typeof vi.fn>;
}

// Tests.

describe('registerAllIpc command terminal history deps', () => {
  let deps: CommandTerminalHistoryDeps;
  let agentRegistryGet: MockInstance<(name: string) => AgentAdapter | undefined>;

  beforeAll(async () => {
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');
    registerAllIpc({ id: 1, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow);

    expect(capturedHistoryDeps, 'registerAllIpc must build one CommandTerminalHistory').toHaveLength(1);
    deps = capturedHistoryDeps[0] as CommandTerminalHistoryDeps;
  }, 30000);

  beforeEach(() => {
    mockGetProjectDb.mockReset();
    constructedRepositories.length = 0;
    agentRegistryGet = vi.spyOn(agentRegistry, 'get');
  });

  afterEach(() => {
    agentRegistryGet.mockRestore();
  });

  describe('getRepository', () => {
    it('builds a repository on the database of the project asked for', () => {
      const projectDatabase = { name: 'database of project-7' };
      mockGetProjectDb.mockReturnValue(projectDatabase);

      const repository = deps.getRepository('project-7');

      expect(mockGetProjectDb).toHaveBeenCalledWith('project-7');
      expect(constructedRepositories).toHaveLength(1);
      expect(repository).toBe(constructedRepositories[0]);
      expect(constructedRepositories[0].database).toBe(projectDatabase);
    });

    it('answers null, and builds nothing, when the project database cannot be opened', () => {
      mockGetProjectDb.mockImplementation(() => {
        throw new Error('unable to open database file');
      });

      expect(deps.getRepository('project-gone')).toBeNull();

      expect(mockGetProjectDb).toHaveBeenCalledWith('project-gone');
      expect(constructedRepositories).toHaveLength(0);
    });
  });

  describe('conversationAvailable', () => {
    it('answers false for an agent nobody registered', async () => {
      agentRegistryGet.mockReturnValue(undefined);

      await expect(deps.conversationAvailable('retired-agent', 'conversation-1', '/mock/project')).resolves.toBe(false);

      expect(agentRegistryGet).toHaveBeenCalledWith('retired-agent');
    });

    it('answers false, without looking for a transcript, for an agent that cannot resume by id', async () => {
      // The transcript is there: only the resume gate can turn this answer to false.
      const adapter = makeAdapter(NOT_RESUMABLE_BY_ID, async () => '/mock/transcripts/conversation-2.jsonl');
      agentRegistryGet.mockReturnValue(adapter);

      await expect(deps.conversationAvailable('no-resume-agent', 'conversation-2', '/mock/project')).resolves.toBe(false);

      expect(locateMock(adapter)).not.toHaveBeenCalled();
    });

    it('answers false when the adapter finds no transcript', async () => {
      const adapter = makeAdapter(RESUMABLE_BY_ID, async () => null);
      agentRegistryGet.mockReturnValue(adapter);

      await expect(deps.conversationAvailable('resumable-agent', 'conversation-3', '/mock/project')).resolves.toBe(false);

      expect(locateMock(adapter)).toHaveBeenCalledTimes(1);
    });

    it('answers false instead of rejecting when the transcript lookup throws', async () => {
      const adapter = makeAdapter(RESUMABLE_BY_ID, async () => {
        throw new Error('EACCES: permission denied, scandir');
      });
      agentRegistryGet.mockReturnValue(adapter);

      await expect(deps.conversationAvailable('resumable-agent', 'conversation-4', '/mock/project')).resolves.toBe(false);
    });

    it('answers true when the adapter finds the transcript', async () => {
      const adapter = makeAdapter(RESUMABLE_BY_ID, async () => '/mock/transcripts/conversation-5.jsonl');
      agentRegistryGet.mockReturnValue(adapter);

      await expect(deps.conversationAvailable('resumable-agent', 'conversation-5', '/mock/project')).resolves.toBe(true);
    });

    it('looks the agent up by name and asks it for the conversation id, then the folder', async () => {
      const adapter = makeAdapter(RESUMABLE_BY_ID, async () => '/mock/transcripts/found.jsonl');
      agentRegistryGet.mockReturnValue(adapter);

      await deps.conversationAvailable('named-agent', 'conversation-6', '/mock/project-6');

      expect(agentRegistryGet).toHaveBeenCalledWith('named-agent');
      expect(locateMock(adapter)).toHaveBeenCalledWith('conversation-6', '/mock/project-6');
    });
  });
});
