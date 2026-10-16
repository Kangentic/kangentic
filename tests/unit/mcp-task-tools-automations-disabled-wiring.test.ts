import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod/v4';

/**
 * MCP task tools: the `automationsDisabled` switch on kangentic_create_task and
 * kangentic_update_task (src/main/agent/mcp-http/task-tools.ts).
 *
 * This file covers the TOOL layer only: the zod input schema, the
 * "Provide at least one field to update" gate, and what reaches the command
 * handler. What the handler does with it (the row it writes, the workflow
 * refusal, the settings hook) needs the real handlers over a real database and
 * is in task-commands-automations-disabled.test.ts: `vi.mock` is file-scoped,
 * and this file replaces task-commands with stubs.
 *
 * Harness mirrors mcp-task-tools-run-mode-wiring.test.ts: handler-helpers is
 * mocked (callHandler / withProject / detectCrossProjectMention), and a fake
 * McpServer stores each tool's config and handler by name so they can be
 * inspected and invoked directly, without the SDK transport.
 */

const { mockCallHandler, mockWithProject, mockDetectCrossProjectMention } = vi.hoisted(() => {
  const mockCallHandler = vi.fn(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  const mockDetectCrossProjectMention = vi.fn((): string[] => []);
  const mockWithProject = vi.fn(
    async (
      _resolver: unknown,
      _selector: unknown,
      run: (ctx: unknown, resolved: unknown) => Promise<unknown>,
      _options?: { alwaysAnnotate?: boolean },
    ) => {
      const resolved = {
        context: { getProjectPath: () => '/projects/default' },
        projectId: '11111111-1111-4111-8111-111111111111',
        projectName: 'Active',
        isDefault: true,
      };
      return run(resolved.context, resolved);
    },
  );
  return { mockCallHandler, mockWithProject, mockDetectCrossProjectMention };
});

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: vi.fn(),
  withProject: mockWithProject,
  detectCrossProjectMention: mockDetectCrossProjectMention,
  sanitizeProjectName: (name: string) => name,
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

// task-tools.ts imports handleMoveTaskToProject directly from task-commands;
// stubbed so this suite stays DB-free. Unused by the tests below.
vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 50_000,
  handleMoveTaskToProject: vi.fn(),
}));

// The real override validator probes the machine's installed agent CLIs.
vi.mock('../../src/main/agent/mcp-http/spawn-override-validation', () => ({
  validateSpawnOverrides: vi.fn(async () => null),
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
}

function makeFakeServer() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, FakeToolConfig> = {};
  return {
    registerTool: vi.fn((name: string, config: FakeToolConfig, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    }),
    getHandler(name: string): ToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
    getConfig(name: string): FakeToolConfig {
      const config = configs[name];
      if (!config) throw new Error(`Tool "${name}" was not registered`);
      return config;
    },
  };
}

function makeResolver(): RequestResolver {
  const resolved = {
    context: { getProjectPath: () => '/projects/default' },
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'Active',
    isDefault: true,
  };
  return {
    resolveProject: vi.fn(() => resolved),
    listProjects: vi.fn(() => []),
    defaultContextResolved: vi.fn(() => resolved),
    getProjectDefaultAgent: vi.fn(() => null),
    getAgentValidationConfig: vi.fn(() => ({ cliPathOverrides: {}, discoveredModelsByAgent: {} })),
  } as unknown as RequestResolver;
}

/** The params the tool handed the command handler on its one call. */
function forwardedParams(): Record<string, unknown> {
  expect(mockCallHandler).toHaveBeenCalledOnce();
  const [, params] = mockCallHandler.mock.calls[0] as unknown as [string, Record<string, unknown>];
  return params;
}

describe('MCP task tools and the automations switch', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectCrossProjectMention.mockReturnValue([]);
    server = makeFakeServer();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, makeResolver(), taskCounter);
  });

  describe('the input schema', () => {
    it.each(['kangentic_create_task', 'kangentic_update_task'])('%s accepts a boolean and leaves the field optional', (toolName) => {
      const inputSchema = server.getConfig(toolName).inputSchema;
      const base = toolName === 'kangentic_create_task' ? { title: 'T' } : { taskId: 'task-1' };

      expect(inputSchema.safeParse({ ...base, automationsDisabled: true }).success).toBe(true);
      expect(inputSchema.safeParse({ ...base, automationsDisabled: false }).success).toBe(true);
      expect(inputSchema.safeParse(base).success).toBe(true);
    });

    it.each(['kangentic_create_task', 'kangentic_update_task'])('%s rejects a non-boolean, so a truthy string cannot disable a task', (toolName) => {
      const inputSchema = server.getConfig(toolName).inputSchema;
      const base = toolName === 'kangentic_create_task' ? { title: 'T' } : { taskId: 'task-1' };

      expect(inputSchema.safeParse({ ...base, automationsDisabled: 'true' }).success).toBe(false);
      expect(inputSchema.safeParse({ ...base, automationsDisabled: 1 }).success).toBe(false);
    });

    it('both tools describe the switch with the same text', () => {
      const describeField = (toolName: string): string | undefined => {
        const shape = (server.getConfig(toolName).inputSchema as unknown as { def: { shape: Record<string, z.ZodType> } }).def.shape;
        return shape.automationsDisabled.description;
      };

      expect(describeField('kangentic_create_task')).toBeTruthy();
      expect(describeField('kangentic_update_task')).toBe(describeField('kangentic_create_task'));
    });
  });

  describe('kangentic_create_task', () => {
    it('forwards automationsDisabled: true to the command handler', async () => {
      const result = await server.getHandler('kangentic_create_task')({ title: 'T', automationsDisabled: true });

      expect(result.isError).toBeUndefined();
      expect(forwardedParams().automationsDisabled).toBe(true);
    });

    it('forwards automationsDisabled: false as false, not as an omitted value', async () => {
      await server.getHandler('kangentic_create_task')({ title: 'T', automationsDisabled: false });

      expect(forwardedParams().automationsDisabled).toBe(false);
    });

    it('forwards null when the field is omitted', async () => {
      await server.getHandler('kangentic_create_task')({ title: 'T' });

      expect(forwardedParams().automationsDisabled).toBeNull();
    });
  });

  describe('kangentic_update_task', () => {
    it('forwards automationsDisabled: true to the command handler', async () => {
      await server.getHandler('kangentic_update_task')({ taskId: 'task-1', automationsDisabled: true });

      expect(forwardedParams().automationsDisabled).toBe(true);
    });

    it('lets an update of only automationsDisabled: false through the "at least one field" gate', async () => {
      const result = await server.getHandler('kangentic_update_task')({ taskId: 'task-1', automationsDisabled: false });

      // Red if the field were left out of the gate: false is falsy, so a check
      // on truthiness instead of `=== undefined` would refuse it.
      expect(result.isError).toBeUndefined();
      expect(forwardedParams().automationsDisabled).toBe(false);
    });

    it('lets an update of only automationsDisabled: true through the gate', async () => {
      const result = await server.getHandler('kangentic_update_task')({ taskId: 'task-1', automationsDisabled: true });

      expect(result.isError).toBeUndefined();
      expect(mockCallHandler).toHaveBeenCalledOnce();
    });

    it('still refuses an update that names no field at all (the control for the gate)', async () => {
      const result = await server.getHandler('kangentic_update_task')({ taskId: 'task-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Provide at least one field to update.');
      expect(mockCallHandler).not.toHaveBeenCalled();
    });

    it('forwards null when the field is omitted from an update of something else', async () => {
      await server.getHandler('kangentic_update_task')({ taskId: 'task-1', title: 'Renamed' });

      expect(forwardedParams().automationsDisabled).toBeNull();
    });
  });
});
