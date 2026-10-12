/**
 * kangentic_save_workflow's schema takes as many planned tasks as the workflow
 * service does (MAX_WORKFLOW_TASKS). The schema once stopped at 60 while the
 * service allowed 100, so a plan of 61 to 100 tasks from the workflow agent
 * failed validation before the handler ever saw it.
 *
 * The tools read the cap from its own module, never from the service: a value
 * import of the service pulled its whole graph (task moves, the IPC handlers,
 * dev tooling) into the MCP server, which broke every MCP server test that
 * mocks only part of that graph. The last test pins that.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod/v4';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

const { registerWorkflowTools } = await import('../../src/main/agent/mcp-http/workflow-tools');
// The service enforces the same constant (workflow-service.ts imports it from here).
const { MAX_WORKFLOW_TASKS } = await import('../../src/main/workflows/workflow-limits');

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

  it('imports nothing from the workflow service, whose graph would ride into the MCP server', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/agent/mcp-http/workflow-tools.ts'), 'utf8');
    const valueImports = source.split('\n').filter((line) => /^import (?!type )/.test(line));
    expect(valueImports.filter((line) => line.includes('workflows/workflow-service'))).toEqual([]);
  });
});
