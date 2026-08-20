import type Database from 'better-sqlite3';

export function runGlobalMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      github_url TEXT,
      default_agent TEXT NOT NULL DEFAULT 'claude',
      last_opened TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: create project_groups table
  const hasGroupsTable = (db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='project_groups'"
  ).get() as { c: number }).c > 0;
  if (!hasGroupsTable) {
    db.exec(`
      CREATE TABLE project_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        is_collapsed INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  // Migration: add 'group_id' column to projects for group assignment
  const hasGroupIdColumn = (db.pragma('table_info(projects)') as Array<{ name: string }>)
    .some((col) => col.name === 'group_id');
  if (!hasGroupIdColumn) {
    db.exec('ALTER TABLE projects ADD COLUMN group_id TEXT DEFAULT NULL');
  }

  // Migration: add 'position' column for explicit project ordering
  const hasPositionColumn = (db.pragma('table_info(projects)') as Array<{ name: string }>)
    .some((col) => col.name === 'position');
  if (!hasPositionColumn) {
    db.exec('ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    // Backfill: assign positions based on current last_opened DESC order (preserves visual order)
    const rows = db.prepare('SELECT id FROM projects ORDER BY last_opened DESC').all() as Array<{ id: string }>;
    const stmt = db.prepare('UPDATE projects SET position = ? WHERE id = ?');
    rows.forEach((row, index) => {
      stmt.run(index, row.id);
    });
  }

  // Migration: add 'default_model' / 'default_effort' columns for project-level
  // model/effort defaults (sibling to default_agent). Nullable - unlike
  // default_agent, NULL is a valid "no project preference" state that falls
  // through to the agent CLI's own default.
  const projectColumns = db.pragma('table_info(projects)') as Array<{ name: string }>;
  if (!projectColumns.some((col) => col.name === 'default_model')) {
    db.exec('ALTER TABLE projects ADD COLUMN default_model TEXT DEFAULT NULL');
  }
  if (!projectColumns.some((col) => col.name === 'default_effort')) {
    db.exec('ALTER TABLE projects ADD COLUMN default_effort TEXT DEFAULT NULL');
  }

  // Migration: dev-server port leases.
  //
  // GLOBAL rather than per-project on purpose: ports are a machine-wide
  // resource, so two projects both defaulting to 5173 is exactly the collision
  // a per-project table could not see. Deliberately NOT stored in the
  // worktree's `.kangentic/`, which is wiped when a preview exits.
  //
  // Keyed on task_id, never worktree_path: a Done round-trip nulls
  // `worktree_path` and removes the directory, so a path-keyed lease would
  // orphan on every round trip and slowly eat the range.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_ports (
      port INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      allocated_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_ports_task ON dev_ports(task_id);
    CREATE INDEX IF NOT EXISTS idx_dev_ports_project ON dev_ports(project_id);
  `);
}
