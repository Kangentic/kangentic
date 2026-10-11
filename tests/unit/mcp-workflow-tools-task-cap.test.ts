/**
 * kangentic_save_workflow's schema takes as many planned tasks as the workflow
 * service does (MAX_WORKFLOW_TASKS). The schema once stopped at 60 while the
 * service allowed 100, so a plan of 61 to 100 tasks from the workflow agent
 * failed validation before the handler ever saw it.
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod/v4';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { registerWorkflowTools } = await import('../../src/main/agent/mcp-http/workflow-tools');
const { MAX_WORKFLOW_TASKS } = await import('../../src/main/workflows/workflow-service');

function saveWorkflowSchema(): z.ZodObject {
  const schemas = new Map<string, unknown>();
  const server = {
    registerTool(name: string, config: { inputSchema?: unknown }) {
      schemas.set(name, config.inputSchema);
      return {};
    },
  };
  registerWorkflowTools(server as unknown as McpServer, {} as RequestResolver);
  return schemas.get('kangentic_save_workflow') as z.ZodObject;
}

function plannedTasks(count: number): Array<{ key: string; title: string }> {
  return Array.from({ length: count }, (_, index) => ({ key: `task-${index}`, title: `Task ${index}` }));
}

describe('kangentic_save_workflow task cap', () => {
  it('takes a plan as large as the service allows', () => {
    expect(saveWorkflowSchema().safeParse({ tasks: plannedTasks(MAX_WORKFLOW_TASKS) }).success).toBe(true);
  });

  it('refuses a plan one task past it', () => {
    expect(saveWorkflowSchema().safeParse({ tasks: plannedTasks(MAX_WORKFLOW_TASKS + 1) }).success).toBe(false);
  });
});
