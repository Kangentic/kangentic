/**
 * The `resolveWorkflowTitle` option that `registerAllIpc` hands to the
 * `DesktopNotifier` (src/main/ipc/register-all.ts): the title a notification
 * names for the workflow a task is in.
 *
 * The workflow row lives in its HOME project's database, an id the task stores
 * (`workflow_project_id`), which can outlive its project. `getProjectDb` on main
 * creates, migrates and seeds a database for any id it is given, so reading a
 * deleted home through it brings that project's file back, empty. The closure
 * reads through `workflowOfTask` (`getExistingProjectDb`), and a gone home has no
 * title. The read is also in a try that returns undefined, so the mocked
 * `getProjectDb` here records each id it is asked for: a read that opened the
 * gone home shows in that record, not in the title.
 *
 * Which workflow a task is in, and a home that is gone, are covered on their own
 * in workflow-gone-project-reads.test.ts (`workflowOfTask`). This file covers the
 * closure around it, which `registerAllIpc` builds inline and nothing else
 * drives. Its mocks follow register-all-earlier-runs-source.test.ts, except that
 * the repositories and the database are real: a migrated, in-memory SQLite per
 * project.
 *
 * The notifier is replaced by a class that keeps its options, so the test reads
 * the closure the way the notifier would call it.
 *
 * Red-green: put the closure back to reading the home through
 * `getProjectRepos(requireContext(), task.workflow_project_id ?? projectId)`, as
 * it did before `workflowOfTask`, and the gone-home test fails on the recorded
 * `getProjectDb` call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { DesktopNotifierOptions } from '../../src/main/notifications/desktop-notifier';

const { mockHandle, mockOn, harness } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  harness: {
    dbs: new Map<string, unknown>(),
    /** Every project `getProjectDb` was asked for: on main it creates a database that is not there. */
    getProjectDbCalls: [] as string[],
    /** What `registerAllIpc` built the notifier with. */
    notifierOptions: null as unknown,
  },
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

// A project's database is a real, migrated one held in the harness, or it is absent.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    harness.getProjectDbCalls.push(projectId);
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getOpenProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
}));

// Keeps the options it was built with, which hold the closure under test.
vi.mock('../../src/main/notifications/desktop-notifier', () => ({
  DesktopNotifier: class {
    constructor(options: unknown) {
      harness.notifierOptions = options;
    }
    start = vi.fn();
    dispose = vi.fn();
  },
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
vi.mock('../../src/main/ipc/handlers/system', () => ({
  registerSystemHandlers: vi.fn(),
  showDesktopNotification: vi.fn(),
}));
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

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');

import { openTestDatabase } from './helpers/test-database';

const WORKFLOW_TITLE = 'Usage budgets';

describe('registerAllIpc workflow title for a notification', () => {
  let resolveWorkflowTitle: DesktopNotifierOptions['resolveWorkflowTitle'];

  beforeAll(async () => {
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');
    registerAllIpc({ id: 1, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow);

    // Captured now: the options the notifier was built with hold the closure.
    expect(harness.notifierOptions, 'registerAllIpc must build the DesktopNotifier with its options').not.toBeNull();
    resolveWorkflowTitle = (harness.notifierOptions as DesktopNotifierOptions).resolveWorkflowTitle;
  }, 30000);

  function database(projectId: string): Database.Database {
    const projectDatabase = openTestDatabase();
    projectDatabase.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(projectDatabase);
    harness.dbs.set(projectId, projectDatabase);
    return projectDatabase;
  }

  /** A task on `mobile`: in the given workflow, homed on the given project (null stores no home), or in none. */
  function taskOnMobile(workflow: { workflowId: string; workflowProjectId: string | null } | null): string {
    const mobileDatabase = harness.dbs.get('mobile') as Database.Database;
    const todoLane = new SwimlaneRepository(mobileDatabase).list().find((lane) => lane.role === 'todo')!;
    return new TaskRepository(mobileDatabase).create({
      title: 'Budgets on the phone',
      description: '',
      swimlane_id: todoLane.id,
      workflow: workflow ? {
        workflow_id: workflow.workflowId,
        workflow_project_id: workflow.workflowProjectId,
        route_start_swimlane_id: null,
        route_last_swimlane_id: null,
        skipped_swimlane_ids: [],
        canvas_x: null,
        canvas_y: null,
      } : undefined,
    }).id;
  }

  beforeEach(() => {
    harness.dbs.clear();
    harness.getProjectDbCalls.length = 0;
    database('home');
    database('mobile');
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  it('names the workflow of a task whose home project is another project than its own', () => {
    const workflow = new WorkflowRepository(harness.dbs.get('home') as Database.Database).create({ title: WORKFLOW_TITLE });
    const taskId = taskOnMobile({ workflowId: workflow.id, workflowProjectId: 'home' });

    expect(resolveWorkflowTitle('mobile', taskId)).toBe(WORKFLOW_TITLE);
  });

  it('names the workflow of a task whose home is its own project, which it stores as no home', () => {
    const workflow = new WorkflowRepository(harness.dbs.get('mobile') as Database.Database).create({ title: WORKFLOW_TITLE });
    const taskId = taskOnMobile({ workflowId: workflow.id, workflowProjectId: null });

    expect(resolveWorkflowTitle('mobile', taskId)).toBe(WORKFLOW_TITLE);
  });

  it('names nothing for a task whose workflow home is gone, and does not open that home\'s database', () => {
    // A workflow homed on a project deleted since: no database, and no registry row.
    const taskId = taskOnMobile({ workflowId: 'workflow-of-a-deleted-project', workflowProjectId: 'deleted-home' });
    harness.getProjectDbCalls.length = 0;

    expect(resolveWorkflowTitle('mobile', taskId)).toBeUndefined();
    expect(harness.getProjectDbCalls).not.toContain('deleted-home');
  });

  it('names nothing for a task outside a workflow', () => {
    expect(resolveWorkflowTitle('mobile', taskOnMobile(null))).toBeUndefined();
  });

  it('names nothing for a task that no longer exists', () => {
    expect(resolveWorkflowTitle('mobile', 'task-that-was-deleted')).toBeUndefined();
  });
});
