/**
 * #1211: a link or an added task can name a board task outside the workflow, and
 * it joins where it is. The command handlers carry that to the agent in two
 * places this file pins: the reply to kangentic_link_workflow_tasks says which
 * tasks joined, and kangentic_add_workflow_task hands waitsFor to the service
 * with every entry given a project.
 *
 * The service is mocked: its own rules are pinned against real SQLite in
 * workflow-join-where-it-is.test.ts. Only what the handler builds is read here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveWorkflow = vi.fn();
const linkTasks = vi.fn();
const addWorkflowTask = vi.fn();
const checkPlannedModel = vi.fn();
const readWorkflow = vi.fn();
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-service')>();
  return {
    ...actual,
    resolveWorkflow: (...args: unknown[]) => resolveWorkflow(...args),
    linkTasks: (...args: unknown[]) => linkTasks(...args),
    addWorkflowTask: (...args: unknown[]) => addWorkflowTask(...args),
    checkPlannedModel: (...args: unknown[]) => checkPlannedModel(...args),
    readWorkflow: (...args: unknown[]) => readWorkflow(...args),
  };
});
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>();
  return { ...actual, requireWorkflowRuntimeContext: () => ({}) };
});

import type { ZodType } from 'zod/v4';
import { commandHandlers } from '../../src/main/agent/commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import { registerWorkflowTools } from '../../src/main/agent/mcp-http/workflow-tools';

const context = { projectId: 'proj-1' } as unknown as CommandContext;
const workflow = { id: 'wf-1', title: 'Release 0.63.1' };
const link = { id: 'link-1' };

describe('kangentic_link_workflow_tasks reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkflow.mockReturnValue(workflow);
  });

  const params = { workflow: 'wf-1', blocker: '1208', blocked: '1210' };

  it('says only that the link was made when nothing joined', async () => {
    linkTasks.mockReturnValue({ link, joined: [] });

    const response = await commandHandlers.link_workflow_tasks(params, context);

    expect(response).toEqual({ success: true, message: 'Linked: 1210 now waits for 1208 to reach Done.' });
  });

  it('names a single joined task, in the singular', async () => {
    linkTasks.mockReturnValue({ link, joined: [{ display_id: 1208 }] });

    const response = await commandHandlers.link_workflow_tasks(params, context);

    expect(response).toEqual({
      success: true,
      message: 'Linked: 1210 now waits for 1208 to reach Done. #1208 joined "Release 0.63.1" where it is.',
    });
  });

  it('names two joined tasks, in the plural', async () => {
    linkTasks.mockReturnValue({ link, joined: [{ display_id: 1208 }, { display_id: 1209 }] });

    const response = await commandHandlers.link_workflow_tasks(params, context);

    expect(response).toEqual({
      success: true,
      message: 'Linked: 1210 now waits for 1208 to reach Done. #1208 and #1209 joined "Release 0.63.1" where they are.',
    });
  });
});

describe('kangentic_add_workflow_task waitsFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkflow.mockReturnValue(workflow);
    addWorkflowTask.mockReturnValue({ id: 'task-new', display_id: 1300, title: 'Release' });
    readWorkflow.mockReturnValue({ tasks: [] });
  });

  it('hands each entry to the service as a number or id, or as a task with its project (null when none was named)', async () => {
    const response = await commandHandlers.add_workflow_task({
      workflow: 'wf-1',
      title: 'Release',
      waitsFor: ['1208', { task: '5', project: 'mobile' }, { task: '6' }],
    }, context);

    expect(response.success).toBe(true);
    expect(addWorkflowTask).toHaveBeenCalledTimes(1);
    const input = addWorkflowTask.mock.calls[0][3] as { waitsFor: unknown };
    expect(input.waitsFor).toEqual(['1208', { task: '5', project: 'mobile' }, { task: '6', project: null }]);
  });

  it('hands the service no waitsFor when none was given', async () => {
    await commandHandlers.add_workflow_task({ workflow: 'wf-1', title: 'Release' }, context);

    const input = addWorkflowTask.mock.calls[0][3] as { waitsFor: unknown };
    expect(input.waitsFor).toBeNull();
  });
});

/**
 * An agent's call reaches the handler above only through the tool's zod schema
 * (src/main/agent/mcp-http/workflow-tools.ts), so a schema that took only
 * strings would refuse a number on another board before the handler saw it.
 */
describe('kangentic_add_workflow_task schema for waitsFor', () => {
  function addTaskSchema(): ZodType {
    const schemas = new Map<string, ZodType>();
    const server = {
      registerTool: (toolName: string, toolConfig: { inputSchema: ZodType }) => {
        schemas.set(toolName, toolConfig.inputSchema);
      },
    };
    registerWorkflowTools(server as never, {} as never);
    const schema = schemas.get('kangentic_add_workflow_task');
    if (!schema) throw new Error('kangentic_add_workflow_task was not registered');
    return schema;
  }

  it('accepts a number or id, and a task with or without its project', () => {
    const parsed = addTaskSchema().safeParse({
      workflow: 'Release 0.63.1',
      title: 'Release',
      waitsFor: ['1208', { task: '5', project: 'kangentic-mobile' }, { task: '6' }],
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses an entry that names a project but no task', () => {
    const parsed = addTaskSchema().safeParse({
      workflow: 'Release 0.63.1',
      title: 'Release',
      waitsFor: [{ project: 'kangentic-mobile' }],
    });

    expect(parsed.success).toBe(false);
  });
});
