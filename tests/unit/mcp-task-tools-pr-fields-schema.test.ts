/**
 * MCP task tools: the `prUrl` / `prNumber` zod constraints on
 * `kangentic_create_task` and `kangentic_update_task` (task-tools.ts) are
 * never exercised by any existing test.
 *
 * `tests/unit/mcp-task-pr-fields.test.ts` covers the same two fields, but at
 * the `handleCreateTask` / `handleUpdateTask` command-handler layer - it
 * calls the handlers directly, bypassing the zod `inputSchema` entirely. A
 * handler call can't reject a malformed `prUrl` or a negative `prNumber`,
 * because zod already stripped the field-shape problem out of the picture
 * before the handler saw the arguments. Reverting `z.string().url()` to a
 * bare `z.string()`, or `z.number().int().positive()` to a bare `z.number()`,
 * fails nothing in that file.
 *
 * This test reflects on the ACTUAL zod schema captured off a real
 * `registerTaskTools` registration (the same fake-McpServer capture pattern
 * as mcp-task-tools-run-mode-schema.test.ts and mcp-profile-tools-schema.test.ts)
 * so it fails the same way a real MCP call would, rather than re-declaring
 * the accepted shape as a second hardcoded assertion that could drift from
 * the real schema.
 *
 * Both `kangentic_create_task` and `kangentic_update_task` declare `prUrl` /
 * `prNumber` as two SEPARATE inline schemas (unlike `runMode`, which shares
 * one `RUN_MODE_SCHEMA` const) - each tool is exercised so a constraint
 * change to only one of the two inline copies is caught.
 *
 * `handler-helpers` is mocked before importing task-tools.ts because it pulls
 * in `../commands` -> better-sqlite3, which this unit test does not need:
 * `registerTool` only ever STORES the config here, it never invokes a handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(),
  runHandler: vi.fn(),
  withProject: vi.fn(),
  detectCrossProjectMention: vi.fn(() => []),
  sanitizeProjectName: vi.fn((name: string) => name),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';

// ---------------------------------------------------------------------------
// Fake McpServer: captures each registerTool(...) call's inputSchema so the
// test reflects on the REAL zod schema object built by production code.
// ---------------------------------------------------------------------------

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
}

function makeServerWithTaskTools() {
  const registeredConfigs = new Map<string, FakeToolConfig>();
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig) => {
      registeredConfigs.set(toolName, toolConfig);
    }),
    getInputSchema(toolName: string): z.ZodType {
      const toolConfig = registeredConfigs.get(toolName);
      if (!toolConfig) throw new Error(`Tool "${toolName}" was not registered`);
      return toolConfig.inputSchema;
    },
  };
  const taskCounter = { tryReserve: () => true, limit: () => 100 };
  registerTaskTools(server as never, {} as never, taskCounter as never);
  return server;
}

type TaskToolName = 'kangentic_create_task' | 'kangentic_update_task';

/**
 * The minimal params each tool needs to validate on its own, so a test can
 * add only the prUrl/prNumber fields under test without also tripping an
 * unrelated "missing required field" failure.
 * `kangentic_create_task` requires `title`; `kangentic_update_task` requires
 * `taskId`.
 */
const REQUIRED_BASE_PARAMS: Record<TaskToolName, Record<string, unknown>> = {
  kangentic_create_task: { title: 'Review an existing PR' },
  kangentic_update_task: { taskId: 'task-1' },
};

describe.each(Object.keys(REQUIRED_BASE_PARAMS) as TaskToolName[])(
  '%s prUrl / prNumber schema constraints',
  (toolName) => {
    const baseParams = REQUIRED_BASE_PARAMS[toolName];

    it('rejects a malformed prUrl', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse({ ...baseParams, prUrl: 'not-a-url' }).success).toBe(false);
    });

    it('accepts a well-formed prUrl', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(
        inputSchema.safeParse({ ...baseParams, prUrl: 'https://github.com/owner/repo/pull/42' }).success,
      ).toBe(true);
    });

    it('rejects a negative prNumber', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse({ ...baseParams, prNumber: -1 }).success).toBe(false);
    });

    it('rejects a zero prNumber', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse({ ...baseParams, prNumber: 0 }).success).toBe(false);
    });

    it('rejects a non-integer prNumber', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse({ ...baseParams, prNumber: 1.5 }).success).toBe(false);
    });

    it('accepts a positive integer prNumber', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse({ ...baseParams, prNumber: 42 }).success).toBe(true);
    });

    it('accepts the call with prUrl and prNumber both absent, since both are optional', () => {
      const inputSchema = makeServerWithTaskTools().getInputSchema(toolName);

      expect(inputSchema.safeParse(baseParams).success).toBe(true);
    });
  },
);
