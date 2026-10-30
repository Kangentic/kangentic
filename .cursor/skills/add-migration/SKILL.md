---
name: add-migration
description: Add a new database migration
---

# Add Migration

Add a new database migration to the project, following the established idempotent migration pattern.

**Usage:** `/add-migration <description>`

Example: `/add-migration Add priority column to tasks table`

**Arguments:** $ARGUMENTS

## Instructions

1. **Read current schema:**
   - Read `src/main/db/migrations/global-schema.ts` and `src/main/db/migrations/project-schema.ts` to understand existing tables, columns, and migration patterns (`src/main/db/migrations.ts` is only a 2-line re-export)
   - Identify which migration function to modify: `runGlobalMigrations()` (for `index.db`) or `runProjectMigrations()` (for per-project `<projectId>.db`)
   - Most migrations go in `runProjectMigrations()` -- global is only for the projects list

2. **Determine migration type** and apply the correct pattern:

### Column Addition
```typescript
const hasColumn = (db.pragma('table_info(table_name)') as Array<{ name: string }>)
  .some((column) => column.name === 'new_column');
if (!hasColumn) {
  db.exec('ALTER TABLE table_name ADD COLUMN new_column TEXT DEFAULT NULL');
}
```

### Table Addition
```typescript
const hasTable = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('new_table')) != null;
if (!hasTable) {
  db.exec(`CREATE TABLE new_table (
    id TEXT PRIMARY KEY,
    ...
  )`);
}
```

### Destructive Changes (column removal, type change, FK changes)
SQLite has no `ALTER TABLE DROP COLUMN` for older versions. Use table recreation:
```typescript
db.exec(`CREATE TABLE IF NOT EXISTS table_name_new (
  id TEXT PRIMARY KEY,
  ... -- new schema without the dropped column
)`);
db.exec('INSERT INTO table_name_new SELECT id, ... FROM table_name');
db.exec('DROP TABLE table_name');
db.exec('ALTER TABLE table_name_new RENAME TO table_name');
// Recreate any indexes
```

### Data Backfill
```typescript
const rows = db.prepare('SELECT id, config FROM table_name WHERE ...').all() as Array<{ id: string; config: string }>;
for (const row of rows) {
  try {
    const parsed = JSON.parse(row.config);
    // Transform data
    db.prepare('UPDATE table_name SET config = ? WHERE id = ?').run(JSON.stringify(parsed), row.id);
  } catch {
    // Skip malformed data
  }
}
```

3. **Placement rules:**
   - `runProjectMigrations()` is one unversioned function of self-guarding steps. Add a new step at its END, and give it the next number in `docs/database/migrations.md`'s "Key Migrations" list
   - Wrap multi-statement migrations that move data in `writeTransaction` (`src/main/db/transaction.ts`); `transaction-helper.test.ts` fails on a bare `.transaction(` under `src`
   - Use `db.exec()` for DDL (CREATE, ALTER, DROP)
   - Use `db.prepare().run()` for parameterized DML (INSERT, UPDATE, DELETE)

4. **Match defaults to TypeScript types:**
   - Optional fields: `DEFAULT NULL`
   - Required strings: `DEFAULT ''`
   - Required numbers: `DEFAULT 0`
   - Required booleans: `DEFAULT 0` (SQLite uses 0/1)

5. **Update TypeScript types** in `src/shared/types.ts`:
   - Add new properties to the relevant interface (e.g., `Task`, `Swimlane`, `SessionRecord`)
   - Mark optional fields with `?` if `DEFAULT NULL`

6. **Update repository** in `src/main/db/repositories/`:
   - Add the new column to SELECT queries
   - Add the new column to INSERT/UPDATE queries
   - Add any new query methods needed

7. **Run typecheck:**
   - `npm run typecheck`
   - Fix any type errors

8. **Verify with the `migration-safety` agent (fresh context):**
   - Spawn the `migration-safety` agent (read-only: `Read`, `Glob`, `Grep`) to confirm the migration is idempotent (guarded by `pragma table_info` / `sqlite_master`), that DEFAULT values align with the TypeScript types, and that repository queries cover the new column.
   - This is delegation, not forking - the skill stays in the main loop and hands only the verification pass to the auditor for an unbiased check.
   - Fix any issues the auditor reports before finishing.

9. **Remind about docs:**
   - Suggest running `/sync-docs` to update `docs/database/migrations.md` and the table concept the migration changed (`board-tables.md`, `session-tables.md` or `knowledge-graph-tables.md`)

## Checklist

Before finalizing, verify:
- [ ] Migration is idempotent (safe to run multiple times)
- [ ] `pragma table_info` or `sqlite_master` guard is present
- [ ] DEFAULT value matches TypeScript type
- [ ] Repository queries include the new column
- [ ] TypeScript types updated
- [ ] Typecheck passes

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Edit`, `Bash` (for `npm run typecheck`), and `Agent` (to spawn the `migration-safety` verification agent at the end).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`.
