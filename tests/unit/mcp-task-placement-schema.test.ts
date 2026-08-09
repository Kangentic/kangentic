/**
 * The MCP wire contract for task placement: `kangentic_move_task`'s `position`
 * argument and the `kangentic_reorder_tasks` registration.
 *
 * Two things are pinned here that the handler tests cannot see, because they
 * live above the command layer:
 *
 *   1. The zod schema an agent's call is validated against, asserted through
 *      `safeParse` so a failure reads the same way a real MCP call would.
 *   2. That the tool actually FORWARDS the argument to the command layer. A
 *      schema can accept `position` perfectly while the handler drops it on the
 *      floor, which would silently degrade every placement call to an append.
 *
 * `handler-helpers` is mocked before importing task-tools.ts because it pulls in
 * `../commands` -> better-sqlite3, which will not load under vitest's Node ABI.
 * `withProject` is stubbed to invoke its callback so the forwarding assertion
 * reaches `callHandler`. Same fake-McpServer capture pattern as
 * mcp-task-tools-run-mode-schema.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod/v4';

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

// ---------------------------------------------------------------------------
// Fake McpServer: captures each registerTool(...) call's schema AND handler, so
// the test reflects on the real objects production code built.
// ---------------------------------------------------------------------------

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
}

type FakeToolHandler = (args: Record<string, unknown>) => unknown;

function makeServerWithTaskTools() {
  const configs = new Map<string, FakeToolConfig>();
  const handlers = new Map<string, FakeToolHandler>();
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig, handler: FakeToolHandler) => {
      configs.set(toolName, toolConfig);
      handlers.set(toolName, handler);
    }),
    getConfig(toolName: string): FakeToolConfig {
      const config = configs.get(toolName);
      if (!config) throw new Error(`Tool "${toolName}" was not registered`);
      return config;
    },
    getHandler(toolName: string): FakeToolHandler {
      const handler = handlers.get(toolName);
      if (!handler) throw new Error(`Tool "${toolName}" was not registered`);
      return handler;
    },
  };
  const taskCounter = { tryReserve: () => true, limit: () => 100 };
  registerTaskTools(server as never, {} as never, taskCounter as never);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('kangentic_move_task position argument', () => {
  it('accepts a zero-based slot', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_move_task');

    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do', position: 0 }).success).toBe(true);
    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do', position: 7 }).success).toBe(true);
  });

  it('stays optional so every existing caller keeps working', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_move_task');

    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do' }).success).toBe(true);
  });

  it('rejects a negative, fractional, or non-numeric slot at the wire', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_move_task');

    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do', position: -1 }).success).toBe(false);
    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do', position: 1.5 }).success).toBe(false);
    expect(inputSchema.safeParse({ taskId: '42', column: 'To Do', position: 'first' }).success).toBe(false);
  });

  it('forwards position to the command layer', () => {
    const server = makeServerWithTaskTools();

    server.getHandler('kangentic_move_task')({ taskId: '42', column: 'To Do', position: 0 });

    expect(mockCallHandler).toHaveBeenCalledWith(
      'move_task',
      expect.objectContaining({ taskId: '42', column: 'To Do', position: 0 }),
      expect.anything(),
      expect.any(String),
    );
  });

  it('forwards an omitted position as null, which the handler reads as "append"', () => {
    const server = makeServerWithTaskTools();

    server.getHandler('kangentic_move_task')({ taskId: '42', column: 'To Do' });

    expect(mockCallHandler).toHaveBeenCalledWith(
      'move_task',
      expect.objectContaining({ position: null }),
      expect.anything(),
      expect.any(String),
    );
  });
});

describe('kangentic_reorder_tasks registration', () => {
  it('is registered as a mutating tool', () => {
    const config = makeServerWithTaskTools().getConfig('kangentic_reorder_tasks');

    expect(config.annotations).toEqual({ readOnlyHint: false, idempotentHint: false });
  });

  it('accepts a column plus an ordered list of task ids', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_reorder_tasks');

    expect(inputSchema.safeParse({ column: 'To Do', taskIds: ['12', '7'] }).success).toBe(true);
    expect(inputSchema.safeParse({ column: 'To Do', taskIds: ['12'], project: 'other' }).success).toBe(true);
  });

  it('rejects an empty, missing, or non-string id list', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_reorder_tasks');

    expect(inputSchema.safeParse({ column: 'To Do', taskIds: [] }).success).toBe(false);
    expect(inputSchema.safeParse({ column: 'To Do' }).success).toBe(false);
    expect(inputSchema.safeParse({ column: 'To Do', taskIds: [12] }).success).toBe(false);
  });

  it('requires a column', () => {
    const { inputSchema } = makeServerWithTaskTools().getConfig('kangentic_reorder_tasks');

    expect(inputSchema.safeParse({ taskIds: ['12'] }).success).toBe(false);
  });

  it('routes to the reorder_tasks command, not move_task', () => {
    const server = makeServerWithTaskTools();

    server.getHandler('kangentic_reorder_tasks')({ column: 'To Do', taskIds: ['12', '7'] });

    expect(mockCallHandler).toHaveBeenCalledWith(
      'reorder_tasks',
      { column: 'To Do', taskIds: ['12', '7'] },
      expect.anything(),
      expect.any(String),
    );
  });
});
