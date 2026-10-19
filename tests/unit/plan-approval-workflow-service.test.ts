/**
 * `setWorkflowPlanApproval` (src/main/workflows/workflow-service.ts) on real,
 * migrated SQLite with two projects.
 *
 * Who approves plans is a setting of the workflow, not part of its plan, so
 * changing it:
 *   - stores the value (automatic, manual, or null to follow the plan columns);
 *   - leaves the workflow's revision where it was, so a save an agent built on
 *     its last read still goes through;
 *   - tells the workflow's view (`notifyWorkflowChanged`);
 *   - announces every board holding one of the workflow's tasks, because the
 *     live sessions' approvers re-read their decision on a board event
 *     (`plan-approval-writer.ts` listens on the board bus). A change that
 *     announced nothing would leave a running session approving by the old
 *     value until some unrelated board change.
 *
 * The announcement only reaches boards that hold real tasks, so these cases use
 * a STARTED workflow across both boards, like the rename case in
 * workflow-service.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const projectDatabase = harness.dbs.get(projectId);
    if (!projectDatabase) throw new Error(`No database for ${projectId}`);
    return projectDatabase;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));

const { notifyWorkflowChanged } = await import('../../src/main/workflows/workflow-changed');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards } from './helpers/workflow-plans';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('setWorkflowPlanApproval', () => {
  let context: IpcContext;

  beforeEach(() => {
    harness.dbs.clear();
    for (const projectId of ['home', 'mobile']) {
      const projectDatabase = openTestDatabase();
      projectDatabase.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(projectDatabase);
      harness.dbs.set(projectId, projectDatabase);
    }
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'mobile', name: 'kangentic-mobile', path: '/projects/mobile' },
    ];
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    vi.mocked(notifyWorkflowChanged).mockClear();
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  const workflowsOf = (projectId: string) => new WorkflowRepository(harness.dbs.get(projectId) as Database.Database);
  const emitBoardChanged = () => vi.mocked(context.boardEvents.emitBoardChanged);
  const boardsAnnounced = (): string[] =>
    [...new Set(emitBoardChanged().mock.calls.map(([event]) => event.projectId))].sort();

  async function startedWorkflow() {
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    return workflow;
  }

  it('stores each value, including null to follow the plan columns', async () => {
    const workflow = await startedWorkflow();
    expect(workflowsOf('home').getById(workflow.id)!.plan_approval).toBeNull();

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');
    expect(workflowsOf('home').getById(workflow.id)!.plan_approval).toBe('automatic');

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'manual');
    expect(workflowsOf('home').getById(workflow.id)!.plan_approval).toBe('manual');

    service.setWorkflowPlanApproval(context, 'home', workflow.id, null);
    expect(workflowsOf('home').getById(workflow.id)!.plan_approval).toBeNull();
  });

  it('does not move the workflow\'s revision, so an agent\'s save built on its last read still goes through', async () => {
    const workflow = await startedWorkflow();
    const revisionBefore = workflowsOf('home').getById(workflow.id)!.revision;

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');
    service.setWorkflowPlanApproval(context, 'home', workflow.id, null);

    expect(workflowsOf('home').getById(workflow.id)!.revision).toBe(revisionBefore);
  });

  it('keeps the revision on a draft too, where a stale-revision check would refuse the agent\'s next save', () => {
    const workflow = planAcrossBoards(service, context);
    const revisionBefore = workflowsOf('home').getById(workflow.id)!.revision;

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');

    expect(workflowsOf('home').getById(workflow.id)!.revision).toBe(revisionBefore);
    expect(() => service.savePlan(context, 'home', workflow.id, {
      revision: revisionBefore,
      tasks: [{ key: 'api', title: 'Budgets API' }],
      links: [],
    })).not.toThrow();
  });

  it('tells the workflow\'s view that it changed', async () => {
    const workflow = await startedWorkflow();
    vi.mocked(notifyWorkflowChanged).mockClear();

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');

    expect(notifyWorkflowChanged).toHaveBeenCalledTimes(1);
    expect(notifyWorkflowChanged).toHaveBeenCalledWith('home', workflow.id);
  });

  it('announces every board holding one of its tasks, so live approvers read the new value', async () => {
    const workflow = await startedWorkflow();
    emitBoardChanged().mockClear();

    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');

    expect(boardsAnnounced()).toEqual(['home', 'mobile']);
  });

  it('announces a clear back to null as well, since a cleared pick changes what the approvers decide', async () => {
    const workflow = await startedWorkflow();
    service.setWorkflowPlanApproval(context, 'home', workflow.id, 'automatic');
    emitBoardChanged().mockClear();

    service.setWorkflowPlanApproval(context, 'home', workflow.id, null);

    expect(boardsAnnounced()).toEqual(['home', 'mobile']);
  });

  it('refuses a workflow that does not exist, storing nothing and announcing nothing', () => {
    emitBoardChanged().mockClear();

    expect(() => service.setWorkflowPlanApproval(context, 'home', 'no-such-workflow', 'automatic'))
      .toThrow(service.WorkflowRequestError);

    expect(notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(emitBoardChanged()).not.toHaveBeenCalled();
  });
});
