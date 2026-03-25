import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { seedDefaultSwimlanes, seedDefaultActions } from './default-data';

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
      permission_mode TEXT DEFAULT NULL,
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
    const roleMap: Record<number, string> = { 0: 'todo', 1: 'planning', 2: 'running' };
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
  // from specific columns (e.g. Backlog -> Planning becomes * -> Planning).
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

      // 2. Remove action-level permissionMode (moved to swimlane-level override)
      if (config.permissionMode !== undefined) {
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

  // Migration: add permission_mode (formerly permission_strategy) and auto_spawn columns to swimlanes
  const swimlaneColNames = new Set(
    (db.pragma('table_info(swimlanes)') as Array<{ name: string }>).map((col) => col.name),
  );
  const hasPermColumn = swimlaneColNames.has('permission_mode') || swimlaneColNames.has('permission_strategy');
  if (!hasPermColumn) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN permission_mode TEXT DEFAULT NULL');
    db.exec('ALTER TABLE swimlanes ADD COLUMN auto_spawn INTEGER NOT NULL DEFAULT 1');
    // Backfill: backlog/done columns don't auto-spawn; planning uses plan mode
    db.exec("UPDATE swimlanes SET auto_spawn = 0 WHERE role IN ('todo', 'backlog', 'done')");
    db.exec("UPDATE swimlanes SET permission_mode = 'plan' WHERE role = 'planning'");
    // Convert running role to custom column (no longer a system role)
    db.exec("UPDATE swimlanes SET role = NULL WHERE role = 'running'");
  }

  // Migration: add auto_command column to swimlanes
  const hasAutoCommand = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'auto_command');
  if (!hasAutoCommand) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN auto_command TEXT DEFAULT NULL');
  }

  // Migration: rename is_terminal -> is_archived
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
    // Remove planning role - it becomes a regular column with permission_mode='plan'
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
      ) WHERE permission_mode = 'plan' AND plan_exit_target_id IS NULL
    `);
  }

  // Migration: add 'suspended_by' column to track who suspended the session
  const hasSuspendedBy = (db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .some((col) => col.name === 'suspended_by');
  if (!hasSuspendedBy) {
    db.exec("ALTER TABLE sessions ADD COLUMN suspended_by TEXT DEFAULT NULL");
  }

  // Migration: add 'is_ghost' column to swimlanes
  const hasSwimlaneIsGhost = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'is_ghost');
  if (!hasSwimlaneIsGhost) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN is_ghost INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: add session metrics columns for completed task summaries
  const sessionColumns = new Set(
    (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((col) => col.name),
  );
  const metricsColumns: Array<[string, string]> = [
    ['total_cost_usd', 'REAL DEFAULT NULL'],
    ['total_input_tokens', 'INTEGER DEFAULT NULL'],
    ['total_output_tokens', 'INTEGER DEFAULT NULL'],
    ['model_id', 'TEXT DEFAULT NULL'],
    ['model_display_name', 'TEXT DEFAULT NULL'],
    ['total_duration_ms', 'INTEGER DEFAULT NULL'],
    ['tool_call_count', 'INTEGER DEFAULT NULL'],
    ['lines_added', 'INTEGER DEFAULT NULL'],
    ['lines_removed', 'INTEGER DEFAULT NULL'],
    ['files_changed', 'INTEGER DEFAULT NULL'],
  ];
  for (const [columnName, columnDef] of metricsColumns) {
    if (!sessionColumns.has(columnName)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${columnName} ${columnDef}`);
    }
  }

  // Migration: rename permission_strategy column -> permission_mode
  const currentSwimlaneCols = new Set(
    (db.pragma('table_info(swimlanes)') as Array<{ name: string }>).map((col) => col.name),
  );
  if (currentSwimlaneCols.has('permission_strategy') && !currentSwimlaneCols.has('permission_mode')) {
    db.exec('ALTER TABLE swimlanes RENAME COLUMN permission_strategy TO permission_mode');
  }

  // Data migration: rename legacy permission_mode values in swimlanes
  db.prepare("UPDATE swimlanes SET permission_mode = 'default' WHERE permission_mode = 'project-settings'").run();
  db.prepare("UPDATE swimlanes SET permission_mode = 'default' WHERE permission_mode = 'manual'").run();
  db.prepare("UPDATE swimlanes SET permission_mode = 'bypassPermissions' WHERE permission_mode = 'dangerously-skip'").run();
  db.prepare("UPDATE swimlanes SET permission_mode = 'bypassPermissions' WHERE permission_mode = 'bypass-permissions'").run();

  // Data migration: rename legacy permission_mode values in session records
  db.prepare("UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE permission_mode = 'bypass-permissions'").run();
  db.prepare("UPDATE sessions SET permission_mode = 'default' WHERE permission_mode = 'manual'").run();

  // Migration: rename 'Backlog' swimlane to 'To Do' and migrate role 'backlog' -> 'todo'
  db.prepare("UPDATE swimlanes SET name = 'To Do' WHERE role IN ('backlog', 'todo') AND name IN ('Backlog', 'Not Started')").run();
  db.prepare("UPDATE swimlanes SET role = 'todo' WHERE role = 'backlog'").run();

  // Migration: create backlog_tasks table for staging tasks before the board
  // (Originally created as backlog_items, renamed to backlog_tasks below)
  const hasBacklogTable = (db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='backlog_tasks'"
  ).get() as { c: number }).c > 0;
  const hasLegacyBacklogTable = (db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='backlog_items'"
  ).get() as { c: number }).c > 0;
  if (!hasBacklogTable && !hasLegacyBacklogTable) {
    db.exec(`
      CREATE TABLE backlog_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        labels TEXT NOT NULL DEFAULT '[]',
        position INTEGER NOT NULL,
        external_id TEXT DEFAULT NULL,
        external_source TEXT DEFAULT NULL,
        external_url TEXT DEFAULT NULL,
        sync_status TEXT DEFAULT NULL,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_backlog_position ON backlog_tasks(position);
      CREATE INDEX idx_backlog_external ON backlog_tasks(external_source, external_id);
    `);
  }

  // Migration: create backlog_attachments table for backlog task file attachments
  const hasBacklogAttachmentsTable = (db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='backlog_attachments'"
  ).get() as { c: number }).c > 0;
  if (!hasBacklogAttachmentsTable) {
    db.exec(`
      CREATE TABLE backlog_attachments (
        id TEXT PRIMARY KEY,
        backlog_task_id TEXT NOT NULL REFERENCES backlog_tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_backlog_attachments_task_id ON backlog_attachments(backlog_task_id);
    `);
  }

  // Migration: add import-related columns to backlog_tasks for external source integration
  const backlogTableName = hasLegacyBacklogTable && !hasBacklogTable ? 'backlog_items' : 'backlog_tasks';
  const backlogColumns = (db.pragma(`table_info(${backlogTableName})`) as Array<{ name: string }>)
    .map((col) => col.name);
  if (!backlogColumns.includes('assignee')) {
    db.exec(`ALTER TABLE ${backlogTableName} ADD COLUMN assignee TEXT DEFAULT NULL`);
  }
  if (!backlogColumns.includes('due_date')) {
    db.exec(`ALTER TABLE ${backlogTableName} ADD COLUMN due_date TEXT DEFAULT NULL`);
  }
  if (!backlogColumns.includes('item_type')) {
    db.exec(`ALTER TABLE ${backlogTableName} ADD COLUMN item_type TEXT DEFAULT NULL`);
  }
  if (!backlogColumns.includes('external_metadata')) {
    db.exec(`ALTER TABLE ${backlogTableName} ADD COLUMN external_metadata TEXT DEFAULT NULL`);
  }

  // Migration: rename backlog_items -> backlog_tasks (for existing DBs)
  if (hasLegacyBacklogTable && !hasBacklogTable) {
    db.exec('ALTER TABLE backlog_items RENAME TO backlog_tasks');
  }
  // Migration: rename backlog_item_id -> backlog_task_id in backlog_attachments (for existing DBs)
  const attachmentColumns = (db.pragma('table_info(backlog_attachments)') as Array<{ name: string }>)
    .map((col) => col.name);
  if (attachmentColumns.includes('backlog_item_id')) {
    db.exec('ALTER TABLE backlog_attachments RENAME COLUMN backlog_item_id TO backlog_task_id');
  }

  // Migration: add display_id column for short human-readable task IDs
  const hasDisplayIdColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'display_id');
  if (!hasDisplayIdColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN display_id INTEGER DEFAULT NULL');
    // Backfill existing tasks with sequential display IDs ordered by creation time
    const existingTasks = db.prepare('SELECT id FROM tasks ORDER BY created_at ASC').all() as Array<{ id: string }>;
    const updateDisplayId = db.prepare('UPDATE tasks SET display_id = ? WHERE id = ?');
    const backfillTransaction = db.transaction(() => {
      let counter = 1;
      for (const task of existingTasks) {
        updateDisplayId.run(counter, task.id);
        counter++;
      }
    });
    backfillTransaction();
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_display_id ON tasks(display_id)');
  }

  // --- Add labels and priority columns to tasks ---
  const hasTaskLabelsColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === 'labels');
  if (!hasTaskLabelsColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
  }
  const hasTaskPriorityColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === 'priority');
  if (!hasTaskPriorityColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  }

  // Seed default swimlanes if empty (must run after all ALTER TABLE migrations)
  const laneCount = db.prepare('SELECT COUNT(*) as c FROM swimlanes').get() as { c: number };
  if (laneCount.c === 0) {
    seedDefaultSwimlanes(db);
  }

  // For existing projects: seed default actions if the actions table is empty
  const actionCount = db.prepare('SELECT COUNT(*) as c FROM actions').get() as { c: number };
  if (actionCount.c === 0 && laneCount.c > 0) {
    seedDefaultActions(db);
  }
}
