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
  2. serialized in **`src/main/config/board-config/build-config.ts`** (DB->JSON), with default-omission like its siblings (`if (lane.x !== default) column.x = ...`) in `serializeColumn`, and read back with no omission in `COLUMN_FIELD_VALUE_READERS`, which is how an edit to a field a `kangentic.local.json` entry sets is saved to that file,
  3. applied in **`src/main/config/board-config/apply-config.ts`** (JSON->DB) in BOTH the `create` and `update` calls, with the `(isTodo || isDone) ? <default> : (columnConfig.x ?? kept('x', existing.x))` guard, its default declared once in `COLUMN_FIELD_DEFAULTS` (`column-field-defaults.ts`) so a key removed from the local file resets to it. A field that gets an `(isTodo || isDone)` guard also joins `ROLE_PINNED_FIELDS` in `build-config.ts`, so its value is not read back from a To Do or Done lane.
- **db-only** (identity / ordering / runtime state / timestamp - `id`, `position`, `is_ghost`, `created_at`): no board-config wiring; it is intentionally per-machine.

The per-column merge in `config-helpers.ts` (`{ ...team, ...local }`) propagates any new `BoardColumnConfig` key automatically - you do not touch the merge.

### File format version

A build that reads a file it cannot fully read must never write it back. On 2026-11-12 the file moved from `finalLine` to `condition.text` with `version` still at 1. A running older build read every `condition.text` as noise, ran guarded moves unguarded for four days, and exported the stripped file.

- **Any change to what the export can write bumps `CURRENT_VERSION`** (`config-helpers.ts`) and records a NEW signature in `tests/unit/helpers/board-config-format-history.ts`. Never edit a shipped entry. A new column field, a new manifest field, and a new Condition shape all count.
- **A key the new format replaces joins `LEGACY_FILE_KEYS`** with the old version as its `lastVersion`. Readers ask `legacyKeyReadable` and never hard-code a version. A retired key is never silently ignored: a retired guard keeps its column's automations, and every retired key warns.
- **The open-time export migrates the file to the newest format.** It writes no legacy key and stamps `CURRENT_VERSION`.
- **A newer file is applied but never written.** `readProblem` marks it `newerFormat`, so the write-back skips it and every settings save to it refuses. A row of a known type with a key this build does not know keeps its column's automations.
- **A guard the reader cannot read keeps the column** (`keepExisting`), and the write-back refuses the file while any column does (`fileHoldsUnreadableAutomations`). Never plan a row without a guard the file gave it.

## Enforcement (self-maintaining)

- **Test (mechanical, CI):** `tests/unit/board-config-parity.test.ts` declares `SWIMLANE_FIELD_SHARING` and fails when it does not classify exactly the fields the `Swimlane` interface declares, reading them out of `src/shared/types.ts` at runtime (`tests/unit/helpers/shared-type-source.ts`). Classifying a field `'team'` then requires a `ROUNDTRIP_CASES` entry (or `STRUCTURAL_TEAM_FIELDS`), whose build/apply assertions fail until the field is actually wired, and the same file fails a team field with no `COLUMN_FIELD_VALUE_READERS` entry. Runs in CI via `npm run test:unit`.
- **Type system:** `kept()` takes only a `COLUMN_FIELD_DEFAULTS` key, so an update that resets through it without a default fails `npm run typecheck`. `ROLE_PINNED_FIELDS` matching the apply guards is review-only.

  The map also carries a `Record<keyof Swimlane, 'team' | 'db-only'>` annotation, and until 2026-09-15 this section claimed that annotation made `npm run typecheck` fail on an unclassified field. It never did in CI: `tsconfig.json` includes only `src/**` and `packages/protocol/src/**`, so tsc never reads `tests/unit/`. The annotation is an editor aid; the runtime test is the guarantee. Do not replace it with a type-level check.
- **Test (file format):** `tests/unit/board-config-format-version.test.ts` serializes a board with every key set from a real database and fails when its shape differs from the signature recorded for `CURRENT_VERSION`. Its coverage checks fail when the fixture stops setting a `BoardColumnConfig` key, a `BoardConfig` key, a manifest field, or a Condition variant, so a new key cannot pass by never being written. It also fails when the export writes a `LEGACY_FILE_KEYS` key or the registry gains an entry with no check. `board-config-write-refusal-edges.test.ts` pins that a newer file and a file with an unreadable guard are left byte-identical. Runs in CI via `npm run test:unit`.
- **Review:** the `migration-safety` agent (`.claude/agents/migration-safety.md`, check #7) flags an unsynced new column field during `/code-review`.

Do not weaken these by classifying a real team setting as `'db-only'` to silence the test - that reintroduces the gap.

## Scope

This rule covers **column-level** (swimlane) settings only. App/machine settings (idle timeout, max concurrent sessions, CLI paths, theme, notifications, ...) are intentionally user/global scoped and live in the app config, not `kangentic.json`. Actions and transitions already round-trip (JSON passthrough / name resolution) and are not subject to this field-level gap.
