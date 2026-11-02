/**
 * The running-work guard asks `CommandContext.callerKind`, so every tool that
 * can end another task's work has to set it, with the caller beside it, on the
 * context and never in the params. Without the marker the guard is silent, and
 * nothing else would fail: `kangentic_delete_task` forwarded neither caller
 * field before the guard, and the handlers read as a person's call without them.
 *
 * Same fake-McpServer capture as `mcp-task-placement-schema.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallHandler } = vi.hoisted(() => ({
  mockCallHandler: vi.fn(() => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
}));

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: vi.fn(),
  withProject: vi.fn((_resolver: unknown, _selector: unknown, run: (context: never) => unknown) => run({} as never)),
  detectCrossProjectMention: vi.fn(() => []),
  sanitizeProjectName: vi.fn((name: string) => name),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { registerAutomationTools } from '../../src/main/agent/mcp-http/automation-tools';

type FakeToolHandler = (args: Record<string, unknown>) => unknown;
interface FakeToolConfig { description?: string }

function registeredTools(callerTaskId: string | null, callerSessionId: string | null) {
  const handlers = new Map<string, FakeToolHandler>();
  const configs = new Map<string, FakeToolConfig>();
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig, handler: FakeToolHandler) => {
      configs.set(toolName, toolConfig);
      handlers.set(toolName, handler);
    }),
  };
  const taskCounter = { tryReserve: () => true, limit: () => 100 };
  registerTaskTools(server as never, {} as never, taskCounter as never, undefined, callerTaskId, callerSessionId);
  registerAutomationTools(server as never, {} as never, callerTaskId);
  return { handlers, configs };
}

function lastHandlerCall(): { params: Record<string, unknown>; context: Record<string, unknown> } {
  const [, params, context] = mockCallHandler.mock.lastCall as unknown as [string, Record<string, unknown>, Record<string, unknown>];
  return { params, context };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the tools the running-work guard reads', () => {
  it.each([
    ['kangentic_delete_task', { taskId: '42' }],
    ['kangentic_move_task', { taskId: '42', column: 'To Do' }],
    ['kangentic_run_automation', { column: 'Planning', automation: 'Send it', task: '42' }],
  ])('%s marks the call as an agent\'s, with its caller, on the context', (toolName, toolArguments) => {
    const { handlers } = registeredTools('task-caller', 'session-caller');

    handlers.get(toolName)!(toolArguments);

    const { params, context } = lastHandlerCall();
    expect(context).toMatchObject({ callerKind: 'agent', callerTaskId: 'task-caller' });
    expect(params).not.toHaveProperty('callerKind');
    expect(params).not.toHaveProperty('callerTaskId');
  });

  it.each(['kangentic_delete_task', 'kangentic_move_task', 'kangentic_run_automation'])('%s marks a caller with no task as an agent too', (toolName) => {
    const { handlers } = registeredTools(null, null);

    handlers.get(toolName)!({ taskId: '42', column: 'To Do', automation: 'Send it', task: '42' });

    expect(lastHandlerCall().context).toMatchObject({ callerKind: 'agent', callerTaskId: null });
  });

  it('kangentic_delete_task forwards the caller\'s session as well', () => {
    const { handlers } = registeredTools('task-caller', 'session-caller');

    handlers.get('kangentic_delete_task')!({ taskId: '42' });

    expect(lastHandlerCall().context).toMatchObject({ callerSessionId: 'session-caller' });
  });

  it.each(['kangentic_delete_task', 'kangentic_move_task', 'kangentic_run_automation'])('%s states the guard in its description', (toolName) => {
    const { configs } = registeredTools(null, null);

    const description = configs.get(toolName)?.description?.toLowerCase();
    expect(description).toContain('running work');
    expect(description).toContain('ask the user');
  });
});
