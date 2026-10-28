/**
 * The phone reaches four workflow commands (list, get, pause, resume) through
 * board-tool-read/board-tool-write, which skips the MCP tools' zod schemas and
 * hands `params` straight from the wire. So each must check its own params'
 * types and answer a bad one with a refusal, never throw or reach a lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const resolveWorkflow = vi.fn();
const savePlan = vi.fn();
const createWorkflowWithPlan = vi.fn();
const pauseWorkflow = vi.fn();
const resumeWorkflow = vi.fn();
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-service')>();
  return {
    ...actual,
    resolveWorkflow: (...args: unknown[]) => resolveWorkflow(...args),
    savePlan: (...args: unknown[]) => savePlan(...args),
    createWorkflowWithPlan: (...args: unknown[]) => createWorkflowWithPlan(...args),
    pauseWorkflow: (...args: unknown[]) => pauseWorkflow(...args),
    resumeWorkflow: (...args: unknown[]) => resumeWorkflow(...args),
  };
});
// kangentic_save_workflow asks for the runtime before it reads its params.
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>();
  return { ...actual, requireWorkflowRuntimeContext: () => ({}) };
});

import { commandHandlers } from '../../src/main/agent/commands';
import { isBoardToolAllowedForVerb } from '../../src/main/mobile-bridge/handlers/board-tool-allowlist';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { openTestDatabase } from './helpers/test-database';
import type { CommandContext } from '../../src/main/agent/commands/types';

const context = { projectId: 'proj-1' } as unknown as CommandContext;

describe('workflow commands on the phone path', () => {
  it('opens exactly list and get to reads, and pause and resume to writes', () => {
    expect(isBoardToolAllowedForVerb('list_workflows', 'board-tool-read')).toBe(true);
    expect(isBoardToolAllowedForVerb('get_workflow', 'board-tool-read')).toBe(true);
    expect(isBoardToolAllowedForVerb('pause_workflow', 'board-tool-write')).toBe(true);
    expect(isBoardToolAllowedForVerb('resume_workflow', 'board-tool-write')).toBe(true);
    for (const tool of ['save_workflow', 'start_workflow', 'delete_workflow', 'link_workflow_tasks', 'request_project_access']) {
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-read')).toBe(false);
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-write')).toBe(false);
    }
  });

  for (const tool of ['get_workflow', 'pause_workflow', 'resume_workflow'] as const) {
    it(`${tool} refuses a workflow that is not text, before looking anything up`, async () => {
      const response = await commandHandlers[tool]({ workflow: 42 }, context);
      expect(response).toEqual({ success: false, error: 'workflow must be text.' });
      expect(resolveWorkflow).not.toHaveBeenCalled();
    });

    it(`${tool} refuses a missing workflow`, async () => {
      const response = await commandHandlers[tool]({}, context);
      expect(response).toEqual({ success: false, error: 'workflow is required.' });
    });
  }
});

/**
 * Pause and Resume report what they did to each agent. The phone's board-tool
 * path answers with the handler's `data` alone, so the report rides there, and
 * the log line names who asked, which the record of a pause used to lack.
 */
describe('pause and resume report their agents', () => {
  const workflow = { id: 'wf-1', title: 'Usage budgets' };
  const failed = [{ projectId: 'proj-1', taskId: 't-917', displayId: 917 }, { projectId: 'proj-1', taskId: 't-918', displayId: 918 }];

  it('pause answers with its report as data, names the failed tasks, and tells the service it was the phone', async () => {
    resolveWorkflow.mockReturnValue(workflow);
    pauseWorkflow.mockResolvedValue({ workflow, paused: 2, notLive: 1, failed });

    const response = await commandHandlers.pause_workflow({ workflow: 'Usage budgets' }, { ...context, via: 'phone' });

    expect(pauseWorkflow).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'the phone');
    expect(response).toEqual({
      success: true,
      message: 'Paused "Usage budgets" (2 agents paused). #917 and #918 could not be paused. The workflow starts and moves nothing until it is resumed.',
      data: { paused: 2, notLive: 1, failed },
    });
  });

  it('resume answers with its report as data, and names an MCP client with no task as the caller', async () => {
    resolveWorkflow.mockReturnValue(workflow);
    resumeWorkflow.mockResolvedValue({ workflow, resumed: 1, started: 2, alreadyRunning: 1, failed: [] });

    const response = await commandHandlers.resume_workflow({ workflow: 'Usage budgets' }, context);

    expect(resumeWorkflow).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'an MCP client');
    expect(response).toEqual({
      success: true,
      message: 'Resumed "Usage budgets" (1 agent resumed, 2 started, 1 already running).',
      data: { resumed: 1, started: 2, alreadyRunning: 1, failed: [] },
    });
  });
});

/**
 * The log line of a pause or resume names who asked. An agent that calls the MCP
 * tool is named by its task: `#<display id>` when the task is on the board the
 * call reads, and a short form of its id when that board cannot say (the
 * caller's task may live on another project's board, or the board may be
 * unreadable), so the line still points at it.
 */
describe('pause and resume name the agent that asked', () => {
  const workflow = { id: 'wf-1', title: 'Usage budgets' };
  const pauseReport = { workflow, paused: 0, notLive: 0, failed: [] };
  const resumeReport = { workflow, resumed: 0, started: 0, alreadyRunning: 0, failed: [] };
  // Not a task on any board here: only its first eight characters may be named.
  const unknownCallerTaskId = 'abcdef12-3456-4789-8abc-def012345678';
  const controls = [
    { tool: 'pause_workflow', service: pauseWorkflow, report: pauseReport },
    { tool: 'resume_workflow', service: resumeWorkflow, report: resumeReport },
  ] as const;

  let database: Database.Database;
  let callerTask: { id: string; display_id: number };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkflow.mockReturnValue(workflow);
    database = openTestDatabase();
    runProjectMigrations(database);
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.role === 'todo');
    if (!lane) throw new Error('Seeded To Do swimlane not found');
    const tasks = new TaskRepository(database);
    // A second task, so the caller's display id is not the first one a board hands out.
    tasks.create({ title: 'Another task', description: '', swimlane_id: lane.id });
    callerTask = tasks.create({ title: 'Caller task', description: '', swimlane_id: lane.id });
  });

  afterEach(() => {
    database.close();
  });

  for (const { tool, service, report } of controls) {
    it(`${tool} names the agent of its task by display id when the board holds the task`, async () => {
      service.mockResolvedValue(report);
      const asked = { ...context, callerTaskId: callerTask.id, getProjectDb: () => database } as unknown as CommandContext;

      const response = await commandHandlers[tool]({ workflow: 'Usage budgets' }, asked);

      expect(response.success).toBe(true);
      expect(service).toHaveBeenCalledTimes(1);
      expect(service).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', `the agent of #${callerTask.display_id}`);
    });

    it(`${tool} names the agent by the start of its task id when the board does not hold the task`, async () => {
      service.mockResolvedValue(report);
      const asked = { ...context, callerTaskId: unknownCallerTaskId, getProjectDb: () => database } as unknown as CommandContext;

      const response = await commandHandlers[tool]({ workflow: 'Usage budgets' }, asked);

      expect(response.success).toBe(true);
      expect(service).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'the agent of task abcdef12');
    });

    it(`${tool} names the agent by the start of its task id when the board cannot be read, and still pauses or resumes`, async () => {
      service.mockResolvedValue(report);
      const asked = {
        ...context,
        callerTaskId: unknownCallerTaskId,
        getProjectDb: () => { throw new Error('No database for proj-1'); },
      } as unknown as CommandContext;

      const response = await commandHandlers[tool]({ workflow: 'Usage budgets' }, asked);

      expect(response.success).toBe(true);
      expect(service).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'the agent of task abcdef12');
    });
  }

  it('an MCP client with no task is named as such, and the phone outranks a task id', async () => {
    pauseWorkflow.mockResolvedValue(pauseReport);

    await commandHandlers.pause_workflow({ workflow: 'Usage budgets' }, context);
    expect(pauseWorkflow).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'an MCP client');

    const fromPhone = { ...context, via: 'phone', callerTaskId: callerTask.id, getProjectDb: () => database } as unknown as CommandContext;
    await commandHandlers.pause_workflow({ workflow: 'Usage budgets' }, fromPhone);
    expect(pauseWorkflow).toHaveBeenLastCalledWith(expect.anything(), 'proj-1', 'wf-1', 'the phone');
  });
});

/**
 * kangentic_save_workflow is agent-only, but a command handler can be reached
 * with no zod schema in front of it, so a planned task's fields are refused on
 * a wrong type rather than dropped: a dropped `project` would put the task on
 * the home board, a dropped `skip` would route it through every column.
 */
describe('kangentic_save_workflow refuses a wrong-typed planned task field', () => {
  const cases: Array<{ field: string; value: unknown; error: string }> = [
    { field: 'project', value: 5, error: 'Task 1 ("api"): project must be text.' },
    { field: 'description', value: { text: 'x' }, error: 'Task 1 ("api"): description must be text.' },
    { field: 'routeStart', value: 3, error: 'Task 1 ("api"): routeStart must be text.' },
    { field: 'skip', value: 'Planning', error: 'Task 1 ("api"): skip must be a list of names.' },
    { field: 'labels', value: ['ui', 7], error: 'Task 1 ("api"): labels must be a list of names.' },
    { field: 'priority', value: 'high', error: 'Task 1 ("api"): priority must be a number.' },
  ];
  for (const testCase of cases) {
    it(`${testCase.field}: ${JSON.stringify(testCase.value)}`, async () => {
      const response = await commandHandlers.save_workflow(
        { tasks: [{ key: 'api', title: 'Budgets API', [testCase.field]: testCase.value }] },
        context,
      );
      expect(response).toEqual({ success: false, error: testCase.error });
      expect(savePlan).not.toHaveBeenCalled();
      expect(createWorkflowWithPlan).not.toHaveBeenCalled();
    });
  }

  it('refuses a link that is not an object', async () => {
    const response = await commandHandlers.save_workflow(
      { tasks: [{ key: 'api', title: 'Budgets API' }], links: ['api->ui'] },
      context,
    );
    expect(response).toEqual({ success: false, error: 'Link 1 must be an object with blocker and blocked.' });
    expect(createWorkflowWithPlan).not.toHaveBeenCalled();
  });
});
