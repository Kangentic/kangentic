/**
 * `adoptLegacyPlanApproval` (src/main/plan-approval/workflow-plan-approval.ts)
 * on real, migrated SQLite with two projects.
 *
 * Older versions picked one plan approval for the whole workflow
 * (`workflows.plan_approval`). Plan approval is per task now, so a value left
 * there is copied onto each of the workflow's tasks that has none of its own,
 * then cleared, the first time anything reads the workflow. A workflow's tasks
 * can sit on other projects' boards, which a per-database migration cannot
 * reach, so this runs in main, across every board.
 *
 * It must never lose the value: a board whose database will not read leaves it
 * set, so the next read retries. And it only writes: what each task gets does
 * not change, so it announces nothing and moves no revision.
 *
 * While a board will not read, the value stays on the workflow and every read
 * puts it between a task's own value and its columns'. A pick made in that
 * window (`setTaskPlanApproval`) must therefore be stored as given, never as
 * the "follow the columns" nothing, or it would read back as the legacy value
 * and the adoption would later overwrite it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  /** Project ids whose database read fails as a locked file does: a SQLite error. */
  throwFor: new Set<string>(),
  /** Project ids whose database file is gone: the lookup finds none. */
  gone: new Set<string>(),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => {
    if (harness.gone.has(projectId)) return null;
    if (harness.throwFor.has(projectId)) {
      const error = new Error('database is locked') as Error & { code: string };
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return harness.dbs.get(projectId) ?? null;
  },
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
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const { adoptLegacyPlanApproval, readTaskPlanApproval } = await import('../../src/main/plan-approval/workflow-plan-approval');

import { openTestDatabase } from './helpers/test-database';
import { planAcrossBoards } from './helpers/workflow-plans';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('adoptLegacyPlanApproval', () => {
  let context: IpcContext;

  beforeEach(() => {
    harness.dbs.clear();
    harness.throwFor.clear();
    harness.gone.clear();
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
      boardConfigManager: { getBoardProfiles: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    for (const projectDatabase of harness.dbs.values()) (projectDatabase as Database.Database).close();
    harness.dbs.clear();
  });

  const dbOf = (projectId: string) => harness.dbs.get(projectId) as Database.Database;
  const workflows = () => new WorkflowRepository(dbOf('home'));
  /** What an older version wrote, straight into the column nothing writes now. */
  const setLegacy = (workflowId: string, value: string) =>
    dbOf('home').prepare('UPDATE workflows SET plan_approval = ? WHERE id = ?').run(value, workflowId);
  const tasksOf = (projectId: string, workflowId: string) => new TaskRepository(dbOf(projectId)).listByWorkflow(workflowId);

  async function startedAcrossBoards() {
    const workflow = planAcrossBoards(service, context);
    await service.startWorkflow(context, 'home', workflow.id);
    return workflow;
  }

  it('copies the value onto every planned task that has none, keeps a task\'s own, and clears it', () => {
    const workflow = planAcrossBoards(service, context);
    dbOf('home').prepare('UPDATE workflows SET draft_json = json_set(draft_json, \'$.tasks[0].plan_approval\', \'automatic\') WHERE id = ?').run(workflow.id);
    setLegacy(workflow.id, 'manual');

    const adopted = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

    expect(adopted.plan_approval).toBeNull();
    expect(adopted.draft!.tasks.map((task) => task.plan_approval)).toEqual(['automatic', 'manual', 'manual']);
  });

  it('copies it onto every unfinished task across boards, leaves a task in Done alone, and clears it', async () => {
    const workflow = await startedAcrossBoards();
    const [first] = tasksOf('home', workflow.id);
    const doneLane = dbOf('home').prepare("SELECT id FROM swimlanes WHERE role = 'done'").get() as { id: string };
    dbOf('home').prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(doneLane.id, first.id);
    setLegacy(workflow.id, 'automatic');

    adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

    expect(new TaskRepository(dbOf('home')).getById(first.id)!.plan_approval).toBeNull();
    const others = [...tasksOf('home', workflow.id).filter((task) => task.id !== first.id), ...tasksOf('mobile', workflow.id)];
    expect(others.map((task) => task.plan_approval)).toEqual(['automatic', 'automatic']);
    expect(workflows().getById(workflow.id)!.plan_approval).toBeNull();
  });

  it('keeps the value when a board will not read, so the next read retries, and then finishes', async () => {
    const workflow = await startedAcrossBoards();
    setLegacy(workflow.id, 'automatic');
    harness.throwFor.add('mobile');

    adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
    expect(workflows().getById(workflow.id)!.plan_approval).toBe('automatic');

    harness.throwFor.clear();
    adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
    expect(workflows().getById(workflow.id)!.plan_approval).toBeNull();
    expect(tasksOf('mobile', workflow.id).map((task) => task.plan_approval)).toEqual(['automatic']);
  });

  it('keeps the value when a board is gone between the read and its write', async () => {
    const workflow = await startedAcrossBoards();
    setLegacy(workflow.id, 'automatic');
    // The read lists home, then mobile; mobile's file is gone the moment it was read.
    const original = TaskRepository.prototype.listByWorkflow;
    let reads = 0;
    const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow').mockImplementation(function (this: InstanceType<typeof TaskRepository>, workflowId: string) {
      const listed = original.call(this, workflowId);
      reads += 1;
      if (reads === 2) harness.gone.add('mobile');
      return listed;
    });
    try {
      adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
    } finally {
      listSpy.mockRestore();
    }

    expect(workflows().getById(workflow.id)!.plan_approval).toBe('automatic');
    harness.gone.clear();
    expect(tasksOf('mobile', workflow.id).map((task) => task.plan_approval)).toEqual([null]);
  });

  it('keeps the value when it was handed a draft that has since started', async () => {
    const workflow = await startedAcrossBoards();
    setLegacy(workflow.id, 'manual');
    // A caller still holding the row as it read it before Start.
    const stale = { ...workflows().getById(workflow.id)!, state: 'draft' as const, draft: { tasks: [], links: [] } };

    adoptLegacyPlanApproval(context, 'home', stale);

    expect(workflows().getById(workflow.id)!.plan_approval).toBe('manual');
  });

  it('announces nothing and moves no revision: what each task gets did not change', async () => {
    const workflow = await startedAcrossBoards();
    setLegacy(workflow.id, 'manual');
    const revisionBefore = workflows().getById(workflow.id)!.revision;
    vi.mocked(notifyWorkflowChanged).mockClear();
    vi.mocked(context.boardEvents.emitBoardChanged).mockClear();

    adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

    expect(workflows().getById(workflow.id)!.revision).toBe(revisionBefore);
    expect(notifyWorkflowChanged).not.toHaveBeenCalled();
    expect(context.boardEvents.emitBoardChanged).not.toHaveBeenCalled();
  });

  it('is a no-op for a workflow with no legacy value', async () => {
    const workflow = await startedAcrossBoards();
    const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow');
    try {
      adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
      expect(listSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  describe('once it has run', () => {
    /** Every task's plan approval across both boards, by task id, for comparing rows. */
    const planApprovalsOf = (workflowId: string) =>
      Object.fromEntries([...tasksOf('home', workflowId), ...tasksOf('mobile', workflowId)].map((task) => [task.id, task.plan_approval]));

    it('a started workflow: the second call, on the workflow as returned or as re-read, writes nothing', async () => {
      const workflow = await startedAcrossBoards();
      setLegacy(workflow.id, 'automatic');
      const adopted = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
      expect(adopted.plan_approval).toBeNull();
      const rowsAfterAdoption = planApprovalsOf(workflow.id);
      expect(Object.values(rowsAfterAdoption)).toEqual(['automatic', 'automatic', 'automatic']);

      const setSpy = vi.spyOn(TaskRepository.prototype, 'setPlanApproval');
      const clearSpy = vi.spyOn(WorkflowRepository.prototype, 'clearLegacyPlanApproval');
      const draftSpy = vi.spyOn(WorkflowRepository.prototype, 'writeAdoptedDraft');
      const listSpy = vi.spyOn(TaskRepository.prototype, 'listByWorkflow');
      try {
        const asReturned = adoptLegacyPlanApproval(context, 'home', adopted);
        const asReRead = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

        expect(setSpy).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
        expect(draftSpy).not.toHaveBeenCalled();
        // It does not even read the boards again.
        expect(listSpy).not.toHaveBeenCalled();
        expect(asReturned).toBe(adopted);
        expect(asReRead.plan_approval).toBeNull();
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        draftSpy.mockRestore();
        listSpy.mockRestore();
      }
      expect(planApprovalsOf(workflow.id)).toEqual(rowsAfterAdoption);
    });

    it('a planned workflow: the second call writes no draft', () => {
      const workflow = planAcrossBoards(service, context);
      setLegacy(workflow.id, 'manual');
      const adopted = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
      expect(adopted.plan_approval).toBeNull();
      expect(adopted.draft!.tasks.map((task) => task.plan_approval)).toEqual(['manual', 'manual', 'manual']);
      const draftBefore = workflows().getById(workflow.id)!.draft;

      const draftSpy = vi.spyOn(WorkflowRepository.prototype, 'writeAdoptedDraft');
      const clearSpy = vi.spyOn(WorkflowRepository.prototype, 'clearLegacyPlanApproval');
      try {
        adoptLegacyPlanApproval(context, 'home', adopted);
        adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

        expect(draftSpy).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
      } finally {
        draftSpy.mockRestore();
        clearSpy.mockRestore();
      }
      expect(workflows().getById(workflow.id)!.draft).toEqual(draftBefore);
    });
  });

  describe('a write that fails', () => {
    /** What a locked file throws: an Error carrying a `SQLITE_*` code, which `isSqliteError` accepts. */
    const sqliteFailure = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('a SQLite failure writing a task keeps the legacy value, warns, and the next read finishes the job', async () => {
      const workflow = await startedAcrossBoards();
      setLegacy(workflow.id, 'automatic');
      const setSpy = vi.spyOn(TaskRepository.prototype, 'setPlanApproval').mockImplementation(() => {
        throw sqliteFailure();
      });
      try {
        let adopted: ReturnType<typeof adoptLegacyPlanApproval> | undefined;
        expect(() => {
          adopted = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
        }).not.toThrow();

        expect(adopted!.plan_approval).toBe('automatic');
        expect(workflows().getById(workflow.id)!.plan_approval).toBe('automatic');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('[plan-approval]');
      } finally {
        setSpy.mockRestore();
      }

      adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
      expect(workflows().getById(workflow.id)!.plan_approval).toBeNull();
      expect([...tasksOf('home', workflow.id), ...tasksOf('mobile', workflow.id)].map((task) => task.plan_approval))
        .toEqual(['automatic', 'automatic', 'automatic']);
    });

    it('a SQLite failure clearing the legacy value keeps it on the workflow, and warns', async () => {
      const workflow = await startedAcrossBoards();
      setLegacy(workflow.id, 'manual');
      const clearSpy = vi.spyOn(WorkflowRepository.prototype, 'clearLegacyPlanApproval').mockImplementation(() => {
        throw sqliteFailure();
      });
      try {
        expect(() => adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!)).not.toThrow();

        expect(workflows().getById(workflow.id)!.plan_approval).toBe('manual');
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        clearSpy.mockRestore();
      }
    });

    it('a SQLite failure writing a planned workflow\'s draft keeps the legacy value, and warns', () => {
      const workflow = planAcrossBoards(service, context);
      setLegacy(workflow.id, 'manual');
      const draftSpy = vi.spyOn(WorkflowRepository.prototype, 'writeAdoptedDraft').mockImplementation(() => {
        throw sqliteFailure();
      });
      try {
        let adopted: ReturnType<typeof adoptLegacyPlanApproval> | undefined;
        expect(() => {
          adopted = adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
        }).not.toThrow();

        expect(adopted!.plan_approval).toBe('manual');
        expect(workflows().getById(workflow.id)!.plan_approval).toBe('manual');
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        draftSpy.mockRestore();
      }
    });

    it('anything but a SQLite failure is a bug: it is rethrown, with the legacy value still in place and no warning', async () => {
      const workflow = await startedAcrossBoards();
      setLegacy(workflow.id, 'automatic');
      const setSpy = vi.spyOn(TaskRepository.prototype, 'setPlanApproval').mockImplementation(() => {
        throw new Error('not a database failure');
      });
      try {
        expect(() => adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!)).toThrow('not a database failure');
      } finally {
        setSpy.mockRestore();
      }

      expect(workflows().getById(workflow.id)!.plan_approval).toBe('automatic');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('a pick made while a board will not read', () => {
    const storedOn = (taskId: string) => new TaskRepository(dbOf('home')).getById(taskId)!.plan_approval;
    /** The task's plan approval as the views and the approver read it, against the workflow as it stands. */
    const readBack = (workflowId: string, taskId: string) =>
      readTaskPlanApproval(context, 'home', new TaskRepository(dbOf('home')).getById(taskId)!, workflows().getById(workflowId)!.plan_approval);

    /**
     * A started workflow whose legacy value is Automatic (the seeded Planning
     * column is Manual, so the two differ) with the phone board unreadable, so
     * the adoption cannot finish. The api task is on the readable home board.
     */
    async function stuckOnLegacy() {
      const workflow = await startedAcrossBoards();
      setLegacy(workflow.id, 'automatic');
      harness.throwFor.add('mobile');
      const [api] = tasksOf('home', workflow.id);
      return { workflow, apiId: api.id, projectId: 'home' };
    }

    it.each([
      ['the columns\' own value', 'manual' as const],
      ['null, to follow the columns', null],
    ])('%s is stored as an explicit Manual, reads back as picked, and survives the adoption once the board reads again', async (_label, request) => {
      const { workflow, apiId, projectId } = await stuckOnLegacy();
      // Control: before the pick, the legacy value is what the task reads.
      expect(readBack(workflow.id, apiId)).toMatchObject({ value: 'automatic', columnValue: 'manual' });

      service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: apiId, projectId }, request);

      // The adoption could not finish, so the legacy value is still in place...
      expect(workflows().getById(workflow.id)!.plan_approval).toBe('automatic');
      // ...which is why the pick is stored as given: stored as nothing, it would read as Automatic.
      expect(storedOn(apiId)).toBe('manual');
      expect(readBack(workflow.id, apiId)).toMatchObject({ value: 'manual', set: 'manual' });

      harness.throwFor.clear();
      adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);

      expect(workflows().getById(workflow.id)!.plan_approval).toBeNull();
      // The adoption ran: every other task took the legacy value. The pick was not overwritten by it.
      const others = [...tasksOf('home', workflow.id).filter((task) => task.id !== apiId), ...tasksOf('mobile', workflow.id)];
      expect(others.map((task) => task.plan_approval)).toEqual(['automatic', 'automatic']);
      expect(storedOn(apiId)).toBe('manual');
      expect(readBack(workflow.id, apiId)).toMatchObject({ value: 'manual', set: 'manual' });
    });

    it('a pick that differs from the columns\' is stored as given, and survives the adoption', async () => {
      const { workflow, apiId, projectId } = await stuckOnLegacy();

      service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: apiId, projectId }, 'automatic');
      expect(storedOn(apiId)).toBe('automatic');

      harness.throwFor.clear();
      adoptLegacyPlanApproval(context, 'home', workflows().getById(workflow.id)!);
      expect(storedOn(apiId)).toBe('automatic');
    });

    it('with no legacy value, the columns\' own value is still stored as nothing', async () => {
      const workflow = await startedAcrossBoards();
      const [api] = tasksOf('home', workflow.id);

      service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: api.id, projectId: 'home' }, 'automatic');
      expect(storedOn(api.id)).toBe('automatic');

      service.setTaskPlanApproval(context, 'home', workflow.id, { taskId: api.id, projectId: 'home' }, 'manual');
      expect(storedOn(api.id)).toBeNull();
    });
  });
});
