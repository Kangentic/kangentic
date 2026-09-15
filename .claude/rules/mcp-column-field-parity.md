---
paths:
  - "src/main/agent/mcp-http/task-tools.ts"
  - "src/main/agent/commands/column-commands.ts"
  - "src/shared/types.ts"
---
# Rule: a column setting is reachable over MCP, or classified as not

A column's settings are authored from two places: the Board Manager, and the MCP column tools an
agent drives. Nothing compared the two lists, so fields landed in the UI and never reached MCP.
Three did. `session_target` and `session_spawn_strategy` were wired through the DB, the repository,
`kangentic.json`, the strategy fold, and even the Board PROFILE MCP tools, but not the column tools;
`auto_command_mode` is still out of both.

The failure is silent and it is the worst shape. Ask an agent over MCP to "set up a Code Review
column that runs /code-review" and it succeeds, reports success, and produces a column still on the
task's main session. The review then runs on the task's own conversation, so the reviewer is the
agent that just wrote the code, which is what isolated sessions exist to prevent. Nothing errors,
and before this rule `kangentic_get_column_detail` did not print the field either, so the agent
could not have checked.

## The rule

When you add a field to the `Swimlane` interface, decide whether an agent may set it, and make that
decision visible:

1. **Reachable:** add the parameter to BOTH column schemas in
   `src/main/agent/mcp-http/task-tools.ts`, forward it in both destructures, and parse it in
   `handleCreateColumn` and `handleUpdateColumn` (`src/main/agent/commands/column-commands.ts`).
   The MCP parameter name is the plain camelCase of the column name unless the field is addressed
   differently (`plan_exit_target_id` is set by column NAME, as `planExitTargetColumn`).
2. **Not reachable:** add it to `MCP_UNEXPOSED_COLUMN_FIELDS` in
   `tests/unit/mcp-column-field-parity.test.ts` with the reason. "Known gap, not a decision" is a
   legitimate entry and is better than silence, because it stays in front of the next reader.
3. **Parse in the HANDLER, not only in zod.** The mobile bridge routes `update_column` straight into
   `commandHandlers` and `board-tool.ts` validates only that `params` is an object, so the zod
   schema is not in that path. An enum field validates against its literal set in the handler and
   returns a `Valid values: ...` error; neither session column has a CHECK constraint and `mapRow`
   asserts rather than narrows, so an unvalidated value would persist and read back as a member of
   the union.
4. **A settable field is readable.** `kangentic_get_column_detail` documents itself as the
   read-before-write call, so anything `update_column` writes appears in its output. A field whose
   default is a real value (not an absent override) prints unconditionally: hiding it leaves a
   caller unable to tell a default from a write that did not take.
5. **Do not re-implement a pairing rule the UI already has.** `snapSpawnStrategyToTarget`
   (`src/shared/session-track.ts`) is shared by the Column Manager and the MCP handlers precisely
   so an agent-created column and a hand-made one cannot differ.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/mcp-column-field-parity.test.ts` scans the `Swimlane` interface out of
  `src/shared/types.ts` and fails on any field that is neither a parameter of the two column schemas
  nor classified in `MCP_UNEXPOSED_COLUMN_FIELDS`. It reflects the REAL zod objects captured off a
  live `registerTaskTools` registration rather than a re-typed copy, pins both session enums against
  the shared unions, and pins that neither is nullable (both DB columns are NOT NULL). A companion
  assertion fails when a classification names a field that no longer exists, so the list cannot rot
  into stale exemptions. Runs in CI via `npm run test:unit`.

  The field list is scanned at runtime rather than declared as `Record<keyof Swimlane, ...>` on
  purpose. `tsconfig.json` includes only `src/**` and `packages/protocol/src/**`, so `tests/` is
  never typechecked by `npm run typecheck` and a type-level guard in a test file fires in an editor
  and nowhere in CI.
- **Review:** `/code-review` flags a new column field wired to the Board Manager but not to MCP.

This is column-field parity only. Tool-NAME parity with the settings panel and the docs is
[[mcp-tool-list-parity]], and `kangentic.json` round-trip classification is
[[board-config-parity]]. The three are separate lists and a field can satisfy one and fail another,
which is how these drifted.

## Scope

The `Swimlane` field set and the two MCP column tools. Does not govern the Board Profile tools
(`profile-tools.ts`), whose entry schema is a deliberate subset: a profile re-points per-column
STRATEGY, never column identity.
