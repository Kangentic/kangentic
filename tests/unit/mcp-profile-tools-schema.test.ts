/**
 * MCP Board Profile tools: PROFILE_ENTRY_SCHEMA literal parity with the shared
 * strategy union types (src/shared/types.ts).
 *
 * `PROFILE_ENTRY_SCHEMA` (profile-tools.ts) is a module-private const, so this
 * test reflects on the ACTUAL zod schema objects captured off a real
 * `registerProfileTools` registration (via a fake McpServer - the same
 * capture pattern `mcp-task-session-tools.test.ts` uses) rather than
 * re-declaring the accepted literals as a second hardcoded string list, which
 * would just move the drift risk from source to test.
 *
 * Regression this pins: `sessionSpawnStrategy` was declared as
 * `z.enum(['create_or_resume', 'always_create'])`, but the shared
 * `SessionSpawnStrategy` union is `'create_or_resume' | 'always_spawn_new'` -
 * `'always_create'` exists nowhere else in the codebase. An agent sending the
 * REAL value `'always_spawn_new'` was rejected by zod validation; an agent
 * sending the schema's own advertised `'always_create'` was accepted and
 * persisted but is inert downstream
 * (session-isolation.ts only tests `spawnStrategy === 'always_spawn_new'`).
 *
 * `handler-helpers` is mocked before importing profile-tools.ts because it
 * pulls in `../commands` -> better-sqlite3, which this unit test does not
 * need: `registerTool` only ever STORES the config here, it never invokes a
 * handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';
import type { SessionSpawnStrategy, SessionTarget } from '../../src/shared/types';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(),
  runHandler: vi.fn(),
  withProject: vi.fn(),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerProfileTools } from '../../src/main/agent/mcp-http/profile-tools';

// ---------------------------------------------------------------------------
// Fake McpServer: captures each registerTool(...) call's inputSchema so the
// test can reflect on the REAL zod schema object built by production code,
// never a re-typed copy of it.
// ---------------------------------------------------------------------------

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
}

function makeFakeServer() {
  const registeredConfigs = new Map<string, FakeToolConfig>();
  return {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig) => {
      registeredConfigs.set(toolName, toolConfig);
    }),
    getInputSchema(toolName: string): z.ZodType {
      const toolConfig = registeredConfigs.get(toolName);
      if (!toolConfig) throw new Error(`Tool "${toolName}" was not registered`);
      return toolConfig.inputSchema;
    },
  };
}

function makeServerWithProfileTools() {
  const server = makeFakeServer();
  registerProfileTools(server as never, {} as never);
  return server;
}

// ---------------------------------------------------------------------------
// Minimal zod-v4 internal-definition reflection: enough to walk
// object -> optional/nullable* -> record -> object -> optional/nullable* -> enum,
// the exact shape `columns: z.record(z.string(), PROFILE_ENTRY_SCHEMA)`
// produces. Every step throws on an unexpected shape rather than returning an
// empty list, so a future schema restructure fails loudly instead of letting
// a `for (const option of [])` comparison pass vacuously.
// ---------------------------------------------------------------------------

interface ZodInternalDefinition {
  type: string;
  innerType?: z.ZodType;
  valueType?: z.ZodType;
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

/** The per-column entry schema (`PROFILE_ENTRY_SCHEMA`) nested inside `columns`. */
function getColumnEntrySchema(inputSchema: z.ZodType): z.ZodType {
  const columnsFieldSchema = readZodDefinition(inputSchema).shape?.columns;
  if (!columnsFieldSchema) {
    throw new Error('inputSchema has no "columns" field - has the Board Profile tool registration shape changed?');
  }
  const recordSchema = unwrapOptionalOrNullable(columnsFieldSchema);
  const recordDefinition = readZodDefinition(recordSchema);
  if (recordDefinition.type !== 'record' || !recordDefinition.valueType) {
    throw new Error(`Expected "columns" to resolve to a zod record, got def.type="${recordDefinition.type}"`);
  }
  return recordDefinition.valueType;
}

/** Sorted enum option literals for one PROFILE_ENTRY_SCHEMA field. */
function getProfileEntryEnumOptions(inputSchema: z.ZodType, fieldName: string): string[] {
  const entryDefinition = readZodDefinition(getColumnEntrySchema(inputSchema));
  const fieldSchema = entryDefinition.shape?.[fieldName];
  if (!fieldSchema) {
    throw new Error(`PROFILE_ENTRY_SCHEMA has no field "${fieldName}"`);
  }
  const enumSchema = unwrapOptionalOrNullable(fieldSchema);
  const enumDefinition = readZodDefinition(enumSchema);
  if (enumDefinition.type !== 'enum' || !enumDefinition.entries) {
    throw new Error(`Expected field "${fieldName}" to resolve to a zod enum, got def.type="${enumDefinition.type}"`);
  }
  return Object.keys(enumDefinition.entries).sort();
}

// ---------------------------------------------------------------------------
// Single source of truth for the expected literals: a `Record<Union, true>`
// object literal. If `SessionSpawnStrategy` (or `SessionTarget`) ever gains,
// loses, or renames a member, this object fails `npm run typecheck` (missing
// key or excess property) instead of relying on someone remembering to keep a
// parallel string array in sync.
// ---------------------------------------------------------------------------

const EXPECTED_SESSION_SPAWN_STRATEGIES: Record<SessionSpawnStrategy, true> = {
  create_or_resume: true,
  always_spawn_new: true,
};

const EXPECTED_SESSION_TARGETS: Record<SessionTarget, true> = {
  main: true,
  isolated: true,
};

describe('PROFILE_ENTRY_SCHEMA literal parity with the shared strategy types', () => {
  it('sessionSpawnStrategy accepts exactly the SessionSpawnStrategy union on create_board_profile', () => {
    const server = makeServerWithProfileTools();
    const options = getProfileEntryEnumOptions(
      server.getInputSchema('kangentic_create_board_profile'),
      'sessionSpawnStrategy',
    );
    expect(new Set(options)).toEqual(new Set(Object.keys(EXPECTED_SESSION_SPAWN_STRATEGIES)));
  });

  it('sessionSpawnStrategy is the same enum on update_board_profile (no second inline schema)', () => {
    const server = makeServerWithProfileTools();
    const createOptions = getProfileEntryEnumOptions(
      server.getInputSchema('kangentic_create_board_profile'),
      'sessionSpawnStrategy',
    );
    const updateOptions = getProfileEntryEnumOptions(
      server.getInputSchema('kangentic_update_board_profile'),
      'sessionSpawnStrategy',
    );
    expect(updateOptions).toEqual(createOptions);
  });

  it('sessionTarget accepts exactly the SessionTarget union', () => {
    const server = makeServerWithProfileTools();
    const options = getProfileEntryEnumOptions(
      server.getInputSchema('kangentic_create_board_profile'),
      'sessionTarget',
    );
    expect(new Set(options)).toEqual(new Set(Object.keys(EXPECTED_SESSION_TARGETS)));
  });

  // Behavioral pin through the WHOLE wire contract (the record and
  // optional/nullable wrapping included), not just the extracted enum, so
  // this fails the same way a real MCP call would if the schema drifts again.
  it('accepts the real value and rejects the historical wrong literal end-to-end', () => {
    const server = makeServerWithProfileTools();
    const inputSchema = server.getInputSchema('kangentic_create_board_profile');

    expect(inputSchema.safeParse({
      name: 'Heavy',
      columns: { Planning: { sessionSpawnStrategy: 'always_spawn_new' } },
    }).success).toBe(true);

    // 'always_create' was the schema's original (wrong) literal: it does not
    // exist on SessionSpawnStrategy and is inert downstream even though zod
    // used to accept it.
    expect(inputSchema.safeParse({
      name: 'Heavy',
      columns: { Planning: { sessionSpawnStrategy: 'always_create' } },
    }).success).toBe(false);
  });
});
