import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

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

}

export function runProjectMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swimlanes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      position INTEGER NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      icon TEXT DEFAULT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      permission_strategy TEXT DEFAULT NULL,
      auto_spawn INTEGER NOT NULL DEFAULT 1,
      auto_command TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
      position INTEGER NOT NULL,
      agent TEXT,
      session_id TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_swimlane_position ON tasks(swimlane_id, position);

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swimlane_transitions (
      id TEXT PRIMARY KEY,
      from_swimlane_id TEXT NOT NULL,
      to_swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
      action_id TEXT NOT NULL REFERENCES actions(id),
      execution_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_transitions_from_to ON swimlane_transitions(from_swimlane_id, to_swimlane_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      session_type TEXT NOT NULL,
      claude_session_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      permission_mode TEXT,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      suspended_at TEXT,
      exited_at TEXT
    );
  `);

  // Migration: add 'role' column for existing databases
  const hasRoleColumn = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>).some((col) => col.name === 'role');
  if (!hasRoleColumn) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN role TEXT');
    // Backfill roles for the default seed columns by position
    const lanes = db.prepare('SELECT id, position, is_archived FROM swimlanes ORDER BY position ASC').all() as Array<{ id: string; position: number; is_archived: number }>;
    const roleMap: Record<number, string> = { 0: 'backlog', 1: 'planning', 2: 'running' };
    for (const lane of lanes) {
      const role = lane.is_archived ? 'done' : roleMap[lane.position] || null;
      if (role) {
        db.prepare('UPDATE swimlanes SET role = ? WHERE id = ?').run(role, lane.id);
      }
    }
  }

  // Migration: add 'icon' column for custom swimlane icons
  const hasIconColumn = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>).some((col) => col.name === 'icon');
  if (!hasIconColumn) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN icon TEXT DEFAULT NULL');
  }

  // Migration: add 'archived_at' column for the Done auto-archive feature
  const hasArchivedAtColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === 'archived_at');
  if (!hasArchivedAtColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT DEFAULT NULL');
  }

  // Migration: add 'base_branch' column for per-task base branch override
  const hasBaseBranchColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'base_branch');
  if (!hasBaseBranchColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN base_branch TEXT DEFAULT NULL');
  }

  // Migration: add 'use_worktree' column for per-task worktree override
  const hasUseWorktreeColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'use_worktree');
  if (!hasUseWorktreeColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN use_worktree INTEGER DEFAULT NULL');
  }

  // Migration: drop FK on from_swimlane_id to allow wildcard '*' source.
  // SQLite requires table recreation to remove a constraint.
  const fkInfo = db.prepare("PRAGMA foreign_key_list('swimlane_transitions')").all() as Array<{ from: string; table: string }>;
  const hasFkOnFrom = fkInfo.some((fk) => fk.from === 'from_swimlane_id' && fk.table === 'swimlanes');
  if (hasFkOnFrom) {
    db.exec(`
      CREATE TABLE swimlane_transitions_new (
        id TEXT PRIMARY KEY,
        from_swimlane_id TEXT NOT NULL,
        to_swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
        action_id TEXT NOT NULL REFERENCES actions(id),
        execution_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO swimlane_transitions_new SELECT * FROM swimlane_transitions;
      DROP TABLE swimlane_transitions;
      ALTER TABLE swimlane_transitions_new RENAME TO swimlane_transitions;
      CREATE INDEX IF NOT EXISTS idx_transitions_from_to ON swimlane_transitions(from_swimlane_id, to_swimlane_id);
    `);
  }

  // Data migration: convert explicit per-source transitions to wildcard '*' source.
  // This ensures actions fire when moving from ANY column into the target, not just
  // from specific columns (e.g. Backlog → Planning becomes * → Planning).
  const hasWildcard = db.prepare(
    "SELECT COUNT(*) as c FROM swimlane_transitions WHERE from_swimlane_id = '*'"
  ).get() as { c: number };

  if (hasWildcard.c === 0) {
    // Group existing transitions by target swimlane + action, keeping the lowest execution_order
    const existing = db.prepare(
      'SELECT DISTINCT to_swimlane_id, action_id, MIN(execution_order) as execution_order FROM swimlane_transitions GROUP BY to_swimlane_id, action_id ORDER BY to_swimlane_id, execution_order'
    ).all() as Array<{ to_swimlane_id: string; action_id: string; execution_order: number }>;

    if (existing.length > 0) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM swimlane_transitions').run();
        const insert = db.prepare(
          'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)'
        );
        for (const row of existing) {
          insert.run(uuidv4(), '*', row.to_swimlane_id, row.action_id, row.execution_order);
        }
      });
      tx();
    }
  }

  // Migration: create task_attachments table for image/file attachments
  const hasAttachmentsTable = (db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='task_attachments'"
  ).get() as { c: number }).c > 0;
  if (!hasAttachmentsTable) {
    db.exec(`
      CREATE TABLE task_attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_task_attachments_task_id ON task_attachments(task_id);
    `);
  }

  // Data migrations for spawn_agent actions (single pass):
  //  1. Append {{attachments}} to promptTemplates that lack it
  //  2. Remove legacy permission mode values (fall through to app default)
  //  3. Update old 'Task: {{title}}...' template to '{{title}}{{description}}{{attachments}}'
  const spawnActions = db.prepare(
    "SELECT id, config_json FROM actions WHERE type = 'spawn_agent'"
  ).all() as Array<{ id: string; config_json: string }>;

  for (const action of spawnActions) {
    try {
      const config = JSON.parse(action.config_json);
      let changed = false;

      // 1. Append {{attachments}} if missing
      if (config.promptTemplate && !config.promptTemplate.includes('{{attachments}}')) {
        config.promptTemplate = config.promptTemplate + '{{attachments}}';
        changed = true;
      }

      // 2. Remove legacy permission modes
      if (config.permissionMode === 'dangerously-skip' || config.permissionMode === 'bypass-permissions') {
        delete config.permissionMode;
        changed = true;
      }

      // 3. Update old 'Task: {{title}}...' prompt template
      if (config.promptTemplate && config.promptTemplate.includes('Task: {{title}}')) {
        config.promptTemplate = '{{title}}{{description}}{{attachments}}';
        changed = true;
      }

      if (changed) {
        db.prepare('UPDATE actions SET config_json = ? WHERE id = ?')
          .run(JSON.stringify(config), action.id);
      }
    } catch { /* skip malformed config */ }
  }

  // Migration: add permission_strategy and auto_spawn columns to swimlanes
  const hasPermissionStrategy = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'permission_strategy');
  if (!hasPermissionStrategy) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN permission_strategy TEXT DEFAULT NULL');
    db.exec('ALTER TABLE swimlanes ADD COLUMN auto_spawn INTEGER NOT NULL DEFAULT 1');
    // Backfill: backlog/done columns don't auto-spawn; planning uses plan mode
    db.exec("UPDATE swimlanes SET auto_spawn = 0 WHERE role IN ('backlog', 'done')");
    db.exec("UPDATE swimlanes SET permission_strategy = 'plan' WHERE role = 'planning'");
    // Convert running role to custom column (no longer a system role)
    db.exec("UPDATE swimlanes SET role = NULL WHERE role = 'running'");
  }

  // Migration: add auto_command column to swimlanes
  const hasAutoCommand = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'auto_command');
  if (!hasAutoCommand) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN auto_command TEXT DEFAULT NULL');
  }

  // Migration: rename is_terminal → is_archived
  const hasIsTerminal = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'is_terminal');
  if (hasIsTerminal) {
    db.exec('ALTER TABLE swimlanes RENAME COLUMN is_terminal TO is_archived');
  }

  // Migration: add plan_exit_target_id column and remove planning system role
  const hasPlanExitTargetId = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'plan_exit_target_id');
  if (!hasPlanExitTargetId) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN plan_exit_target_id TEXT DEFAULT NULL');
    // Ensure icon is explicit on any planning-role column before removing the role
    db.exec("UPDATE swimlanes SET icon = 'map' WHERE role = 'planning' AND icon IS NULL");
    // Remove planning role -- it becomes a regular column with permission_strategy='plan'
    db.exec("UPDATE swimlanes SET role = NULL WHERE role = 'planning'");
    // Auto-set plan_exit_target_id for plan-mode columns to the next column by position
    // Uses > + ORDER BY ASC instead of = position+1 for gap-safe lookup
    db.exec(`
      UPDATE swimlanes SET plan_exit_target_id = (
        SELECT s2.id FROM swimlanes s2
        WHERE s2.position > (
          SELECT s3.position FROM swimlanes s3 WHERE s3.id = swimlanes.id
        ) AND s2.role IS NULL
        ORDER BY s2.position ASC
        LIMIT 1
      ) WHERE permission_strategy = 'plan' AND plan_exit_target_id IS NULL
    `);
  }

  // Data migration: rename legacy permission_strategy values in swimlanes
  db.prepare("UPDATE swimlanes SET permission_strategy = 'default' WHERE permission_strategy = 'project-settings'").run();
  db.prepare("UPDATE swimlanes SET permission_strategy = 'bypass-permissions' WHERE permission_strategy = 'dangerously-skip'").run();

  // Seed default swimlanes if empty (must run after all ALTER TABLE migrations)
  const laneCount = db.prepare('SELECT COUNT(*) as c FROM swimlanes').get() as { c: number };
  if (laneCount.c === 0) {
    const now = new Date().toISOString();
    const insertLane = db.prepare(
      'INSERT INTO swimlanes (id, name, role, position, color, icon, is_archived, permission_strategy, auto_spawn, auto_command, plan_exit_target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const defaults = [
      { name: 'Backlog', role: 'backlog', color: '#6b7280', icon: 'layers', archived: 0, permission_strategy: null, auto_spawn: 0, auto_command: null },
      { name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', archived: 0, permission_strategy: 'plan', auto_spawn: 1, auto_command: null },
      { name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', archived: 0, permission_strategy: null, auto_spawn: 1, auto_command: null },
      { name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', archived: 0, permission_strategy: null, auto_spawn: 1, auto_command: null },
      { name: 'Tests', role: null, color: '#06b6d4', icon: 'flask-conical', archived: 0, permission_strategy: null, auto_spawn: 1, auto_command: null },
      { name: 'Ship It', role: null, color: '#F97316', icon: 'sailboat', archived: 0, permission_strategy: null, auto_spawn: 1, auto_command: null },
      { name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', archived: 1, permission_strategy: null, auto_spawn: 0, auto_command: null },
    ];

    const tx = db.transaction(() => {
      const laneIds: string[] = [];
      defaults.forEach((lane, i) => {
        const id = uuidv4();
        laneIds.push(id);
        insertLane.run(id, lane.name, lane.role, i, lane.color, lane.icon, lane.archived, lane.permission_strategy, lane.auto_spawn, lane.auto_command, null, now);
      });

      // Set Planning's plan_exit_target_id to Executing (index 1 → index 2)
      db.prepare('UPDATE swimlanes SET plan_exit_target_id = ? WHERE id = ?').run(laneIds[2], laneIds[1]);

      // Seed default actions and transitions
      seedActionsAndTransitions(db, now);
    });
    tx();
  }

  // For existing projects: seed default actions if the actions table is empty
  const actionCount = db.prepare('SELECT COUNT(*) as c FROM actions').get() as { c: number };
  if (actionCount.c === 0 && laneCount.c > 0) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      seedActionsAndTransitions(db, now);
    });
    tx();
  }
}

function seedActionsAndTransitions(db: Database.Database, now: string): void {
  // Build role → lane ID map from the DB so we don't rely on array indices
  const lanes = db.prepare('SELECT id, role FROM swimlanes WHERE role IS NOT NULL').all() as Array<{ id: string; role: string }>;
  const byRole: Record<string, string> = {};
  for (const lane of lanes) byRole[lane.role] = lane.id;

  // Find plan-mode column (no longer a system role -- uses permission_strategy)
  const planLane = db.prepare("SELECT id FROM swimlanes WHERE permission_strategy = 'plan' LIMIT 1").get() as { id: string } | undefined;

  const insertAction = db.prepare(
    'INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  // Planning agent: launches Claude in plan mode
  const planActionId = uuidv4();
  insertAction.run(
    planActionId,
    'Start Planning Agent',
    'spawn_agent',
    JSON.stringify({
      agent: 'claude',
      promptTemplate: '{{title}}{{description}}{{attachments}}',
    }),
    now,
  );

  // Kill session action
  const killActionId = uuidv4();
  insertAction.run(killActionId, 'Kill Session', 'kill_session', '{}', now);

  const insertTransition = db.prepare(
    'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)'
  );

  // * → Planning: kill any existing session, then spawn planning agent
  if (planLane) {
    insertTransition.run(uuidv4(), '*', planLane.id, killActionId, 0);
    insertTransition.run(uuidv4(), '*', planLane.id, planActionId, 1);
  }
  // * → Done: kill session
  if (byRole.done) {
    insertTransition.run(uuidv4(), '*', byRole.done, killActionId, 0);
  }
}
