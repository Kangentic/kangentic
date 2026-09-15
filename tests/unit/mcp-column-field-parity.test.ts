/**
 * MCP column-field parity: every column setting is either reachable over MCP or
 * classified as deliberately unreachable, with a reason.
 *
 * `Swimlane` gained `session_target` / `session_spawn_strategy` and they were
 * wired through the DB, the repository, `kangentic.json`, the Board Manager, the
 * strategy fold, and the Board PROFILE MCP tools - but not the column tools.
 * Asking an agent over MCP for "a Code Review column that runs /code-review"
 * therefore succeeded, reported success, and produced a column still on the
 * task's main session, so the reviewer was the agent that wrote the code.
 * Nothing failed; the tool result simply did not mention it.
 *
 * Three fields drifted this way in total, `auto_command_mode` included, because
 * nothing compared the two lists. `mcp-tool-list-parity.test.ts` checks tool
 * NAMES only, and the `board-config-parity` field classification governs
 * `kangentic.json`, not MCP. All three are exposed now, so
 * `MCP_UNEXPOSED_COLUMN_FIELDS` holds only deliberate entries.
 *
 * Two deliberate mechanism choices:
 *
 * - The field list is SCANNED out of `src/shared/types.ts` at runtime (via
 *   `helpers/shared-type-source.ts`) rather than declared here as
 *   `Record<keyof Swimlane, ...>`. `tsconfig.json` includes only `src/**` and
 *   `packages/protocol/src/**`, so `tests/` is never typechecked by
 *   `npm run typecheck` and a type-level guard in a test file fires in an editor
 *   and nowhere in CI. Same scanning approach as
 *   `column-strategy-parity.test.ts` and `spawn-entry-point-parity.test.ts`.
 * - The schema side reflects the REAL zod objects captured off a live
 *   `registerTaskTools` registration (the fake-McpServer pattern from
 *   `mcp-profile-tools-schema.test.ts`), never a re-typed copy, which would
 *   only move the drift from source into this file.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(),
  runHandler: vi.fn(),
  withProject: vi.fn(),
  appendNoticeLine: vi.fn(),
  detectCrossProjectMention: vi.fn(),
  sanitizeProjectName: vi.fn(),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { COLUMN_ENUM_FIELDS } from '../../src/main/agent/commands/column-enums';
import { readInterfaceFieldNames, readStringUnionMembers } from './helpers/shared-type-source';

/**
 * Column settings that are NOT reachable over MCP, each with the reason.
 *
 * An entry is a claim someone made on purpose. Keep it short and specific; a
 * "known gap" entry is honest and stays visible, which is the point.
 */
const MCP_UNEXPOSED_COLUMN_FIELDS: Record<string, string> = {
  is_archived:
    'Deliberate. docs/mcp-server.md states that update_column never changes a column\'s archived '
    + 'state, so editing Done cannot dislodge it from the board.',
  role:
    'Structural identity, fixed at create. SwimlaneUpdateInput omits it too - see the comment on '
    + 'SwimlaneRepository.update.',
  is_ghost:
    'Derived state (removed from config but still holding tasks), set by the config reconciler, '
    + 'never by a caller.',
  id: 'Opaque DB identity. Columns are addressed by name over MCP.',
  created_at: 'Set once at insert.',
  position:
    'Exposed on create_column only, as a zero-based ordinal slot. Re-ordering an existing board is '
    + 'a whole-board operation, not a per-column field.',
};

/**
 * Column fields whose MCP parameter name is not the plain camelCase of the
 * column name. Only one differs: the id column is addressed by column NAME.
 */
const PARAM_NAME_ALIASES: Record<string, string> = {
  plan_exit_target_id: 'planExitTargetColumn',
};

function toCamelCase(snakeCaseName: string): string {
  return snakeCaseName.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function paramNameFor(fieldName: string): string {
  return PARAM_NAME_ALIASES[fieldName] ?? toCamelCase(fieldName);
}

const readSwimlaneFieldNames = (): string[] => readInterfaceFieldNames('Swimlane');

// ---------------------------------------------------------------------------
// Fake McpServer, capturing each registerTool(...) call's inputSchema.
// ---------------------------------------------------------------------------

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
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

function registerAndCapture(): Map<string, FakeToolConfig> {
  const registeredConfigs = new Map<string, FakeToolConfig>();
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig) => {
      registeredConfigs.set(toolName, toolConfig);
    }),
  };
  registerTaskTools(server as never, {} as never, {} as never);
  return registeredConfigs;
}

function schemaShapeKeys(config: FakeToolConfig | undefined, toolName: string): string[] {
  if (!config) throw new Error(`Tool "${toolName}" was not registered`);
  const shape = readZodDefinition(config.inputSchema).shape;
  if (!shape) throw new Error(`Tool "${toolName}" has no object inputSchema shape`);
  return Object.keys(shape);
}

function enumOptionsFor(config: FakeToolConfig, fieldName: string, toolName: string): string[] {
  const fieldSchema = readZodDefinition(config.inputSchema).shape?.[fieldName];
  if (!fieldSchema) throw new Error(`${toolName} has no "${fieldName}" parameter`);
  const definition = readZodDefinition(unwrapOptionalOrNullable(fieldSchema));
  if (definition.type !== 'enum' || !definition.entries) {
    throw new Error(`Expected ${toolName}.${fieldName} to be a zod enum, got def.type="${definition.type}"`);
  }
  return Object.keys(definition.entries).sort();
}

describe('MCP column-field parity', () => {
  it('every Swimlane field is reachable over MCP or classified as unexposed', () => {
    const configs = registerAndCapture();
    const exposedParams = new Set([
      ...schemaShapeKeys(configs.get('kangentic_create_column'), 'kangentic_create_column'),
      ...schemaShapeKeys(configs.get('kangentic_update_column'), 'kangentic_update_column'),
    ]);

    const unclassified = readSwimlaneFieldNames().filter(
      (fieldName) => !exposedParams.has(paramNameFor(fieldName))
        && !(fieldName in MCP_UNEXPOSED_COLUMN_FIELDS),
    );

    expect(
      unclassified,
      'These Swimlane fields are settable in the Board Manager but unreachable over MCP, so an '
      + 'agent asked to configure a column gets a silently incomplete one:\n'
      + unclassified.map((fieldName) => `  ${fieldName} (expected param "${paramNameFor(fieldName)}")`).join('\n')
      + '\n\nFix by adding the parameter to both column schemas in task-tools.ts and parsing it in '
      + 'column-commands.ts. If it genuinely should not be settable, add it to '
      + 'MCP_UNEXPOSED_COLUMN_FIELDS with the reason.',
    ).toEqual([]);
  });

  it('every unexposed classification still names a real Swimlane field', () => {
    // Stops the list rotting into stale exemptions that pre-approve fields
    // nobody has looked at since. Mirrors column-strategy-parity's allowlist check.
    const fieldNames = new Set(readSwimlaneFieldNames());
    for (const classifiedName of Object.keys(MCP_UNEXPOSED_COLUMN_FIELDS)) {
      expect(
        fieldNames.has(classifiedName),
        `MCP_UNEXPOSED_COLUMN_FIELDS lists "${classifiedName}", which is no longer a Swimlane field - remove the entry`,
      ).toBe(true);
    }
  });

  it('the enum fields accept exactly the shared unions, on both tools', () => {
    // The literal drift that already shipped once on the profile tools:
    // sessionSpawnStrategy was declared as 'always_create', a value that exists
    // nowhere else, so the real value was rejected and the advertised one was
    // inert downstream. Read from the source unions, not a copy.
    const configs = registerAndCapture();
    for (const toolName of ['kangentic_create_column', 'kangentic_update_column']) {
      const config = configs.get(toolName);
      if (!config) throw new Error(`Tool "${toolName}" was not registered`);
      expect(enumOptionsFor(config, 'sessionTarget', toolName))
        .toEqual(readStringUnionMembers('SessionTarget'));
      expect(enumOptionsFor(config, 'sessionSpawnStrategy', toolName))
        .toEqual(readStringUnionMembers('SessionSpawnStrategy'));
      // autoCommandMode carries the same drift risk and the same consequence:
      // mapRow collapses anything that is not 'deferred' to 'immediate', so a
      // schema literal the union no longer has is accepted and then silently
      // acts as the default.
      expect(enumOptionsFor(config, 'autoCommandMode', toolName))
        .toEqual(readStringUnionMembers('AutoCommandMode'));
    }
  });

  it('COLUMN_ENUM_FIELDS lists every member of its shared union, not just valid members of it', () => {
    // The test above pins the SCHEMA literals against the source unions. It says
    // nothing about COLUMN_ENUM_FIELDS (column-enums.ts), the list the HANDLER
    // narrows against on the unvalidated mobile-bridge path - rule 3 of this
    // rule file. `VALID_SESSION_TARGETS: SessionTarget[] = ['main']` still
    // typechecks: the annotation guarantees every listed value is a real union
    // member, never that every union member is listed. A truncated list here
    // fails silently in the worst direction: the handler REJECTS a legitimate
    // value, on the one path (mobile bridge) that has no schema in front of it
    // to reject it first. It also fails invisibly to the handler's own
    // rejection-loop tests (column-commands-description.test.ts and
    // column-commands-create-session-track.test.ts): both loop
    // `Object.entries(COLUMN_ENUM_FIELDS)` and derive their expectation from the
    // very list a truncation would have already shrunk, so they stay green
    // against it.
    expect([...COLUMN_ENUM_FIELDS.permissionMode].sort())
      .toEqual(readStringUnionMembers('PermissionMode'));
    expect([...COLUMN_ENUM_FIELDS.sessionTarget].sort())
      .toEqual(readStringUnionMembers('SessionTarget'));
    expect([...COLUMN_ENUM_FIELDS.sessionSpawnStrategy].sort())
      .toEqual(readStringUnionMembers('SessionSpawnStrategy'));
    expect([...COLUMN_ENUM_FIELDS.autoCommandMode].sort())
      .toEqual(readStringUnionMembers('AutoCommandMode'));
  });

  it('the enum fields are not nullable, because their DB columns are NOT NULL', () => {
    // The clearable fields beside them use `.nullable()` to mean "clear to the
    // default". There is no such state here: going back to the default is
    // passing "main" / "create_or_resume". A nullable schema would advertise a
    // null the handler has to silently discard.
    const configs = registerAndCapture();
    for (const toolName of ['kangentic_create_column', 'kangentic_update_column']) {
      const config = configs.get(toolName);
      if (!config) throw new Error(`Tool "${toolName}" was not registered`);
      const shape = readZodDefinition(config.inputSchema).shape;
      for (const fieldName of ['sessionTarget', 'sessionSpawnStrategy', 'autoCommandMode']) {
        const fieldSchema = shape?.[fieldName];
        if (!fieldSchema) throw new Error(`${toolName} has no "${fieldName}" parameter`);
        // `.optional()` is expected and unwrapped; a `nullable` anywhere in the
        // chain is what this rejects.
        let currentSchema = fieldSchema;
        for (;;) {
          const definition = readZodDefinition(currentSchema);
          expect(
            definition.type,
            `${toolName}.${fieldName} must not be nullable - the DB column is NOT NULL`,
          ).not.toBe('nullable');
          if (definition.type === 'optional' && definition.innerType) {
            currentSchema = definition.innerType;
            continue;
          }
          break;
        }
      }
    }
  });
});
