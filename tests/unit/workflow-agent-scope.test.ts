/**
 * The workflow agent's MCP scope (src/main/agent/mcp-http/workflow-agent-scope.ts):
 * which registrations reach the server, and that a planning tool is bound to the
 * caller's own workflow whatever the agent passes.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { scopeServerToWorkflowAgent, workflowAgentMayUse } from '../../src/main/agent/mcp-http/workflow-agent-scope';

interface CapturedTool {
  name: string;
  config: { inputSchema?: unknown };
  callback: (args: Record<string, unknown>, extra: unknown) => unknown;
}

function captureServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const fake = {
    registerTool(name: string, config: { inputSchema?: unknown }, callback: CapturedTool['callback']) {
      tools.push({ name, config, callback });
      return {};
    },
  };
  return { server: fake as unknown as McpServer, tools };
}

const READ_ONLY = { readOnlyHint: true };
const MUTATING = { readOnlyHint: false };

describe('workflow agent MCP scope', () => {
  it('registers read-only tools and planning tools, and drops the rest', () => {
    const { server, tools } = captureServer();
    const scoped = scopeServerToWorkflowAgent(server, 'wf-1');
    const noop = () => null;
    scoped.registerTool('kangentic_list_tasks', { annotations: READ_ONLY }, noop);
    scoped.registerTool('kangentic_create_task', { annotations: MUTATING }, noop);
    scoped.registerTool('kangentic_save_workflow', { annotations: MUTATING }, noop);
    scoped.registerTool('kangentic_start_workflow', { annotations: MUTATING }, noop);
    scoped.registerTool('kangentic_browser_screenshot', { annotations: READ_ONLY }, noop);
    expect(tools.map((tool) => tool.name)).toEqual(['kangentic_list_tasks', 'kangentic_save_workflow']);
  });

  it('binds a planning tool to the caller\'s workflow and drops `project`', () => {
    const { server, tools } = captureServer();
    const scoped = scopeServerToWorkflowAgent(server, 'wf-1');
    const received: Array<Record<string, unknown>> = [];
    scoped.registerTool(
      'kangentic_link_workflow_tasks',
      {
        annotations: MUTATING,
        inputSchema: z.object({ workflow: z.string(), blocker: z.string(), project: z.string().optional() }),
      },
      (args) => { received.push(args); return null; },
    );
    const [tool] = tools;
    const schema = tool.config.inputSchema as z.ZodObject;
    // The agent may leave `workflow` out, and cannot name a project.
    expect(schema.safeParse({ blocker: '12' }).success).toBe(true);
    expect(Object.keys(schema.shape)).not.toContain('project');
    // Whatever it names, the call acts on its own workflow.
    tool.callback({ workflow: 'Someone else\'s', blocker: '12', project: 'other' }, {});
    expect(received).toEqual([{ workflow: 'wf-1', blocker: '12', project: undefined }]);
  });

  it('reads its own workflow when get_workflow names none', () => {
    const { server, tools } = captureServer();
    const scoped = scopeServerToWorkflowAgent(server, 'wf-1');
    const received: Array<Record<string, unknown>> = [];
    scoped.registerTool(
      'kangentic_get_workflow',
      { annotations: READ_ONLY, inputSchema: z.object({ workflow: z.string() }) },
      (args) => { received.push(args); return null; },
    );
    tools[0].callback({}, {});
    expect(received[0].workflow).toBe('wf-1');
  });

  it('leaves an ordinary read-only tool as registered', () => {
    const { server, tools } = captureServer();
    const scoped = scopeServerToWorkflowAgent(server, 'wf-1');
    const schema = z.object({ project: z.string().optional() });
    const callback = () => null;
    scoped.registerTool('kangentic_list_tasks', { annotations: READ_ONLY, inputSchema: schema }, callback);
    expect(tools[0].config.inputSchema).toBe(schema);
    expect(tools[0].callback).toBe(callback);
  });

  it('decides by name and annotation alone', () => {
    expect(workflowAgentMayUse('kangentic_find_task', true)).toBe(true);
    expect(workflowAgentMayUse('kangentic_move_task', false)).toBe(false);
    expect(workflowAgentMayUse('kangentic_remove_from_workflow', false)).toBe(true);
    expect(workflowAgentMayUse('kangentic_browser_list_panes', true)).toBe(false);
  });
});
