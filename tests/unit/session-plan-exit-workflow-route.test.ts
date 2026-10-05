/**
 * The `plan-exit` listener in registerSessionHandlers: where an approved plan
 * sends the task.
 *
 * An ordinary task leaves plan mode for its column's `plan_exit_target_id`. A
 * workflow task's approval finishes its STEP, so it moves to the next column on
 * its ROUTE, wherever the column would have sent an ordinary task. The two only
 * differ when the route skips the column `plan_exit_target_id` names, and that
 * is the fixture: the seeded board points Planning's `plan_exit_target_id` at
 * Executing, and the workflow task's route skips Executing. A test whose route
 * did not skip it would pass against the ordinary-task code too.
 *
 * Real repositories over a migrated database, so `nextOnRoute` and the column
 * lookups read what production reads. The move itself is mocked: the listener
 * swallows every throw into `console.error`, so the tests also assert nothing
 * was logged, or a wiring mistake would read as "never moved".
 *
 * Mock strategy for the rest mirrors session-branch-pushed-record.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();
const harness = vi.hoisted(() => ({ repos: null as unknown }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
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

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
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
  getProjectRepos: vi.fn(() => harness.repos),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
  notifySpawnBlocked: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import type { Task } from '../../src/shared/types';

import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/mock/project';
const SESSION_ID = 'session-plan-exit';

function createMockContext() {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => 'task-1' as string | null | undefined),
      getSessionProjectId: vi.fn(() => PROJECT_ID as string | null | undefined),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: PROJECT_PATH })),
    },
  };
}

async function firePlanExit(sessionId: string): Promise<void> {
  const handler = capturedSessionEventHandlers.get('plan-exit');
  if (!handler) throw new Error('plan-exit handler was not registered');
  await handler(sessionId);
}

describe('plan-exit moves the task to where its approved plan sends it', () => {
  let database: Database.Database;
  let tasks: TaskRepository;
  let laneIds: Record<string, string>;
  let workflowId: string;
  let context: ReturnType<typeof createMockContext>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();

    database = openTestDatabase();
    runProjectMigrations(database);
    tasks = new TaskRepository(database);
    const swimlanes = new SwimlaneRepository(database);
    harness.repos = { tasks, swimlanes };

    laneIds = {};
    for (const lane of swimlanes.list()) laneIds[lane.name] = lane.id;

    const workflows = new WorkflowRepository(database);
    workflowId = workflows.create({ title: 'Usage budgets' }).id;
    workflows.markStarted(workflowId);

    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    context = createMockContext();
    registerSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness.repos = null;
    database.close();
  });

  /** A task in Planning with a live session, ready for its plan to be approved. */
  function planningTask(workflow: boolean): Task {
    const task = tasks.create({
      title: 'Budgets API',
      description: '',
      swimlane_id: laneIds['Planning'],
      ...(workflow
        ? {
            workflow: {
              workflow_id: workflowId,
              workflow_project_id: PROJECT_ID,
              route_start_swimlane_id: null,
              route_last_swimlane_id: null,
              // The board's own plan-exit target. A route that visits it would not discriminate.
              skipped_swimlane_ids: [laneIds['Executing']],
              canvas_x: null,
              canvas_y: null,
            },
          }
        : {}),
    });
    database.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(SESSION_ID, task.id);
    return task;
  }

  it('sends a workflow task to the next column on its route, not to plan_exit_target_id', async () => {
    const task = planningTask(true);
    const planning = new SwimlaneRepository(database).getById(laneIds['Planning']);
    // The precondition that makes this test discriminating: the ordinary
    // destination is Executing, and the route skips it.
    expect(planning?.plan_exit_target_id).toBe(laneIds['Executing']);

    await firePlanExit(SESSION_ID);

    expect(consoleError).not.toHaveBeenCalled();
    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(handleTaskMove).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Code Review'] }),
      'auto-move',
      PROJECT_ID,
      PROJECT_PATH,
      { continuationPrompt: expect.any(String) },
    );
  });

  it('sends an ordinary task to its column\'s plan_exit_target_id', async () => {
    const task = planningTask(false);

    await firePlanExit(SESSION_ID);

    expect(consoleError).not.toHaveBeenCalled();
    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(handleTaskMove).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ taskId: task.id, targetSwimlaneId: laneIds['Executing'] }),
      'auto-move',
      PROJECT_ID,
      PROJECT_PATH,
      { continuationPrompt: expect.any(String) },
    );
  });
});
