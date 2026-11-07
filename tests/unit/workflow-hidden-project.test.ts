/**
 * A workflow with tasks on a project hidden because its SSH host was removed (#913), on real, migrated SQLite
 * with two boards. The owner's decision: it pauses, says why, and cannot resume while those tasks are out of
 * reach. A workflow that kept running could finish with them undone.
 *
 * What a user loses if it breaks: a workflow marked complete with work unfinished, agents left running on the
 * other boards with no way to see why nothing advances, or a Resume that starts them again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn(async () => 'not-live') }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/workflows/workflow-changed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-changed')>()),
  notifyWorkflowChanged: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-agent')>()),
  endWorkflowAgent: vi.fn(async () => undefined),
}));

const { pauseTaskSession } = await import('../../src/main/ipc/handlers/session-pause');
const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { listWorkflowSummaries } = await import('../../src/main/workflows/workflow-view-service');
const { pauseWorkflowsOfProject } = await import('../../src/main/workflows/workflow-hidden-project');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Workflow } from '../../src/shared/types';

describe('a workflow with tasks on a hidden project', () => {
  let context: IpcContext;
  let hidden: Set<string>;

  function database(projectId: string): void {
    const db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    harness.dbs.set(projectId, db);
  }

  const workflowsOf = (projectId: string) => new WorkflowRepository(harness.dbs.get(projectId) as Database.Database);

  async function startedWorkflow(homeProjectId: string): Promise<Workflow> {
    const workflow = service.createWorkflow(homeProjectId, {});
    service.savePlan(context, homeProjectId, workflow.id, {
      title: 'Usage budgets',
      tasks: [
        { key: 'home-task', title: 'Home task', project: 'kangentic' },
        { key: 'api-task', title: 'API task', project: 'kangentic-api' },
      ],
      links: [],
    });
    await service.startWorkflow(context, homeProjectId, workflow.id);
    return workflowsOf(homeProjectId).getById(workflow.id)!;
  }

  beforeEach(() => {
    harness.dbs.clear();
    database('home');
    database('api');
    hidden = new Set();
    const projects = [
      { id: 'home', name: 'kangentic', path: '/projects/home' },
      { id: 'api', name: 'kangentic-api', path: '/projects/api' },
    ];
    context = {
      projectRepo: {
        list: () => projects.filter((project) => !hidden.has(project.id)),
        listHidden: () => projects.filter((project) => hidden.has(project.id)),
        isHidden: (id: string) => hidden.has(id),
        getById: (id: string) => projects.find((project) => project.id === id && !hidden.has(id)),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { listSessions: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(pauseTaskSession).mockClear();
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
    vi.restoreAllMocks();
  });

  it('pauses a running workflow homed elsewhere, and reaches every member while its board is still visible', async () => {
    const workflow = await startedWorkflow('home');

    await pauseWorkflowsOfProject(context, 'api');

    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('paused');
    expect(vi.mocked(pauseTaskSession).mock.calls.map(([, , options]) => options?.projectId).sort()).toEqual(['api', 'home']);
  });

  it('pauses a workflow homed on the hidden project', async () => {
    const workflow = await startedWorkflow('api');

    await pauseWorkflowsOfProject(context, 'api');

    expect(workflowsOf('api').getById(workflow.id)?.state).toBe('paused');
  });

  it('leaves a workflow it has no part in, and one a person already paused', async () => {
    const unrelated = service.createWorkflow('home', {});
    const paused = await startedWorkflow('home');
    workflowsOf('home').setState(paused.id, 'paused');
    const pausedAt = workflowsOf('home').getById(paused.id)?.paused_at;

    await pauseWorkflowsOfProject(context, 'api');

    expect(workflowsOf('home').getById(unrelated.id)?.state).toBe('draft');
    expect(workflowsOf('home').getById(paused.id)?.paused_at).toBe(pausedAt);
  });

  it('says which project holds it, for as long as that project is hidden', async () => {
    const workflow = await startedWorkflow('home');
    await pauseWorkflowsOfProject(context, 'api');
    const summary = () => listWorkflowSummaries(context, 'home').find((entry) => entry.workflow.id === workflow.id)!;

    expect(summary().hiddenBoards).toEqual([]);
    hidden.add('api');
    expect(summary().hiddenBoards).toEqual(['kangentic-api']);
    hidden.delete('api');
    expect(summary().hiddenBoards).toEqual([]);
  });

  it('clears the membership of a task on a hidden board when the workflow is deleted, and does not offer it for deletion', async () => {
    const workflow = await startedWorkflow('home');
    const membershipOf = (projectId: string): Array<{ title: string; workflow_id: string | null }> =>
      (harness.dbs.get(projectId) as Database.Database).prepare('SELECT title, workflow_id FROM tasks').all() as Array<{ title: string; workflow_id: string | null }>;
    expect(membershipOf('api')).toEqual([{ title: 'API task', workflow_id: workflow.id }]);
    hidden.add('api');

    const { released } = service.deleteWorkflow(context, 'home', workflow.id);

    expect(membershipOf('api')).toEqual([{ title: 'API task', workflow_id: null }]);
    expect(membershipOf('home')).toEqual([{ title: 'Home task', workflow_id: null }]);
    expect(released.map((entry) => entry.projectId)).toEqual(['home']);
  });

  it('refuses Resume with the reason while its tasks are hidden, and resumes once they are back', async () => {
    const workflow = await startedWorkflow('home');
    await pauseWorkflowsOfProject(context, 'api');
    hidden.add('api');

    await expect(service.resumeWorkflow(context, 'home', workflow.id, 'a test')).rejects.toThrow('kangentic-api');
    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('paused');

    hidden.delete('api');
    await service.resumeWorkflow(context, 'home', workflow.id, 'a test');
    expect(workflowsOf('home').getById(workflow.id)?.state).toBe('running');
  });
});
