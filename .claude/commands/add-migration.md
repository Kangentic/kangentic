---
description: Add a new database migration
allowed-tools: Read, Glob, Grep, Edit, Bash(npm:*)
argument-hint: <description>
---

# Add Migration

Add a new database migration to the project, following the established idempotent migration pattern.

**Usage:** `/add-migration <description>`

Example: `/add-migration Add priority column to tasks table`

**Arguments:** $ARGUMENTS

## Instructions

1. **Read current schema:**
   - Read `src/main/db/migrations.ts` to understand existing tables, columns, and migration patterns
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
   - Add new migrations AFTER seed logic guards but BEFORE seed `INSERT` statements
   - Wrap multi-statement migrations in transactions if they involve data movement
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

8. **Remind about docs:**
   - Suggest running `/update-docs` to update `docs/database.md`

## Checklist

Before finalizing, verify:
- [ ] Migration is idempotent (safe to run multiple times)
- [ ] `pragma table_info` or `sqlite_master` guard is present
- [ ] DEFAULT value matches TypeScript type
- [ ] Repository queries include the new column
- [ ] TypeScript types updated
- [ ] Typecheck passes

## Allowed Tools

Use `Read`, `Glob`, `Grep`, `Edit`, `Bash` (for `npm run typecheck`).

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use `&&`, `||`, `|`, or `;`.
