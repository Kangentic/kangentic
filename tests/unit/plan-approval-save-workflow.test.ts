/**
 * `planApproval` on `kangentic_save_workflow` (handleSaveWorkflow in
 * src/main/agent/commands/workflow-commands.ts) and its read-back in
 * `kangentic_get_workflow`, on real, migrated SQLite.
 *
 * Plan approval is set per task. On a task entry:
 *   - "automatic" / "manual" sets who approves that task's plan, overriding its
 *     plan column, and the column's own value is stored as nothing so the task
 *     keeps following its column;
 *   - null or omitted follows the column.
 * The workflow-level parameter is gone. A non-null value there is refused with
 * a sentence that says what to do instead; a null is accepted and ignored,
 * since older kangentic_get_workflow output told agents to send it back.
 *
 * A command handler can be reached with no zod schema in front of it (the
 * mobile bridge), so a task value that is none of the three is refused by the
 * handler. `handleSaveWorkflow` answers a refusal as `{ success: false, error }`
 * rather than throwing, and a refused save writes nothing: every stored value
 * below is read from the raw draft, around the repository's narrowing.
 *
 * The seeded board's Planning column runs in plan mode and is Manual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
  runtime: null as unknown,
  /** Makes the Save and Start reply clause throw, as a failed read after the write would. */
  failClause: false,
  /** Makes the Add reply's plan approval sentence throw. */
  failSentence: false,
  report: vi.fn(),
}));
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

// The reply clause is read after the write it describes has landed. A throw
// there must not fail the reply, and is reported with a fixed stage tag.
vi.mock('../../src/main/agent/mcp-http/tool-reporting', () => ({ mcpCommandReporter: { report: harness.report } }));
vi.mock('../../src/main/workflows/workflow-format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-format')>();
  return {
    ...actual,
    describePlanApprovalForReply: (view: Parameters<typeof actual.describePlanApprovalForReply>[0]) => {
      if (harness.failClause) throw new Error('the clause could not be read');
      return actual.describePlanApprovalForReply(view);
    },
  };
});
vi.mock('../../src/shared/plan-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/plan-approval')>();
  return {
    ...actual,
    taskPlanApprovalSentence: (view: Parameters<typeof actual.taskPlanApprovalSentence>[0]) => {
      if (harness.failSentence) throw new Error('the sentence could not be read');
      return actual.taskPlanApprovalSentence(view);
    },
  };
});

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { TaskRepository } = await import('../../src/main/db/repositories/task-repository');
const { handleSaveWorkflow, handleGetWorkflow, handleAddWorkflowTask, handleStartWorkflow } = await import('../../src/main/agent/commands/workflow-commands');
const { startWorkflow } = await import('../../src/main/workflows/workflow-service');

import { openTestDatabase } from './helpers/test-database';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('kangentic_save_workflow planApproval', () => {
  let database: Database.Database;
  let commandContext: CommandContext;

  beforeEach(() => {
    harness.dbs.clear();
    harness.failClause = false;
    harness.failSentence = false;
    harness.report.mockClear();
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.dbs.set('home', database);
    const projects = [{ id: 'home', name: 'kangentic', path: '/projects/home' }];
    harness.runtime = {
      projectRepo: {
        listHidden: () => [],
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      boardConfigManager: { getBoardProfiles: () => [] },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    } as unknown as IpcContext;
    commandContext = { projectId: 'home', getProjectDb: () => database } as unknown as CommandContext;
  });

  afterEach(() => {
    database.close();
    harness.dbs.clear();
    harness.runtime = null;
  });

  /** A planned task's stored value, read from the raw draft. */
  function storedOnTask(workflowId: string, key: string): unknown {
    const row = database.prepare('SELECT draft_json FROM workflows WHERE id = ?').get(workflowId) as { draft_json: string };
    const draft = JSON.parse(row.draft_json) as { tasks: Array<{ key: string; plan_approval?: unknown }> };
    return draft.tasks.find((task) => task.key === key)?.plan_approval;
  }

  function workflowCount(): number {
    return new WorkflowRepository(database).listAll().length;
  }

  /** Create a workflow through the handler and return its id. */
  async function createThroughHandler(params: Record<string, unknown>): Promise<string> {
    const response = await handleSaveWorkflow(params, commandContext);
    expect(response.success, response.error).toBe(true);
    return (response.data as { id: string }).id;
  }

  describe('on a task entry', () => {
    it('stores a value that overrides the task\'s plan column', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API', planApproval: 'automatic' }] });

      expect(storedOnTask(workflowId, 'api')).toBe('automatic');
    });

    it('stores the plan column\'s own value as nothing, so the task keeps following its column', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API', planApproval: 'manual' }] });

      expect(storedOnTask(workflowId, 'api')).toBeNull();
    });

    it.each([
      ['null', null],
      ['omitted', undefined],
    ])('%s follows the plan column', async (_label, planApproval) => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API', planApproval }] });

      expect(storedOnTask(workflowId, 'api')).toBeNull();
    });

    it('sets each task on its own: one waits for the user while another is approved', async () => {
      const workflowId = await createThroughHandler({
        tasks: [
          { key: 'desktop', title: 'Desktop', planApproval: 'manual' },
          { key: 'bridge', title: 'Bridge', planApproval: 'automatic' },
        ],
      });

      expect(storedOnTask(workflowId, 'desktop')).toBeNull();
      expect(storedOnTask(workflowId, 'bridge')).toBe('automatic');
    });

    it('lets a task taken in with existingTask carry one: it is not a run setting the board task keeps', async () => {
      const todo = database.prepare("SELECT id FROM swimlanes WHERE role = 'todo'").get() as { id: string };
      const existing = new TaskRepository(database).create({ title: 'Already on the board', description: '', swimlane_id: todo.id });

      const workflowId = await createThroughHandler({
        tasks: [{ key: 'taken', title: 'Already on the board', existingTask: existing.id, planApproval: 'automatic' }],
      });

      expect(storedOnTask(workflowId, 'taken')).toBe('automatic');
    });

    it('keeps the value as given on a route with no plan column, where it decides nothing until the route gains one', async () => {
      const workflowId = await createThroughHandler({
        tasks: [{ key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing', planApproval: 'manual' }],
      });

      expect(storedOnTask(workflowId, 'release')).toBe('manual');
    });

    it.each([
      ['an unknown word', 'bogus'],
      ['the right word in the wrong case', 'Automatic'],
      ['a number', 7],
      ['a boolean', true],
    ])('refuses %s, naming the task, and creates no workflow', async (_label, planApproval) => {
      const response = await handleSaveWorkflow({ tasks: [{ key: 'api', title: 'Budgets API', planApproval }] }, commandContext);

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/Task 1 \("api"\): planApproval must be "automatic", "manual", or null/);
      expect(workflowCount()).toBe(0);
    });

    it('a save over an existing workflow replaces each task\'s value with what it sends', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API', planApproval: 'automatic' }] });

      const response = await handleSaveWorkflow({ workflow: workflowId, tasks: [{ key: 'api', title: 'Budgets API' }] }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedOnTask(workflowId, 'api')).toBeNull();
    });
  });

  describe('the removed workflow-level parameter', () => {
    it.each([
      ['"automatic"', 'automatic'],
      ['"manual"', 'manual'],
      ['an unknown word', 'bogus'],
    ])('refuses %s with what to do instead, and creates no workflow', async (_label, planApproval) => {
      const response = await handleSaveWorkflow({ tasks: [{ key: 'api', title: 'Budgets API' }], planApproval }, commandContext);

      expect(response.success).toBe(false);
      expect(response.error).toBe('planApproval is set per task now. Put planApproval on each task entry.');
      expect(workflowCount()).toBe(0);
    });

    it('refuses it over an existing workflow too, leaving the plan exactly as it was', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API' }] });
      const before = new WorkflowRepository(database).getById(workflowId)!;

      const response = await handleSaveWorkflow(
        { workflow: workflowId, title: 'Should not land', tasks: [{ key: 'ui', title: 'Budgets UI' }], planApproval: 'automatic' },
        commandContext,
      );

      expect(response.success).toBe(false);
      const after = new WorkflowRepository(database).getById(workflowId)!;
      expect(after.revision).toBe(before.revision);
      expect(after.title).toBe(before.title);
      expect(after.draft?.tasks.map((task) => task.key)).toEqual(['api']);
    });

    it('accepts a null and ignores it, since an older read told agents to send it back', async () => {
      const response = await handleSaveWorkflow({ tasks: [{ key: 'api', title: 'Budgets API' }], planApproval: null }, commandContext);

      expect(response.success, response.error).toBe(true);
    });
  });

  describe('kangentic_add_workflow_task', () => {
    /** A started workflow homed on this board, by id. */
    async function startedWorkflow(): Promise<string> {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API' }] });
      await startWorkflow(harness.runtime as IpcContext, 'home', workflowId);
      return workflowId;
    }

    /** The task row the handler created, read without the repository's narrowing. */
    function storedOnRow(taskId: string): unknown {
      return (database.prepare('SELECT plan_approval FROM tasks WHERE id = ?').get(taskId) as { plan_approval: unknown }).plan_approval;
    }

    it('creates the task with its own value, and stores the plan column\'s own value as nothing', async () => {
      const workflowId = await startedWorkflow();

      const automatic = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets UI', planApproval: 'automatic' }, commandContext);
      const manual = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets docs', planApproval: 'manual' }, commandContext);

      expect(automatic.success, automatic.error).toBe(true);
      expect(manual.success, manual.error).toBe(true);
      expect(storedOnRow((automatic.data as { id: string }).id)).toBe('automatic');
      expect(storedOnRow((manual.data as { id: string }).id)).toBeNull();
    });

    it('refuses a value that is none of the three, naming the task, and creates nothing', async () => {
      const workflowId = await startedWorkflow();
      const before = new TaskRepository(database).listByWorkflow(workflowId).length;

      const response = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets UI', planApproval: 'Automatic' }, commandContext);

      expect(response.success).toBe(false);
      expect(response.error).toBe('"Budgets UI": planApproval must be "automatic", "manual", or null.');
      expect(new TaskRepository(database).listByWorkflow(workflowId)).toHaveLength(before);
    });

    it('says in its reply whether the added task\'s plan will wait for a person, and nothing when its route has no plan column', async () => {
      // An added task starts on its own, so a Manual plan column stops it like any other.
      const workflowId = await startedWorkflow();

      const manual = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets docs' }, commandContext);
      const automatic = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets UI', planApproval: 'automatic' }, commandContext);
      const noPlan = await handleAddWorkflowTask({ workflow: workflowId, title: 'Release', routeStart: 'Executing', routeLast: 'Executing' }, commandContext);

      expect(manual.message).toMatch(/an agent slot is free\. Plan approval: Manual, from kangentic's Planning column\.$/);
      expect(automatic.message).toMatch(/an agent slot is free\. Plan approval: Automatic, set for this task \(its Planning column is Manual\)\.$/);
      expect(noPlan.message).toMatch(/an agent slot is free\.$/);
    });
  });

  describe('what an agent reads back', () => {
    async function readText(workflowId: string): Promise<string> {
      const response = await handleGetWorkflow({ workflow: workflowId }, commandContext);
      expect(response.success, response.error).toBe(true);
      return response.message ?? '';
    }

    it('names each task\'s value and where it comes from, and a set value in save_workflow\'s own terms', async () => {
      const workflowId = await createThroughHandler({
        tasks: [
          { key: 'desktop', title: 'Desktop' },
          { key: 'bridge', title: 'Bridge', planApproval: 'automatic' },
          { key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing' },
        ],
      });

      const text = await readText(workflowId);

      expect(text).toContain('Plan approval: set per task. 1 task Manual, 1 Automatic; each task\'s line says why.');
      expect(text).toMatch(/- \[desktop\] Desktop\..* Plan approval: Manual, from kangentic's Planning column\./);
      expect(text).toMatch(/- \[bridge\] Bridge\..* Settings: planApproval "automatic"\. Plan approval: Automatic, set for this task \(its Planning column is Manual\)\./);
      expect(text).toMatch(/- \[release\] Release\..* Plan approval: none, no plan column on its route\./);
    });

    it('a plan read and sent back keeps each task\'s value', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'bridge', title: 'Bridge', planApproval: 'automatic' }] });
      const revision = new WorkflowRepository(database).getById(workflowId)!.revision;
      const read = await handleGetWorkflow({ workflow: workflowId }, commandContext);
      const view = read.data as { tasks: Array<{ key: string; title: string; planApproval: { set: string | null } | null }> };

      // An agent resends what it read, in save_workflow's terms.
      const response = await handleSaveWorkflow({
        workflow: workflowId,
        revision,
        tasks: view.tasks.map((task) => ({ key: task.key, title: task.title, planApproval: task.planApproval?.set ?? null })),
      }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedOnTask(workflowId, 'bridge')).toBe('automatic');
    });

    it('a plan read and sent back keeps a value on a task whose route has no plan column', async () => {
      const workflowId = await createThroughHandler({
        tasks: [{ key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing', planApproval: 'automatic' }],
      });
      // The control: the value was stored as given, though nothing on the route reads it yet.
      expect(storedOnTask(workflowId, 'release')).toBe('automatic');
      const revision = new WorkflowRepository(database).getById(workflowId)!.revision;

      const read = await handleGetWorkflow({ workflow: workflowId }, commandContext);
      expect(read.success, read.error).toBe(true);
      const text = read.message ?? '';

      // The Settings carry it in save_workflow's own terms, while the sentence says nothing resolves it.
      expect(text).toMatch(/- \[release\] Release\..* Settings: planApproval "automatic"\. Plan approval: none, no plan column on its route\./);
      // The view has no resolved value for this task, so its own value is the only place an agent can read it from.
      const readTask = (read.data as { tasks: Array<{ planApproval: unknown; ownPlanApproval: unknown }> }).tasks[0];
      expect(readTask.planApproval).toBeNull();
      expect(readTask.ownPlanApproval).toBe('automatic');

      // An agent sends back what it read: the value from the Settings text, and the route it already had.
      const sentBack = /planApproval "(\w+)"/.exec(text)?.[1];
      expect(sentBack).toBe('automatic');
      const response = await handleSaveWorkflow({
        workflow: workflowId,
        revision,
        tasks: [{ key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing', planApproval: sentBack }],
      }, commandContext);

      expect(response.success, response.error).toBe(true);
      expect(storedOnTask(workflowId, 'release')).toBe('automatic');
    });

    it('prints no planApproval setting for a task that carries none, so a read does not invent one', async () => {
      const workflowId = await createThroughHandler({
        tasks: [{ key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing' }],
      });

      const text = await readText(workflowId);

      expect(text).toMatch(/- \[release\] Release\..* Plan approval: none, no plan column on its route\./);
      expect(text).not.toContain('planApproval "');
    });

    it('says plan approval is set per task and that no task has a plan column, when no route has one', async () => {
      const workflowId = await createThroughHandler({
        tasks: [
          { key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing' },
          { key: 'docs', title: 'Docs', routeStart: 'Executing', routeLast: 'Executing', planApproval: 'automatic' },
        ],
      });

      const text = await readText(workflowId);

      expect(text).toContain('Plan approval: set per task (planApproval on each task). No task\'s route has a plan column.');
      // Not the counted line a workflow with a plan column prints.
      expect(text).not.toMatch(/tasks? Manual, \d+ Automatic/);
    });

    it('moves a legacy whole-workflow value onto each planned task, then forgets it', async () => {
      const workflowId = await createThroughHandler({ tasks: [{ key: 'api', title: 'Budgets API' }] });
      database.prepare("UPDATE workflows SET plan_approval = 'automatic' WHERE id = ?").run(workflowId);
      const revisionBefore = new WorkflowRepository(database).getById(workflowId)!.revision;

      const text = await readText(workflowId);

      expect(text).toContain('Settings: planApproval "automatic". Plan approval: Automatic, set for this task (its Planning column is Manual).');
      expect(storedOnTask(workflowId, 'api')).toBe('automatic');
      const after = new WorkflowRepository(database).getById(workflowId)!;
      expect(after.plan_approval).toBeNull();
      // What each task gets did not change, so neither does the plan's revision.
      expect(after.revision).toBe(revisionBefore);
    });
  });

  /**
   * A ported board's Manual Planning column stopped a workflow's first card,
   * and neither reply had said it would. Start is where the setting becomes a
   * stopped card, and Save is where an agent reports to the user who starts.
   */
  describe('the Save and Start replies', () => {
    it('name the task whose plan waits for a person: by key on Save, by number on Start', async () => {
      const save = await handleSaveWorkflow({
        tasks: [
          { key: 'desktop', title: 'Desktop' },
          { key: 'bridge', title: 'Bridge', planApproval: 'automatic' },
        ],
      }, commandContext);
      expect(save.success, save.error).toBe(true);
      expect(save.message).toContain(
        'Plan approval: set per task. 1 task Manual, 1 Automatic. '
        + 'Waits for you after its plan: [desktop] (Planning). kangentic_get_workflow says why. '
        + 'The user starts the workflow when they are ready.',
      );

      const workflowId = (save.data as { id: string }).id;
      const start = await handleStartWorkflow({ workflow: workflowId }, commandContext);
      expect(start.success, start.error).toBe(true);
      const desktop = new TaskRepository(database).listByWorkflow(workflowId).find((task) => task.title === 'Desktop')!;
      expect(start.message).toContain(
        'Tasks with nothing to wait for start as agent slots allow. '
        + 'Plan approval: set per task. 1 task Manual, 1 Automatic. '
        + `Waits for you after its plan: #${desktop.display_id} (Planning). kangentic_get_workflow says why.`,
      );
    });

    it('give the count and name no task when every plan is approved automatically', async () => {
      const save = await handleSaveWorkflow({ tasks: [{ key: 'bridge', title: 'Bridge', planApproval: 'automatic' }] }, commandContext);
      const start = await handleStartWorkflow({ workflow: (save.data as { id: string }).id }, commandContext);

      for (const reply of [save, start]) {
        expect(reply.message).toContain('Plan approval: set per task. 0 tasks Manual, 1 Automatic.');
        expect(reply.message).not.toContain('after its plan');
        // The reply prints no task lines, so it must not point at them.
        expect(reply.message).not.toContain('each task\'s line');
      }
    });

    it('add nothing when no task\'s route has a plan column', async () => {
      const save = await handleSaveWorkflow({
        tasks: [{ key: 'release', title: 'Release', routeStart: 'Executing', routeLast: 'Executing' }],
      }, commandContext);
      const start = await handleStartWorkflow({ workflow: (save.data as { id: string }).id }, commandContext);

      expect(save.message).toMatch(/is at revision \d+\. The user starts the workflow when they are ready\.$/);
      expect(start.message).toMatch(/Tasks with nothing to wait for start as agent slots allow\.$/);
    });

    /**
     * The clause is read after the write has landed, so a failed read must not
     * turn a committed write into a failed reply: an agent told "failed" retries
     * into a second workflow or task.
     */
    describe('when the clause cannot be read after the write', () => {
      const tasks = [{ key: 'desktop', title: 'Desktop' }];

      it('keeps the Save reply and the saved plan, and reports the stage', async () => {
        harness.failClause = true;

        const save = await handleSaveWorkflow({ tasks }, commandContext);

        expect(save.success, save.error).toBe(true);
        expect(save.message).toMatch(/is at revision \d+\. The user starts the workflow when they are ready\.$/);
        expect(workflowCount()).toBe(1);
        expect(harness.report).toHaveBeenCalledTimes(1);
        expect(harness.report).toHaveBeenCalledWith(expect.any(Error), { tags: { command: 'save_workflow', stage: 'reply_clause' } });
      });

      it('keeps the Start reply and the started workflow, and reports the stage', async () => {
        const workflowId = await createThroughHandler({ tasks });
        harness.failClause = true;

        const start = await handleStartWorkflow({ workflow: workflowId }, commandContext);

        expect(start.success, start.error).toBe(true);
        expect(start.message).toMatch(/Tasks with nothing to wait for start as agent slots allow\.$/);
        expect(new WorkflowRepository(database).getById(workflowId)!.state).not.toBe('draft');
        expect(harness.report).toHaveBeenCalledWith(expect.any(Error), { tags: { command: 'start_workflow', stage: 'reply_clause' } });
      });

      it('keeps the Add reply and the added task, and reports the stage', async () => {
        const workflowId = await createThroughHandler({ tasks });
        await startWorkflow(harness.runtime as IpcContext, 'home', workflowId);
        const before = new TaskRepository(database).listByWorkflow(workflowId).length;
        harness.failSentence = true;

        const added = await handleAddWorkflowTask({ workflow: workflowId, title: 'Budgets docs' }, commandContext);

        expect(added.success, added.error).toBe(true);
        expect(added.message).toMatch(/an agent slot is free\.$/);
        expect(new TaskRepository(database).listByWorkflow(workflowId)).toHaveLength(before + 1);
        expect(harness.report).toHaveBeenCalledWith(expect.any(Error), { tags: { command: 'add_workflow_task', stage: 'reply_clause' } });
      });
    });
  });
});
