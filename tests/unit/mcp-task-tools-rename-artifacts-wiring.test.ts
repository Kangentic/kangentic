import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod/v4';

/**
 * MCP task tools: `renameArtifacts` on kangentic_update_task
 * (src/main/agent/mcp-http/task-tools.ts). An agent loses: a rename the tool
 * accepts and never hands the handler, which reports nothing wrong, or a
 * rename-only call the "at least one field" gate refuses.
 *
 * TOOL layer only, on the harness of mcp-task-tools-automations-disabled-wiring.test.ts.
 * What the handler does with the field is in mcp-task-artifacts.test.ts, over
 * the real handlers and a real database.
 *
 * Red-green: drop `renameArtifacts` from the gate and the rename-only case is
 * refused; drop its forward and the forwarded params lack it.
 */

const { mockCallHandler, mockWithProject } = vi.hoisted(() => {
  const mockCallHandler = vi.fn(() => Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const mockWithProject = vi.fn(
    async (_resolver: unknown, _selector: unknown, run: (ctx: unknown, resolved: unknown) => Promise<unknown>) => {
      const resolved = {
        context: { getProjectPath: () => '/projects/default' },
        projectId: '11111111-1111-4111-8111-111111111111',
        projectName: 'Active',
        isDefault: true,
      };
      return run(resolved.context, resolved);
    },
  );
  return { mockCallHandler, mockWithProject };
});

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: vi.fn(),
  withProject: mockWithProject,
  detectCrossProjectMention: vi.fn((): string[] => []),
  sanitizeProjectName: (name: string) => name,
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 27_500,
  handleMoveTaskToProject: vi.fn(),
}));

vi.mock('../../src/main/agent/mcp-http/spawn-override-validation', () => ({
  validateSpawnOverrides: vi.fn(async () => null),
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const CANVAS = 'https://claude.ai/artifact/WpdicMm97cV1F6AUGU3RFA';

describe('kangentic_update_task renameArtifacts', () => {
  const handlers: Record<string, ToolHandler> = {};
  const schemas: Record<string, z.ZodType> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    const server = {
      registerTool: (name: string, config: { inputSchema: z.ZodType }, handler: ToolHandler) => {
        handlers[name] = handler;
        schemas[name] = config.inputSchema;
      },
    };
    const resolver = {
      getProjectDefaultAgent: vi.fn(() => null),
      getAgentValidationConfig: vi.fn(() => ({ cliPathOverrides: {}, discoveredModelsByAgent: {} })),
    } as unknown as RequestResolver;
    registerTaskTools(server as never, resolver, { tryReserve: vi.fn(() => true), limit: () => 50 });
  });

  it('accepts a name or null, and refuses an entry with no name', () => {
    const schema = schemas.kangentic_update_task;
    expect(schema.safeParse({ taskId: 't', renameArtifacts: [{ url: CANVAS, name: 'Canvas' }] }).success).toBe(true);
    expect(schema.safeParse({ taskId: 't', renameArtifacts: [{ url: CANVAS, name: null }] }).success).toBe(true);
    expect(schema.safeParse({ taskId: 't', renameArtifacts: [{ url: CANVAS }] }).success).toBe(false);
  });

  it('lets a rename-only update through the gate and forwards it to the handler', async () => {
    const renames = [{ url: CANVAS, name: 'Import canvas' }];
    const result = await handlers.kangentic_update_task({ taskId: 'task-1', renameArtifacts: renames });
    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [command, params] = mockCallHandler.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(command).toBe('update_task');
    expect(params.renameArtifacts).toEqual(renames);
  });

  it('forwards null when the field is omitted', async () => {
    await handlers.kangentic_update_task({ taskId: 'task-1', title: 'Renamed' });
    const [, params] = mockCallHandler.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params.renameArtifacts).toBeNull();
  });
});
