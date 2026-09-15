---
paths:
  - "src/shared/types.ts"
  - "src/main/config/board-config/**"
---
# Rule: board-config parity for swimlane (column) fields

Team board state is shared through `kangentic.json` (committed) + `kangentic.local.json` (gitignored local override). These do NOT mirror the `swimlanes` row - they serialize a **curated** `BoardColumnConfig`. A column field that exists in the DB/UI but isn't wired into that round-trip persists only to the per-machine project DB and never reaches teammates.

This actually shipped as a bug: `session_target` / `session_spawn_strategy` were wired through the DB, repo, UI, and engine but not the board config, so a committed Code Review column carried its team-shared `auto_command: /code-review` **without** its `isolated` + `always_spawn_new` companions - teammates ran the review in their main session, the exact thing the feature prevents.

## The rule

When you add or change a `swimlanes` column (a field on the `Swimlane` interface in `src/shared/types.ts`), decide its sharing and wire it accordingly:

- **team-shared** (a setting a team should share - color, automation, agent/model/effort overrides, permission mode, session target/spawn, ...): it MUST round-trip end to end -
  1. a camelCase key on **`BoardColumnConfig`** (`src/shared/types.ts`),
  2. serialized in **`src/main/config/board-config/build-config.ts`** (DB->JSON), with default-omission like its siblings (`if (lane.x !== default) column.x = ...`),
  3. applied in **`src/main/config/board-config/apply-config.ts`** (JSON->DB) in BOTH the `create` and `update` calls, with the `(isTodo || isDone) ? <default> : (columnConfig.x ?? existing.x)` guard.
- **db-only** (identity / ordering / runtime state / timestamp - `id`, `position`, `is_ghost`, `created_at`): no board-config wiring; it is intentionally per-machine.

The per-column merge in `config-helpers.ts` (`{ ...team, ...local }`) propagates any new `BoardColumnConfig` key automatically - you do not touch the merge.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/board-config-parity.test.ts` declares `SWIMLANE_FIELD_SHARING` and fails when it does not classify exactly the fields the `Swimlane` interface declares, reading them out of `src/shared/types.ts` at runtime (`tests/unit/helpers/shared-type-source.ts`). Classifying a field `'team'` then requires a `ROUNDTRIP_CASES` entry (or `STRUCTURAL_TEAM_FIELDS`), whose build/apply assertions fail until the field is actually wired. Runs in CI via `npm run test:unit`.

  The map also carries a `Record<keyof Swimlane, 'team' | 'db-only'>` annotation, and until 2026-09-15 this section claimed that annotation made `npm run typecheck` fail on an unclassified field. It never did in CI: `tsconfig.json` includes only `src/**` and `packages/protocol/src/**`, so tsc never reads `tests/`. The annotation is an editor aid; the runtime test is the guarantee. Do not replace it with a type-level check.
- **Review:** the `migration-safety` agent (`.claude/agents/migration-safety.md`, check #7) flags an unsynced new column field during `/code-review`.

Do not weaken these by classifying a real team setting as `'db-only'` to silence the test - that reintroduces the gap.

## Scope

This rule covers **column-level** (swimlane) settings only. App/machine settings (idle timeout, max concurrent sessions, CLI paths, theme, notifications, ...) are intentionally user/global scoped and live in the app config, not `kangentic.json`. Actions and transitions already round-trip (JSON passthrough / name resolution) and are not subject to this field-level gap.
