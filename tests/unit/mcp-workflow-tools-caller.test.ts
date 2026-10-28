/**
 * `kangentic_pause_workflow` names its caller to the command layer.
 *
 * A member's own agent that pauses its workflow is paused once its turn ends,
 * not before the reply (#916's class: paused at once, Claude exits without
 * writing the call, and after a Resume the agent pauses again). The handler
 * learns which session asked only from the command context, so the tool must
 * put the request's caller there, and never in the params, which the phone's
 * board-tool path passes straight through.
 *
 * Driven through the REAL registration, with `callHandler` as the spy.
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
import { registerWorkflowTools } from '../../src/main/agent/mcp-http/workflow-tools';

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

function pauseToolFor(caller?: { taskId: string | null; sessionId: string | null }): ToolCallback {
  let pauseTool: ToolCallback | undefined;
  const server = {
    registerTool: vi.fn((toolName: string, _config: unknown, callback: ToolCallback) => {
      if (toolName === 'kangentic_pause_workflow') pauseTool = callback;
    }),
  };
  registerWorkflowTools(server as never, {} as RequestResolver, caller);
  if (!pauseTool) throw new Error('kangentic_pause_workflow was not registered');
  return pauseTool;
}

function lastPauseCall(): { params: Record<string, unknown>; context: Record<string, unknown> } {
  const call = vi.mocked(callHandler).mock.calls.filter(([name]) => name === 'pause_workflow').at(-1);
  if (!call) throw new Error('callHandler was never called for "pause_workflow"');
  return { params: call[1], context: call[2] as Record<string, unknown> };
}

beforeEach(() => {
  vi.mocked(callHandler).mockClear();
});

describe('kangentic_pause_workflow caller', () => {
  it('puts the caller\'s task and session on the command context, not in the params', async () => {
    await pauseToolFor({ taskId: 'task-caller', sessionId: 'session-caller' })({ workflow: 'Usage budgets' });

    const { params, context } = lastPauseCall();
    expect(context).toMatchObject({ callerTaskId: 'task-caller', callerSessionId: 'session-caller' });
    expect(params).toEqual({ workflow: 'Usage budgets' });
  });

  it('carries null for a caller with neither, as the workflow agent\'s scoped server registers it', async () => {
    await pauseToolFor()({ workflow: 'Usage budgets' });

    expect(lastPauseCall().context).toMatchObject({ callerTaskId: null, callerSessionId: null });
  });
});
