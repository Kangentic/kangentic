# Verification Procedures

Step-by-step extraction instructions for each anchor type. Used by the `doc-auditor` agent.

## Multi-Doc Anchors

When an anchor maps to multiple target docs, one doc is the **canonical** location (marked in the anchor table) and the others should contain only a cross-reference link. The auditor verifies the full table exists in the canonical doc and that secondary docs link to it rather than duplicating content.

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

**Applies to:** `AppConfig`, `DEFAULT_CONFIG`, `GLOBAL_ONLY_PATHS`, `BoardConfig`, `BoardColumnConfig`

### AppConfig / DEFAULT_CONFIG
1. Read `src/shared/types.ts`
2. Find the `AppConfig` interface and `DEFAULT_CONFIG` object
3. Recursively flatten to dot-paths (e.g., `terminal.fontSize`, `board.columns`)
4. Note default values from `DEFAULT_CONFIG`
5. Read `docs/configuration.md`
6. Find the config keys table
7. Compare: report missing dot-paths and any default values that differ

### BoardConfig / BoardColumnConfig
1. Read `src/shared/types.ts`
2. Find the `BoardConfig` and `BoardColumnConfig` interfaces
3. Extract each field name and type
4. Read `docs/configuration.md`
5. Find the board config section
6. Compare: report missing fields

## IPC Channel Anchors

1. Read `src/shared/ipc-channels.ts`
2. Extract all string values from the `IPC` object, preserving the comment-header grouping
3. Count channels per group
4. Read `docs/architecture.md`
5. Find the IPC channel tables (grouped by section)
6. Compare per group:
   - Missing channels (in source but not in doc table)
   - Extra channels (in doc but not in source)
   - Group count mismatches

## Database Schema Anchors

### Table Schemas
1. Read `src/main/db/migrations.ts`
2. Walk all migrations in order
3. For each `CREATE TABLE`, extract all column definitions (name, type, constraints)
4. For each `ALTER TABLE ... ADD COLUMN`, add the column to the table
5. Build cumulative schema per table
6. Read `docs/database.md`
7. Find each table's schema section
8. Compare: report missing columns, extra columns, type mismatches

### Seed Data
1. In the same migrations file, find all `INSERT` statements in migration functions
2. Extract default swimlanes (name, role, position), actions, and transitions
3. Read `docs/database.md`
4. Find the seed data section
5. Compare: report missing or changed seed entries

### Migration List
1. Count all migrations and extract their descriptions (from comments or function names)
2. Read `docs/database.md`
3. Find the migration history section
4. Compare: report missing migrations

## UI Anchors

### Settings Tabs
1. Read `src/renderer/components/settings/AppSettingsPanel.tsx`
2. Find the tabs array definition
3. Extract each tab's label/id and note the `separator: true` position
4. Read `docs/user-guide.md` and `docs/configuration.md`
5. Verify all tabs are documented and the project/shared split is described correctly
6. Compare: report missing tabs

### Settings Registry
1. Read `src/renderer/components/settings/settings-registry.ts`
2. Extract each registered setting entry (key, type, label, tab)
3. Read `docs/configuration.md`
4. Find the settings section
5. Compare: report missing registry entries

## Template Variable Anchors

1. Read `src/shared/template-vars.ts`
2. Extract all exported template variable names and their descriptions
3. Read `docs/transition-engine.md` and `docs/claude-integration.md`
4. Find sections documenting template variables
5. Compare: report missing variables
