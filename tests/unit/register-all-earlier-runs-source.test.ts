/**
 * The `EarlierRunsSource` that `registerAllIpc` hands to
 * `sessionManager.setEarlierRunsSource` (src/main/ipc/register-all.ts).
 *
 * SessionManager's own use of the source is covered in
 * session-manager-earlier-runs.test.ts (against a stub source), and the
 * repository read and the Tokens fill are covered on their own. Nothing drove
 * the two closures register-all.ts builds inline, which are the glue between
 * them: pick the session's project database WITHOUT opening it again, then call
 * the right repository method with the right track identity. A dropped null
 * guard, a transposed argument, or a reopened database stays green everywhere
 * else.
 *
 * This file mocks `handlers/sessions` (as register-all-idempotency.test.ts
 * does), so it cannot also drive the real SESSION_GET_TOOL_BREAKDOWN handler;
 * that lives in session-tool-breakdown-ipc-wiring.test.ts.
 *
 * Red-green, from the code (nothing was toggled):
 *  - drop the `if (!db)` guard in readToolTotals: the null-database test
 *    constructs a repository and calls the spy, so it fails.
 *  - drop `?? null` after `session.isolatedSwimlaneId`: the undefined-swimlane
 *    test sees `undefined` where it expects `null` (toHaveBeenCalledWith
 *    distinguishes them) and fails.
 *  - swap taskId and session.id, or change either: the argument assertions fail.
 *  - read the database with getProjectDb instead of getOpenProjectDb: the
 *    "never opened again" assertions fail.
 *  - drop `{ queued: true }` or the `if (!db) return false` guard in
 *    fillMissingResultTokens: its option and null-database tests fail.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Session } from '../../src/shared/types';
import type { EarlierRunsSource } from '../../src/main/pty/session-manager';

// Hoisted spies, referenced inside the vi.mock factories below.

const {
  mockHandle,
  mockOn,
  mockSetEarlierRunsSource,
  mockGetOpenProjectDb,
  mockGetProjectDb,
  mockGetEarlierRunToolTotals,
  mockFillEarlierRunResultTokens,
  constructedRepositories,
} = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  mockSetEarlierRunsSource: vi.fn(),
  mockGetOpenProjectDb: vi.fn(),
  mockGetProjectDb: vi.fn(),
  mockGetEarlierRunToolTotals: vi.fn(),
  mockFillEarlierRunResultTokens: vi.fn(),
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

// The two database accessors the source reaches for. getProjectDb is the
// "open it again" path the source must NOT take.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: mockGetProjectDb,
  getOpenProjectDb: mockGetOpenProjectDb,
}));

// Keeps the database it was built from and shares one spy for the repository
// method under test, so a test can tell which database a repository holds.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    database: unknown;
    getEarlierRunToolTotals = mockGetEarlierRunToolTotals;
    constructor(database: unknown) {
      this.database = database;
      constructedRepositories.push(this);
    }
  },
}));

// The Tokens fill is covered in earlier-run-result-tokens.test.ts. Here it is
// only the call register-all.ts forwards to.
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  fillEarlierRunResultTokens: mockFillEarlierRunResultTokens,
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
      setEarlierRunsSource = mockSetEarlierRunsSource;
      getSessionProjectId = vi.fn((_sessionId: string): string | undefined => undefined);
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
  ConfigManager: class { getEffectiveConfig = vi.fn(() => ({ claude: {}, git: {}, terminal: {} })); },
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
vi.mock('simple-git', () => ({ default: vi.fn(() => ({})) }));
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

// Fixtures.

const SENTINEL_TOTALS = {
  toolCallCount: 7,
  toolBreakdown: [{ toolName: 'Read', callCount: 7, totalDurationMs: 0, interruptedCount: 0 }],
};

function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    ...overrides,
  } as unknown as Session;
}

// Tests.

describe('registerAllIpc earlier-runs source', () => {
  let source: EarlierRunsSource;
  let sessionManagerFromContext: unknown;

  beforeAll(async () => {
    const { registerAllIpc, getSessionManager } = await import('../../src/main/ipc/register-all');
    registerAllIpc({ id: 1, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow);

    // Captured now, before any beforeEach resets the spy's call record.
    expect(mockSetEarlierRunsSource, 'registerAllIpc must wire an earlier-runs source into the SessionManager').toHaveBeenCalledTimes(1);
    source = mockSetEarlierRunsSource.mock.calls[0][0] as EarlierRunsSource;
    sessionManagerFromContext = getSessionManager();
  }, 30000);

  beforeEach(() => {
    mockGetOpenProjectDb.mockReset();
    mockGetProjectDb.mockReset();
    mockGetEarlierRunToolTotals.mockReset();
    mockFillEarlierRunResultTokens.mockReset();
    constructedRepositories.length = 0;
    mockGetEarlierRunToolTotals.mockReturnValue(SENTINEL_TOTALS);
  });

  describe('readToolTotals', () => {
    it('contributes nothing, and builds no repository, when the project database is not open', () => {
      mockGetOpenProjectDb.mockReturnValue(null);

      const totals = source.readToolTotals(buildSession());

      expect(totals).toEqual({ toolCallCount: 0, toolBreakdown: [] });
      // The spy would return SENTINEL_TOTALS, so reaching the repository
      // (a dropped guard) cannot also produce the zero totals above.
      expect(mockGetEarlierRunToolTotals).not.toHaveBeenCalled();
      expect(constructedRepositories).toHaveLength(0);
    });

    it('looks the session\'s own project up without opening it again', () => {
      mockGetOpenProjectDb.mockReturnValue(null);

      source.readToolTotals(buildSession({ projectId: 'project-xyz' }));

      expect(mockGetOpenProjectDb).toHaveBeenCalledWith('project-xyz');
      expect(mockGetProjectDb).not.toHaveBeenCalled();
    });

    it('reads the track\'s earlier totals through a repository built on that project\'s database, with null for an undefined isolated swimlane', () => {
      const projectDatabase = { name: 'open project database' };
      mockGetOpenProjectDb.mockReturnValue(projectDatabase);

      const totals = source.readToolTotals(buildSession({ id: 'session-9', taskId: 'task-9', isolatedSwimlaneId: undefined }));

      expect(totals).toBe(SENTINEL_TOTALS);
      expect(constructedRepositories).toHaveLength(1);
      expect(constructedRepositories[0].database).toBe(projectDatabase);
      // (taskId, isolatedSwimlaneId, excludeRecordId): the live record is the
      // session's own id. toHaveBeenCalledWith treats undefined and null as
      // different, so a dropped `?? null` fails here.
      expect(mockGetEarlierRunToolTotals).toHaveBeenCalledTimes(1);
      expect(mockGetEarlierRunToolTotals).toHaveBeenCalledWith('task-9', null, 'session-9');
      expect(mockGetProjectDb).not.toHaveBeenCalled();
    });

    it('passes a defined isolated swimlane id through unchanged', () => {
      mockGetOpenProjectDb.mockReturnValue({});

      source.readToolTotals(buildSession({ id: 'session-3', taskId: 'task-3', isolatedSwimlaneId: 'lane-iso' }));

      expect(mockGetEarlierRunToolTotals).toHaveBeenCalledWith('task-3', 'lane-iso', 'session-3');
    });

    it('keeps an explicit null isolated swimlane as null', () => {
      mockGetOpenProjectDb.mockReturnValue({});

      source.readToolTotals(buildSession({ id: 'session-4', taskId: 'task-4', isolatedSwimlaneId: null }));

      expect(mockGetEarlierRunToolTotals).toHaveBeenCalledWith('task-4', null, 'session-4');
    });
  });

  describe('fillMissingResultTokens', () => {
    it('resolves false, and never starts a fill, when the project database is not open', async () => {
      mockGetOpenProjectDb.mockReturnValue(null);
      // Would resolve true if a dropped guard reached the fill.
      mockFillEarlierRunResultTokens.mockResolvedValue(true);

      await expect(source.fillMissingResultTokens(buildSession({ projectId: 'project-gone' }))).resolves.toBe(false);

      expect(mockGetOpenProjectDb).toHaveBeenCalledWith('project-gone');
      expect(mockGetProjectDb).not.toHaveBeenCalled();
      expect(mockFillEarlierRunResultTokens).not.toHaveBeenCalled();
      expect(constructedRepositories).toHaveLength(0);
    });

    it('fills through the SessionManager, a repository on the open database, the session id, and the queued option', async () => {
      const projectDatabase = { name: 'open project database' };
      mockGetOpenProjectDb.mockReturnValue(projectDatabase);
      mockFillEarlierRunResultTokens.mockResolvedValue(true);

      const changed = await source.fillMissingResultTokens(buildSession({ id: 'session-5', projectId: 'project-5' }));

      expect(changed).toBe(true);
      expect(mockGetOpenProjectDb).toHaveBeenCalledWith('project-5');
      expect(mockGetProjectDb).not.toHaveBeenCalled();
      expect(constructedRepositories).toHaveLength(1);
      expect(constructedRepositories[0].database).toBe(projectDatabase);

      expect(mockFillEarlierRunResultTokens).toHaveBeenCalledTimes(1);
      const [sessionManagerArgument, repositoryArgument, sessionIdArgument, optionsArgument] =
        mockFillEarlierRunResultTokens.mock.calls[0];
      expect(sessionManagerArgument).toBe(sessionManagerFromContext);
      expect(repositoryArgument).toBe(constructedRepositories[0]);
      expect(sessionIdArgument).toBe('session-5');
      // A spawn-time fill runs behind the other background transcript reads.
      expect(optionsArgument).toEqual({ queued: true });
    });

    it('resolves to the fill\'s own answer, so an unchanged track reports false', async () => {
      mockGetOpenProjectDb.mockReturnValue({});
      mockFillEarlierRunResultTokens.mockResolvedValue(false);

      await expect(source.fillMissingResultTokens(buildSession())).resolves.toBe(false);
      expect(mockFillEarlierRunResultTokens).toHaveBeenCalledTimes(1);
    });
  });
});
