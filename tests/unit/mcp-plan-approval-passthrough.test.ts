/**
 * `planApproval` rides each MCP tool that takes it down to its command handler.
 *
 * The three tools destructure it from their zod input and rebuild the params
 * object by hand (`kangentic_update_column` and `kangentic_create_column` in
 * task-tools.ts, `kangentic_save_workflow` in workflow-tools.ts), so a dropped
 * name does not fail a schema test or a handler test: the schema still accepts
 * the value, the handler still honours it, and the pick simply never arrives.
 * The agent is told "Saved" and the plan is approved by the wrong party.
 *
 * Both modules are driven through their REAL registration. `withProject` is
 * replaced by a stand-in that runs the tool body, and `callHandler` is the spy
 * the assertions read, so what is checked is exactly the params object each
 * tool hands the handler. The values are asserted with `toBe`, `toBeNull` and
 * `toBeUndefined` rather than `objectContaining`, because null (follow the
 * plan columns) and undefined (leave what is stored alone) mean different
 * things to `kangentic_save_workflow` and a loose matcher would blur them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(async () => ({ content: [] })),
  runHandler: vi.fn(),
  // Runs the tool body, as the real one does once the project resolves.
  withProject: vi.fn(
    async (_resolver: unknown, _selector: unknown, run: (context: object, resolved: object) => Promise<unknown>) => run({}, {}),
  ),
  appendNoticeLine: vi.fn(),
  detectCrossProjectMention: vi.fn(),
  sanitizeProjectName: vi.fn(),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { callHandler } from '../../src/main/agent/mcp-http/handler-helpers';
import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { registerWorkflowTools } from '../../src/main/agent/mcp-http/workflow-tools';

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

function captureToolCallbacks(register: (server: never) => void): Map<string, ToolCallback> {
  const callbacks = new Map<string, ToolCallback>();
  const server = {
    registerTool: vi.fn((toolName: string, _config: unknown, callback: ToolCallback) => {
      callbacks.set(toolName, callback);
    }),
  };
  register(server as never);
  return callbacks;
}

/** The params object the most recent call to the named command handler received. */
function paramsSentTo(handlerName: string): Record<string, unknown> {
  const matchingCalls = vi.mocked(callHandler).mock.calls.filter(([name]) => name === handlerName);
  const lastCall = matchingCalls.at(-1);
  if (!lastCall) throw new Error(`callHandler was never called for "${handlerName}"`);
  return lastCall[1];
}

function requireCallback(callbacks: Map<string, ToolCallback>, toolName: string): ToolCallback {
  const callback = callbacks.get(toolName);
  if (!callback) throw new Error(`Tool "${toolName}" was not registered`);
  return callback;
}

beforeEach(() => {
  vi.mocked(callHandler).mockClear();
});

describe('planApproval passthrough on the column tools', () => {
  const columnCallbacks = captureToolCallbacks((server) => {
    registerTaskTools(server, {} as RequestResolver, {} as never);
  });

  it.each([
    ['kangentic_update_column', 'update_column', { column: 'Plan' }],
    ['kangentic_create_column', 'create_column', { name: 'Plan' }],
  ])('%s hands "automatic" and "manual" to %s as given', async (toolName, handlerName, requiredArgs) => {
    const callback = requireCallback(columnCallbacks, toolName);

    await callback({ ...requiredArgs, planApproval: 'automatic' });
    expect(paramsSentTo(handlerName).planApproval).toBe('automatic');

    await callback({ ...requiredArgs, planApproval: 'manual' });
    expect(paramsSentTo(handlerName).planApproval).toBe('manual');
  });

  it.each([
    ['kangentic_update_column', 'update_column', { column: 'Plan' }],
    ['kangentic_create_column', 'create_column', { name: 'Plan' }],
  ])('%s leaves it undefined for %s when the call does not name it', async (toolName, handlerName, requiredArgs) => {
    await requireCallback(columnCallbacks, toolName)(requiredArgs);

    // Undefined, never defaulted to "manual": an update that did not mention
    // approval must not overwrite the column's stored pick.
    expect(paramsSentTo(handlerName).planApproval).toBeUndefined();
  });
});

describe('planApproval passthrough on kangentic_save_workflow', () => {
  const workflowCallbacks = captureToolCallbacks((server) => {
    registerWorkflowTools(server, {} as RequestResolver);
  });
  const tasks = [{ key: 'api', title: 'Budgets API' }];

  it.each([
    ['automatic', 'automatic'],
    ['manual', 'manual'],
  ])('hands "%s" to save_workflow as given', async (_label, planApproval) => {
    await requireCallback(workflowCallbacks, 'kangentic_save_workflow')({ tasks, planApproval });

    expect(paramsSentTo('save_workflow').planApproval).toBe(planApproval);
  });

  it('hands an explicit null through as null, which follows the plan columns', async () => {
    await requireCallback(workflowCallbacks, 'kangentic_save_workflow')({ tasks, planApproval: null });

    expect(paramsSentTo('save_workflow').planApproval).toBeNull();
  });

  it('leaves it undefined, not null, when the call does not name it, so a stored pick survives', async () => {
    await requireCallback(workflowCallbacks, 'kangentic_save_workflow')({ tasks });

    expect(paramsSentTo('save_workflow').planApproval).toBeUndefined();
  });
});
