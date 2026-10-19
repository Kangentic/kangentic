/**
 * `planApproval` on `kangentic_save_workflow` (handleSaveWorkflow in
 * src/main/agent/commands/workflow-commands.ts) and its read-back in
 * `kangentic_get_workflow`, on real, migrated SQLite.
 *
 * The parameter has three meanings, which is what makes it easy to break:
 *   - "automatic" / "manual": the agent picks who approves the plan dialogs;
 *   - null: forget the pick and follow the plan columns on the tasks' routes;
 *   - omitted: leave whatever is stored alone, so an agent that saves a plan
 *     without mentioning approval does not undo the user's pick.
 * It goes through BOTH writers, a save over an existing workflow (`savePlan`)
 * and a save that creates one (`createWorkflowWithPlan`).
 *
 * A command handler can be reached with no zod schema in front of it (the
 * mobile bridge), so a value that is none of the three is refused by the
 * handler. `handleSaveWorkflow` answers a refusal as `{ success: false, error }`
 * rather than throwing, and a refused save writes nothing: every stored value
 * below is read from the raw column, around the repository's narrowing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>(), runtime: null as unknown }));
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
// kangentic_save_workflow asks for the runtime before it reads its params.
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>()),
  requireWorkflowRuntimeContext: () => harness.runtime,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { handleSaveWorkflow, handleGetWorkflow } = await import('../../src/main/agent/commands/workflow-commands');

import { openTestDatabase } from './helpers/test-database';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { PlanApproval } from '../../src/shared/types';

describe('kangentic_save_workflow planApproval', () => {
  let database: Database.Database;
  let commandContext: CommandContext;

  beforeEach(() => {
    harness.dbs.clear();
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.dbs.set('home', database);
    const projects = [{ id: 'home', name: 'kangentic', path: '/projects/home' }];
    harness.runtime = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    commandContext = { projectId: 'home', getProjectDb: () => database } as unknown as CommandContext;
  });

  afterEach(() => {
    database.close();
    harness.dbs.clear();
    harness.runtime = null;
  });

  const tasks = [{ key: 'api', title: 'Budgets API' }];

  /** The stored value, read around the repository's narrowing. */
  function storedPlanApproval(workflowId: string): string | null {
    const row = database.prepare('SELECT plan_approval FROM workflows WHERE id = ?').get(workflowId) as { plan_approval: string | null };
    return row.plan_approval;
  }

  function workflowCount(): number {
    return new WorkflowRepository(database).listAll().length;
  }

  /** Create a workflow through the handler and return its id. */
  async function createThroughHandler(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await handleSaveWorkflow({ tasks, ...extra }, commandContext);
    expect(response.success, response.error).toBe(true);
    return (response.data as { id: string }).id;
  }

  describe('a save that creates the workflow', () => {
    it('stores "automatic"', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });

      expect(storedPlanApproval(workflowId)).toBe('automatic');
    });

    it('stores "manual"', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'manual' });

      expect(storedPlanApproval(workflowId)).toBe('manual');
    });

    it('stores an explicit null, which follows the plan columns', async () => {
      const workflowId = await createThroughHandler({ planApproval: null });

      expect(storedPlanApproval(workflowId)).toBeNull();
    });

    it('leaves a new workflow following the plan columns when the call does not name it', async () => {
      const workflowId = await createThroughHandler();

      expect(storedPlanApproval(workflowId)).toBeNull();
    });

    it.each([
      ['an unknown word', 'bogus'],
      ['the right word in the wrong case', 'Automatic'],
      ['a number', 7],
      ['a boolean', true],
    ])('refuses %s, and creates no workflow', async (_label, planApproval) => {
      const response = await handleSaveWorkflow({ tasks, planApproval }, commandContext);

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/planApproval must be "automatic", "manual", or null/);
      expect(workflowCount()).toBe(0);
    });
  });

  describe('a save over an existing workflow', () => {
    it('stores "automatic" over a workflow that followed the columns', async () => {
      const workflowId = await createThroughHandler();
      expect(storedPlanApproval(workflowId)).toBeNull();

      const response = await handleSaveWorkflow({ workflow: workflowId, tasks, planApproval: 'automatic' }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedPlanApproval(workflowId)).toBe('automatic');
    });

    it('stores "manual" over an Automatic pick', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });

      await handleSaveWorkflow({ workflow: workflowId, tasks, planApproval: 'manual' }, commandContext);

      expect(storedPlanApproval(workflowId)).toBe('manual');
    });

    it('stores an explicit null over a pick, so the workflow follows the columns again', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });

      const response = await handleSaveWorkflow({ workflow: workflowId, tasks, planApproval: null }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedPlanApproval(workflowId)).toBeNull();
    });

    it('leaves the stored pick alone when the call does not name it', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });

      const response = await handleSaveWorkflow({ workflow: workflowId, tasks, title: 'Renamed plan' }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedPlanApproval(workflowId)).toBe('automatic');
    });

    it.each([
      ['an unknown word', 'bogus'],
      ['a number', 7],
    ])('refuses %s, leaving the pick and the plan exactly as they were', async (_label, planApproval) => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });
      const before = new WorkflowRepository(database).getById(workflowId)!;

      const response = await handleSaveWorkflow(
        { workflow: workflowId, title: 'Should not land', tasks: [{ key: 'ui', title: 'Budgets UI' }], planApproval },
        commandContext,
      );

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/planApproval must be "automatic", "manual", or null/);
      const after = new WorkflowRepository(database).getById(workflowId)!;
      expect(storedPlanApproval(workflowId)).toBe('automatic');
      expect(after.revision).toBe(before.revision);
      expect(after.title).toBe(before.title);
      expect(after.draft?.tasks.map((task) => task.key)).toEqual(['api']);
    });

    // A valid pick on a save that is refused for its revision must not land.
    // `savePlan` refuses a stale revision up front, before it writes anything, and
    // again inside the transaction through `saveDraft`'s expectedRevision. The first
    // test below pins the contract the agent sees (the pre-check). The second gets
    // past the pre-check so it pins the transaction itself: the pick is written
    // BEFORE the draft, so only the rollback keeps it from outliving the refusal.
    it.each([
      ['manual', 'automatic'],
      ['automatic', 'manual'],
    ])('a stale revision refuses a valid "%s" pick over a stored "%s" one and writes nothing', async (newPick, storedPick) => {
      const workflowId = await createThroughHandler({ planApproval: storedPick });
      const readRevision = new WorkflowRepository(database).getById(workflowId)!.revision;
      // The user edits the plan after the agent read it, so what the agent holds is stale.
      await handleSaveWorkflow({ workflow: workflowId, tasks, title: 'User edit' }, commandContext);
      const before = new WorkflowRepository(database).getById(workflowId)!;
      expect(before.revision).toBeGreaterThan(readRevision);

      const response = await handleSaveWorkflow(
        { workflow: workflowId, tasks: [{ key: 'ui', title: 'Budgets UI' }], title: 'Agent edit', revision: readRevision, planApproval: newPick },
        commandContext,
      );

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/changed since you read it/);
      const after = new WorkflowRepository(database).getById(workflowId)!;
      expect(storedPlanApproval(workflowId)).toBe(storedPick);
      expect(after.revision).toBe(before.revision);
      expect(after.title).toBe('User edit');
      expect(after.draft?.tasks.map((task) => task.key)).toEqual(['api']);
    });

    it.each([
      ['manual', 'automatic'],
      ['automatic', 'manual'],
    ])('rolls a "%s" pick back over a stored "%s" one when the draft write finds the revision stale', async (newPick, storedPick) => {
      const workflowId = await createThroughHandler({ planApproval: storedPick });
      const before = new WorkflowRepository(database).getById(workflowId)!;
      // The pre-check reads the CURRENT revision, so it passes. A real edit can land
      // just after that check and before the transaction opens (another process, as
      // transaction.ts describes), so saveDraft finds the revision moved. Once the
      // transaction is open no other writer gets in; the spy bumps the revision
      // after the pick is stored only because that is the point the rollback has to
      // cover, and the outcome is the same as an edit that landed just before BEGIN.
      const originalSetPlanApproval = WorkflowRepository.prototype.setPlanApproval;
      const setPlanApprovalSpy = vi.spyOn(WorkflowRepository.prototype, 'setPlanApproval').mockImplementation(
        function (this: InstanceType<typeof WorkflowRepository>, id: string, planApproval: PlanApproval | null) {
          originalSetPlanApproval.call(this, id, planApproval);
          database.prepare('UPDATE workflows SET revision = revision + 1 WHERE id = ?').run(id);
        },
      );
      let response: Awaited<ReturnType<typeof handleSaveWorkflow>>;
      let setPlanApprovalCalls: number;
      try {
        response = await handleSaveWorkflow(
          { workflow: workflowId, tasks: [{ key: 'ui', title: 'Budgets UI' }], revision: before.revision, planApproval: newPick },
          commandContext,
        );
        setPlanApprovalCalls = setPlanApprovalSpy.mock.calls.length;
      } finally {
        // The spy sits on the shared prototype, so it never outlives this test.
        setPlanApprovalSpy.mockRestore();
      }

      // The pick really was written inside the save before the draft refused it.
      expect(setPlanApprovalCalls).toBe(1);
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/changed since it was read/);
      const after = new WorkflowRepository(database).getById(workflowId)!;
      expect(storedPlanApproval(workflowId)).toBe(storedPick);
      // The simulated edit rolled back with the rest, so nothing of the save is left.
      expect(after.revision).toBe(before.revision);
      expect(after.draft?.tasks.map((task) => task.key)).toEqual(['api']);
    });
  });

  describe('what an agent reads back', () => {
    async function readText(workflowId: string): Promise<string> {
      const response = await handleGetWorkflow({ workflow: workflowId }, commandContext);
      expect(response.success, response.error).toBe(true);
      return response.message ?? '';
    }

    it('names the pick in the form save_workflow takes it, so a plan read and sent back keeps it', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'automatic' });

      const text = await readText(workflowId);

      expect(text).toContain('Plan approval: planApproval "automatic".');
      expect(text).not.toContain('follows the plan columns');
    });

    it('says the workflow follows the plan columns when nothing is picked', async () => {
      const workflowId = await createThroughHandler();

      const text = await readText(workflowId);

      expect(text).toContain('Plan approval: follows the plan columns on the tasks\' routes (planApproval null).');
      expect(text).not.toContain('planApproval "');
    });

    it('moves from one form to the other as the pick is set and cleared', async () => {
      const workflowId = await createThroughHandler({ planApproval: 'manual' });
      expect(await readText(workflowId)).toContain('Plan approval: planApproval "manual".');

      await handleSaveWorkflow({ workflow: workflowId, tasks, planApproval: null }, commandContext);

      expect(await readText(workflowId)).toContain('planApproval null');
    });
  });
});
