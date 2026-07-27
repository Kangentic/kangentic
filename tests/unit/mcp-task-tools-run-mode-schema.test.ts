/**
 * MCP task tools: `runMode` literal parity with the shared `TaskRunMode` union
 * (src/shared/types.ts).
 *
 * `RUN_MODE_SCHEMA` (task-tools.ts) is a module-private const, so this test
 * reflects on the ACTUAL zod schema captured off a real `registerTaskTools`
 * registration (the same fake-McpServer capture pattern as
 * mcp-profile-tools-schema.test.ts) rather than re-declaring the accepted
 * literals as a second hardcoded list, which would just move the drift risk
 * from source to test.
 *
 * The failure class this pins is the one `sessionSpawnStrategy` already shipped
 * once: a zod enum whose literals do not exist on the union it mirrors. An
 * agent sending the real value gets rejected, and an agent sending the
 * schema's advertised value gets persisted as a mode nothing downstream reads -
 * which for run_mode means a task that claims Agent Override and silently never
 * locks.
 *
 * `handler-helpers` is mocked before importing task-tools.ts because it pulls
 * in `../commands` -> better-sqlite3, which this unit test does not need:
 * `registerTool` only ever STORES the config here, it never invokes a handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';
import type { TaskRunMode } from '../../src/shared/types';

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

interface ZodInternalDefinition {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
}

function readZodDefinition(schema: z.ZodType): ZodInternalDefinition {
  return (schema as unknown as { def: ZodInternalDefinition }).def;
}

function unwrapOptionalOrNullable(schema: z.ZodType): z.ZodType {
  let currentSchema = schema;
  for (;;) {
    const definition = readZodDefinition(currentSchema);
    if ((definition.type === 'optional' || definition.type === 'nullable') && definition.innerType) {
      currentSchema = definition.innerType;
      continue;
    }
    return currentSchema;
  }
}

/**
 * Sorted enum literals for the tool's `runMode` field. Throws on any unexpected
 * shape rather than returning an empty list, so a schema restructure fails
 * loudly instead of letting a set comparison pass vacuously.
 */
function getRunModeOptions(inputSchema: z.ZodType): string[] {
  const fieldSchema = readZodDefinition(inputSchema).shape?.runMode;
  if (!fieldSchema) {
    throw new Error('inputSchema has no "runMode" field - has the task tool registration shape changed?');
  }
  const enumDefinition = readZodDefinition(unwrapOptionalOrNullable(fieldSchema));
  if (enumDefinition.type !== 'enum' || !enumDefinition.entries) {
    throw new Error(`Expected "runMode" to resolve to a zod enum, got def.type="${enumDefinition.type}"`);
  }
  return Object.keys(enumDefinition.entries).sort();
}

// A `Record<Union, true>` literal rather than a parallel string array, so the
// union is named in the type position and an editor flags a missing or excess
// key inline.
//
// Note what this does NOT buy: `tsconfig.json`'s `include` is
// `["src/**/*", "packages/protocol/src/**/*"]`, so `tests/**` is never compiled
// by `npm run typecheck`, and vitest's esbuild transform strips types without
// checking them. The load-bearing enforcement here is the RUNTIME set
// comparison below against the real zod enum: it catches the drift that
// actually shipped once (a zod literal that exists nowhere on the union). The
// residual gap is the mirror case - if `TaskRunMode` gained a third member and
// neither the zod enum nor this map picked it up, the sets would still match
// and these tests would pass vacuously. Closing that needs `tests/` under a
// real tsc project, which is a repo-wide change, not a per-test one.
const EXPECTED_RUN_MODES: Record<TaskRunMode, true> = {
  column_settings: true,
  agent_override: true,
};

describe('MCP runMode literal parity with the shared TaskRunMode union', () => {
  it('create_task accepts exactly the TaskRunMode union', () => {
    const server = makeServerWithTaskTools();
    const options = getRunModeOptions(server.getInputSchema('kangentic_create_task'));

    expect(new Set(options)).toEqual(new Set(Object.keys(EXPECTED_RUN_MODES)));
  });

  it('update_task uses the same enum (no second inline schema)', () => {
    const server = makeServerWithTaskTools();

    expect(getRunModeOptions(server.getInputSchema('kangentic_update_task')))
      .toEqual(getRunModeOptions(server.getInputSchema('kangentic_create_task')));
  });

  it('accepts a real mode and rejects one that exists nowhere on the union', () => {
    // Behavioral pin through the whole wire contract, so this fails the same
    // way a real MCP call would.
    const inputSchema = makeServerWithTaskTools().getInputSchema('kangentic_create_task');

    expect(inputSchema.safeParse({ title: 'T', runMode: 'agent_override' }).success).toBe(true);
    expect(inputSchema.safeParse({ title: 'T', runMode: 'column_settings' }).success).toBe(true);
    expect(inputSchema.safeParse({ title: 'T', runMode: 'override' }).success).toBe(false);
  });

  it('leaves runMode optional so existing callers keep working', () => {
    const inputSchema = makeServerWithTaskTools().getInputSchema('kangentic_create_task');

    expect(inputSchema.safeParse({ title: 'T' }).success).toBe(true);
  });
});
