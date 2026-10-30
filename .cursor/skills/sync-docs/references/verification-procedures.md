# Verification Procedures

Step-by-step extraction instructions for each anchor type. Used by the `doc-auditor` agent.

## Multi-Doc Anchors

When an anchor maps to multiple target docs, one doc is the **canonical** location (marked in the anchor table) and the others should contain only a cross-reference link. The auditor verifies the full table exists in the canonical doc and that secondary docs link to it rather than duplicating content.

## Concept Folder Targets

Every doc in `docs/` is a concept, and some anchors are split across several of them rather than
one file. A target that names a folder (`architecture/ipc/`, `integrations/mcp-server/`) or a set
of concepts means: Glob that folder's `*.md`, skip `index.md`, and read every concept the anchor
table names, or every concept whose `sources:` names the file you are checking. The per-agent
tables (Permission Modes, Command Building) live in each adapter's own concept under
`docs/integrations/agents/`, each IPC group in exactly one of the `docs/architecture/ipc/`
concepts, and each table's schema in one of the `docs/database/` table concepts. The YAML
frontmatter at the top of a concept is metadata, never part of the enumeration being compared.

## Type Union Anchors

**Applies to:** `PermissionMode`, `ActionType`, `SessionStatus`, `SessionRecordStatus`, `SwimlaneRole`, `SuspendedBy`, `ThemeMode`

1. Read `src/shared/types.ts`
2. Find the `type X =` declaration
3. Extract each `|`-separated variant (strip quotes for string literals)
4. Read the target doc file
5. Search for a table or list that enumerates these variants
6. Compare: report any variants in source but not in doc (missing) or in doc but not in source (extra)

## Object Const Anchors

**Applies to:** `EventType`, `HookEvent`, `EventTypeActivity`

1. Read `src/shared/types.ts`
2. Find the `const X = {` or `const X: Record<...> = {` declaration
3. Extract each top-level key
4. Read the target doc file
5. Search for a table or list that enumerates these keys
6. Compare: report missing and extra keys

## Config Anchors

**Applies to:** `AppConfig`, `DEFAULT_CONFIG`, `pickOverridableSubset`, `BoardConfig`, `BoardColumnConfig`

### AppConfig / DEFAULT_CONFIG
1. Read `src/shared/types.ts`
2. Find the `AppConfig` interface and `DEFAULT_CONFIG` object
3. Recursively flatten to dot-paths (e.g., `terminal.fontSize`, `board.columns`)
4. Note default values from `DEFAULT_CONFIG`
5. Read `docs/settings/app-config.md`
6. Find the config keys table
7. Compare: report missing dot-paths and any default values that differ

### BoardConfig / BoardColumnConfig
1. Read `src/shared/types.ts`
2. Find the `BoardConfig` and `BoardColumnConfig` interfaces
3. Extract each field name and type
4. Read `docs/settings/board-config.md`
5. Find the board config section
6. Compare: report missing fields

## IPC Channel Anchors

1. Read `src/shared/ipc-channels.ts`
2. Extract all string values from the `IPC` object, preserving the comment-header grouping
3. Count channels per group
4. Read `docs/architecture/ipc/board-channels.md`, `session-channels.md` and `app-channels.md`
5. Find the IPC channel tables (one section per group, each group in exactly one of the three)
6. Compare per group:
   - Missing channels (in source but not in doc table)
   - Extra channels (in doc but not in source)
   - Group count mismatches

## Database Schema Anchors

### Table Schemas
1. Read every file in `src/main/db/migrations/` (`global-schema.ts`, `project-schema.ts`, `default-data.ts`, `spawn-agent-config-migration.ts`, and any future migration file). Note: `src/main/db/migrations.ts` is only a 2-line re-export shim -- the real content lives in the directory.
2. Walk all migrations in order
3. For each `CREATE TABLE`, extract all column definitions (name, type, constraints)
4. For each `ALTER TABLE ... ADD COLUMN`, add the column to the table
5. Build cumulative schema per table
6. Read `docs/database/board-tables.md`, `session-tables.md` and `knowledge-graph-tables.md` (the
   per-project tables) and `docs/database/storage-model.md` (the global tables)
7. Find each table's schema section (one heading per table)
8. Compare: report missing columns, extra columns, type mismatches

### Seed Data
1. In the migration files (especially `default-data.ts`), find all `INSERT` statements in migration functions
2. Extract the default swimlanes (name, role, position, `is_archived`). No actions, transitions or
   automations are seeded, so there is nothing else to extract
3. Read `docs/database/storage-model.md`
4. Find the seed data section
5. Compare: report missing or changed seed entries

### Migration List
1. Count all migrations and extract their descriptions (from comments or function names)
2. Read `docs/database/migrations.md`
3. Find the migration history section
4. Compare: report missing migrations

## UI Anchors

### Settings Tabs
1. Read `src/renderer/components/settings/settings-tabs.ts`
2. Find the `SETTINGS_TABS` array definition
3. Extract each tab's label/id and note its `category` ('project' vs 'system') and `tier`
4. Read `docs/user-guide/settings.md` and `docs/settings/settings-panel.md`
5. Verify all tabs are documented and the project/shared split is described correctly
6. Compare: report missing tabs

### Settings Registry
1. Read `src/renderer/components/settings/settings-registry.ts`
2. Extract each registered setting entry (key, type, label, tab)
3. Read `docs/settings/app-config.md`
4. Find the key tables (one section per key group)
5. Compare: report missing registry entries

## Shortcut Template Variable Anchors

1. Read `src/shared/template-vars.ts`
2. Extract all exported template variable names (`{{cwd}}`, `{{branchName}}`, `{{taskTitle}}`,
   `{{projectPath}}`) and their descriptions
3. Read `docs/settings/board-config.md#shortcuts` (canonical)
4. Compare: report missing variables. `docs/architecture/automations/transition-engine.md` and `docs/integrations/agents/adapter-interface.md`
   only cross-reference this system with a link - they do not enumerate it.

## Task Template Variable Anchors (auto_command / spawn_agent promptTemplate)

1. Read `src/shared/task-template-vars.ts` (`TASK_TEMPLATE_VAR_NAMES` / `TASK_TEMPLATE_VARS`)
2. Extract every keyword name (currently 26) and their `chip`/`description` fields
3. Read `docs/architecture/automations/transition-engine.md` ("## Template Variables", canonical) and
   `docs/architecture/system-overview.md` (the "Template variables available" line, cross-reference)
4. Compare: report any chip missing from either doc, or documented with stale prose (e.g.
   describing `{{baseBranch}}` as resolving empty rather than falling back to the effective
   project default). `tests/unit/task-template-vars-parity.test.ts` runs this same check
   mechanically in CI.
