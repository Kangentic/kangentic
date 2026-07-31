import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { seedDefaultSwimlanes, seedDefaultActions } from './default-data';
import { migrateSpawnAgentConfig } from './spawn-agent-config-migration';
import { worktreeFolderFromPath } from '../../../shared/worktree-folder';

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
      pr_state TEXT,
      head_sha TEXT,
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
      agent_session_id TEXT,
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

    CREATE TABLE IF NOT EXISTS usage_history (
      id TEXT PRIMARY KEY,
      session_record_id TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      session_started_at TEXT NOT NULL,
      session_type TEXT,
      total_cost_usd REAL NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      model_display_name TEXT,
      lines_added INTEGER NOT NULL DEFAULT 0,
      lines_removed INTEGER NOT NULL DEFAULT 0,
      files_changed INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      agent TEXT,
      effort TEXT
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

  // Migration: add 'pr_state' column so the authoritative branch->PR resolver can
  // persist open/draft/merged/closed and re-resolution can reflect state changes.
  const hasPrStateColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'pr_state');
  if (!hasPrStateColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN pr_state TEXT DEFAULT NULL');
  }

  // Migration: add 'head_sha' column - the captured worktree HEAD commit, an
  // immutable anchor that lets PR resolution survive worktree deletion (Done) and
  // branch renames (resolve by commit when branch/number are unavailable).
  const hasHeadShaColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'head_sha');
  if (!hasHeadShaColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN head_sha TEXT DEFAULT NULL');
  }

  // Migration: add 'use_worktree' column for per-task worktree override
  const hasUseWorktreeColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'use_worktree');
  if (!hasUseWorktreeColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN use_worktree INTEGER DEFAULT NULL');
  }

  // Migration: carry external origin onto promoted tasks so import dedup survives
  // promotion. A backlog item imported from GitHub/Asana/etc. loses its backlog row
  // when promoted; without these columns the board task has no trace of its origin,
  // so the same issue could be re-imported. The dedup query now scans tasks too.
  const tasksColumns = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((col) => col.name);
  if (!tasksColumns.includes('external_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_id TEXT DEFAULT NULL');
  }
  if (!tasksColumns.includes('external_source')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_source TEXT DEFAULT NULL');
  }
  if (!tasksColumns.includes('external_url')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_url TEXT DEFAULT NULL');
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

  // Per-row data migrations for spawn_agent actions. The pure transform
  // lives in spawn-agent-config-migration.ts so it can be unit-tested
  // without a real DB handle.
  const spawnActions = db.prepare(
    "SELECT id, config_json FROM actions WHERE type = 'spawn_agent'"
  ).all() as Array<{ id: string; config_json: string }>;

  for (const action of spawnActions) {
    try {
      const parsed = JSON.parse(action.config_json);
      const { config, changed } = migrateSpawnAgentConfig(parsed);
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
    // JSON-encoded per-tool aggregates (PerToolStat[]). Captured at session
    // exit/suspend so the Session Summary panel can show a breakdown for
    // archived tasks where the in-memory event log is no longer available.
    ['tool_breakdown', 'TEXT DEFAULT NULL'],
    // Number of context compactions during this session record's CLI run
    // (PreCompact hooks, counted by the activity engine). NOT NULL DEFAULT 0 so
    // existing rows and never-compacted runs sum correctly into the per-task
    // lifetime rollup and the column matches its non-null `SessionRecord` type and
    // the `usage_history` sibling. Per-run; lifetime = SUM across the task's rows.
    ['compaction_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [columnName, columnDef] of metricsColumns) {
    if (!sessionColumns.has(columnName)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${columnName} ${columnDef}`);
    }
  }

  // Migration: mirror compaction_count into the append-only usage_history ledger
  // so the per-period rollups can carry it too. Idempotent for existing DBs (the
  // CREATE TABLE above already includes it for fresh ones).
  const hasUsageHistoryCompactionCount = (db.pragma('table_info(usage_history)') as Array<{ name: string }>)
    .some((col) => col.name === 'compaction_count');
  if (!hasUsageHistoryCompactionCount) {
    db.exec('ALTER TABLE usage_history ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: add 'isolated_swimlane_id' so a task can hold multiple parallel,
  // independently-resumable sessions. NULL means the task's main session; a
  // swimlane id means the separate, context-isolated session that belongs to that
  // 'isolated'-strategy column, so re-entering that column resumes its own
  // conversation, disconnected from the main session. Existing rows are NULL (main).
  const hasIsolatedSwimlaneId = (db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .some((col) => col.name === 'isolated_swimlane_id');
  if (!hasIsolatedSwimlaneId) {
    db.exec('ALTER TABLE sessions ADD COLUMN isolated_swimlane_id TEXT DEFAULT NULL');
  }

  // Migration: record the model/effort a session was actually spawned, resumed,
  // or live-switched with (the `--model` / `--effort` flag value; NULL = agent
  // default, no flag). This is the ground truth the column-transition injection
  // delta compares against, so a move only injects `/model` / `/effort` when the
  // session's real running value differs from the destination - never because
  // the leaving column or a drifted kangentic.json column config disagrees.
  // Distinct from `model_id` (agent-reported, captured at exit via metrics).
  const hasAppliedModel = (db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .some((col) => col.name === 'applied_model');
  if (!hasAppliedModel) {
    db.exec('ALTER TABLE sessions ADD COLUMN applied_model TEXT DEFAULT NULL');
  }
  const hasAppliedEffort = (db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .some((col) => col.name === 'applied_effort');
  if (!hasAppliedEffort) {
    db.exec('ALTER TABLE sessions ADD COLUMN applied_effort TEXT DEFAULT NULL');
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

  // Migration: monotonic display_id high-water mark.
  //
  // display_id used to be allocated as MAX(display_id) + 1, but `delete()` is a
  // hard DELETE, so removing the highest-numbered task handed its number to the
  // next one created. Since a task's worktree directory is now named after its
  // display_id, a recycled number could adopt a leftover directory belonging to
  // the deleted task. The counter only ever moves forward.
  db.exec('CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(`INSERT OR IGNORE INTO project_meta (key, value)
    SELECT 'display_id_high_water', CAST(COALESCE(MAX(display_id), 0) AS TEXT) FROM tasks`);

  // Migration: add worktree_folder - the write-once directory name for a task's
  // worktree. Backfilled ONLY from worktree_path, which is unambiguous.
  //
  // Deliberately NOT backfilled from sessions.cwd here. runProjectMigrations
  // receives only the database handle; the project path lives in the global DB,
  // so this migration has no anchor to tell a task's own worktree cwd apart from
  // a project that is itself registered AT a worktree path (an opened worktree,
  // or a /preview ephemeral project). In that case a task that never had a
  // worktree has a session cwd equal to the project root, which already contains
  // the marker, and a bare marker search would write a permanently wrong value
  // into a write-once column. That recovery happens at use time instead, where
  // the project path is available - see recoverLegacyWorktreeFolder.
  const hasWorktreeFolderColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'worktree_folder');
  if (!hasWorktreeFolderColumn) {
    // ALTER + backfill run in ONE transaction because the guard above tests only
    // for the column's existence. A crash between the two would leave the column
    // present and the guard satisfied, so the backfill would never run again -
    // and the column is write-once, so a task whose worktree_path is later nulled
    // by a Done move would lose its folder name permanently. Same reasoning, and
    // the same shape, as the run_mode migration further down this file.
    const addWorktreeFolderTransaction = db.transaction(() => {
      db.exec('ALTER TABLE tasks ADD COLUMN worktree_folder TEXT DEFAULT NULL');
      const tasksWithWorktree = db
        .prepare('SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL')
        .all() as Array<{ id: string; worktree_path: string }>;
      const updateWorktreeFolder = db.prepare('UPDATE tasks SET worktree_folder = ? WHERE id = ?');
      for (const task of tasksWithWorktree) {
        const folderName = worktreeFolderFromPath(task.worktree_path);
        if (folderName) updateWorktreeFolder.run(folderName, task.id);
      }
    });
    addWorktreeFolderTransaction();
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

  // Migration: add detail_view_state column - a per-task JSON blob holding the
  // task-detail dialog's layout (divider ratio, open side panel, Changes view
  // mode, selected diff file, maximized, reviewed-file marks, diff scope,
  // file-tree width) so reopening a task restores it across app restarts.
  const hasDetailViewStateColumn = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'detail_view_state');
  if (!hasDetailViewStateColumn) {
    db.exec('ALTER TABLE tasks ADD COLUMN detail_view_state TEXT DEFAULT NULL');
  }

  // Migration: rename claude_session_id -> agent_session_id
  const hasClaudeSessionIdColumn = (db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .some((col) => col.name === 'claude_session_id');
  if (hasClaudeSessionIdColumn) {
    db.exec('ALTER TABLE sessions RENAME COLUMN claude_session_id TO agent_session_id');
  }

  // Migration: add agent_override column to swimlanes for per-column agent selection
  const hasAgentOverride = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'agent_override');
  if (!hasAgentOverride) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN agent_override TEXT DEFAULT NULL');
  }

  // Migration: add handoff_context column to swimlanes for per-column handoff toggle
  const hasHandoffContext = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'handoff_context');
  if (!hasHandoffContext) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN handoff_context INTEGER NOT NULL DEFAULT 0');
  }

  // Migration: add model_override and effort_override columns to swimlanes for per-column
  // model/effort selection. NULL means "inherit from project default" (the agent's own default).
  const hasModelOverride = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'model_override');
  if (!hasModelOverride) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN model_override TEXT DEFAULT NULL');
  }
  const hasEffortOverride = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((col) => col.name === 'effort_override');
  if (!hasEffortOverride) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN effort_override TEXT DEFAULT NULL');
  }

  // Migration: per-column session model (two orthogonal axes).
  //   session_target ('main' default | 'isolated') - which session track a task
  //     runs on. Renamed in place from the original 'session_strategy' column;
  //     the values are unchanged, so no data backfill is needed.
  //   session_spawn_strategy ('create_or_resume' default | 'always_spawn_new') -
  //     what to do with that track on column entry.
  // Idempotent across fresh DBs, DBs still on the old 'session_strategy' column,
  // and already-migrated DBs (each ALTER is guarded against the live column set).
  const swimlaneColumnNames = (): string[] =>
    (db.pragma('table_info(swimlanes)') as Array<{ name: string }>).map((col) => col.name);
  let swimlaneCols = swimlaneColumnNames();
  if (swimlaneCols.includes('session_strategy') && !swimlaneCols.includes('session_target')) {
    db.exec('ALTER TABLE swimlanes RENAME COLUMN session_strategy TO session_target');
    swimlaneCols = swimlaneColumnNames();
  }
  if (!swimlaneCols.includes('session_target')) {
    db.exec("ALTER TABLE swimlanes ADD COLUMN session_target TEXT NOT NULL DEFAULT 'main'");
    swimlaneCols = swimlaneColumnNames();
  }
  if (!swimlaneCols.includes('session_spawn_strategy')) {
    db.exec("ALTER TABLE swimlanes ADD COLUMN session_spawn_strategy TEXT NOT NULL DEFAULT 'create_or_resume'");
  }

  // Migration: add per-task model_override and effort_override columns. Set
  // by the ContextBar popover; takes precedence over the swimlane override
  // (so the user's explicit "use Sonnet for this task" choice is sticky
  // across column moves). NULL means "inherit from the swimlane".
  const hasTaskModelOverride = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'model_override');
  if (!hasTaskModelOverride) {
    db.exec('ALTER TABLE tasks ADD COLUMN model_override TEXT DEFAULT NULL');
  }
  const hasTaskEffortOverride = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'effort_override');
  if (!hasTaskEffortOverride) {
    db.exec('ALTER TABLE tasks ADD COLUMN effort_override TEXT DEFAULT NULL');
  }

  // Migration: add per-task agent_override column. Set at task creation via
  // the New Task dialog's Advanced section; takes precedence over the
  // swimlane's `agent_override` and the project's default agent. When set,
  // the agent is locked for the task's entire lifetime - column moves cannot
  // change it, and the model/effort overrides set alongside are valid for
  // exactly this agent. NULL means "inherit from the swimlane".
  const hasTaskAgentOverride = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'agent_override');
  if (!hasTaskAgentOverride) {
    db.exec('ALTER TABLE tasks ADD COLUMN agent_override TEXT DEFAULT NULL');
  }

  // Migration: session_transcripts table for agent-agnostic PTY output capture.
  // No FK on session_id - the transcript row may be created before the sessions
  // row exists (PTY data arrives during spawn, before executeSpawnAgent inserts
  // the DB record). Cleanup is handled by a DELETE trigger on sessions instead.
  //
  // If the table already exists with a FK (from an earlier migration), drop and
  // recreate it without the FK. Safe because the table is new and has no
  // production data yet.
  const hasTranscriptTable = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcripts'",
  ).get() as { name: string } | undefined) !== undefined;
  if (hasTranscriptTable) {
    // Check if the existing table has a FK constraint (old version)
    const foreignKeys = db.pragma("foreign_key_list('session_transcripts')") as Array<{ table: string }>;
    if (foreignKeys.length > 0) {
      db.exec('DROP TABLE session_transcripts');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_transcripts (
      session_id TEXT PRIMARY KEY,
      transcript TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_delete_transcript
    AFTER DELETE ON sessions
    BEGIN
      DELETE FROM session_transcripts WHERE session_id = OLD.id;
    END
  `);

  // Migration: handoffs table for cross-agent context transfer provenance
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      to_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      trigger TEXT NOT NULL,
      packet_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoffs_task_id ON handoffs(task_id)');

  // Migration: remove hardcoded agent from spawn_agent action configs.
  // The default seed data previously set agent:'claude' which overrides the
  // project's default agent and column agent_override settings. Clear it so
  // the agent resolution chain respects user configuration.
  const hardcodedAgentActions = db.prepare(
    "SELECT id, config_json FROM actions WHERE type = 'spawn_agent'",
  ).all() as Array<{ id: string; config_json: string }>;
  for (const action of hardcodedAgentActions) {
    try {
      const config = JSON.parse(action.config_json);
      if (config.agent === 'claude') {
        delete config.agent;
        db.prepare('UPDATE actions SET config_json = ? WHERE id = ?').run(
          JSON.stringify(config),
          action.id,
        );
      }
    } catch {
      // Skip malformed configs
    }
  }

  // Migration: replace packet_json with session_history_path in handoffs table.
  // Session history passthrough stores the native file path instead of a
  // manufactured context packet.
  const handoffColumns = db.prepare("PRAGMA table_info('handoffs')").all() as Array<{ name: string }>;
  const hasSessionHistoryPath = handoffColumns.some((column) => column.name === 'session_history_path');
  if (!hasSessionHistoryPath) {
    db.exec('ALTER TABLE handoffs ADD COLUMN session_history_path TEXT');
  }

  // Migration: add description column to swimlanes for a free-form, team-shared
  // column purpose blurb (surfaced as a header tooltip, round-trips via kangentic.json).
  const hasSwimlaneDescription = (db.pragma('table_info(swimlanes)') as Array<{ name: string }>)
    .some((column) => column.name === 'description');
  if (!hasSwimlaneDescription) {
    db.exec('ALTER TABLE swimlanes ADD COLUMN description TEXT DEFAULT NULL');
  }

  // Migration: conversation-memory index (searchable transcripts). A per-project
  // retrieval store over the STRUCTURED transcript (TranscriptEntry-derived
  // chunks), NOT the raw session_transcripts scrollback blob.
  //
  // `memory_chunks` is corpus-generic (a `corpus` column) so the same store can
  // later index repo files/docs. `session_id`/`task_id` are nullable for that
  // future reuse; the conversation corpus always sets them.
  //
  // The vector table (`memory_chunks_vec`, USING vec0) is deliberately NOT
  // created here: it needs the sqlite-vec extension loaded, which may be
  // unavailable on a platform/build. It is created at runtime by
  // RetrievalStore.ensureVecTable() only when the extension loaded. No trigger
  // may reference it (a missing-module trigger body would break every
  // `DELETE FROM sessions`), so vec rows are cleaned by application code.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY,
      corpus TEXT NOT NULL DEFAULT 'conversation',
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      session_id TEXT,
      task_id TEXT,
      agent_session_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      ts_start INTEGER,
      ts_end INTEGER,
      turn_uuid_start TEXT,
      turn_uuid_end TEXT,
      embedded_model TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(corpus, doc_id, seq)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_chunks_doc ON memory_chunks(corpus, doc_id, seq)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_chunks_session ON memory_chunks(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedded ON memory_chunks(embedded_model)');

  // FTS5 external-content index over memory_chunks.text. FTS5 is compiled into
  // the shipped better-sqlite3, so this is always safe. External content (not
  // contentless) so snippet()/highlight() can return text and the sessions
  // DELETE cascade stays simple.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
      text,
      content='memory_chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_au AFTER UPDATE OF text ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);

  // Per-document index bookkeeping: staleness signature (path/mtime/size) so a
  // sweep can skip unchanged sources, and a terminal 'unsupported' status for
  // raw-only agents that have no structured parser.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_index_state (
      corpus TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      session_id TEXT,
      source_path TEXT,
      source_mtime_ms INTEGER,
      source_size INTEGER,
      entry_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (corpus, doc_id)
    )
  `);

  db.exec('CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  // Durable per-turn token-usage ledger. Each assistant turn that reported usage
  // gets one row, keyed by the turn's own uuid. This is the long-lived record that
  // cost / burn-rate analysis reads from: it is populated by ConversationIndexer
  // from the parsed transcript at index time, so it SURVIVES the agent pruning its
  // native JSONL - unlike the in-transcript `usage` field, which is re-derived on
  // each parse and vanishes with the source file. Counts are kept as raw
  // components (fresh input, output, cache-creation, cache-read) so downstream
  // analysis can weight fresh input against the much cheaper cache reads.
  //
  // Keyed by turn_uuid because a `--resume` REPLAYS its parent's turns verbatim
  // under the same uuid; the PK dedups a replayed turn back onto one row so
  // per-task / per-project totals never double-count a shared turn.
  //
  // Deliberately NO sessions-DELETE cascade (unlike memory_chunks below): this is a
  // durable ledger, not a rebuildable index. A shared turn attributed to a resuming
  // session must not be wiped when that session row is deleted while the turn still
  // lives in another session's transcript, and the token history is meant to
  // outlive the sessions it describes. Orphan tolerance is the intended durability
  // behavior; each row is a handful of integers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turn_usage (
      turn_uuid TEXT PRIMARY KEY,
      agent_session_id TEXT,
      session_id TEXT,
      task_id TEXT,
      model TEXT,
      ts INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_turn_usage_task ON conversation_turn_usage(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_turn_usage_session ON conversation_turn_usage(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_turn_usage_ts ON conversation_turn_usage(ts)');

  // Durable activity-disposition-interval ledger: one row per continuous span
  // a session spent in one `ActivityDisposition` bucket ('idle' - needing the
  // user, covering both ActivityState idle and permission - or 'active' -
  // the agent working on its own, ActivityState thinking; see
  // shared/activity-state.ts's dispositionOf). The engine itself is
  // in-memory only (recentTransitions is a debug-only bounded ring, wiped on
  // deleteSession/dispose), and the one on-disk trace (events.jsonl) is
  // neither faithful - it records raw hook events, not committed
  // transitions, so a raw idle cancelled by the 400ms stability window still
  // appears there with no matching UI change - nor reliably retained
  // (truncated on session-dir reuse, deleted on cleanup). This table is the
  // only durable, faithful record of the engine's committed transitions.
  //
  // Symmetric by design (both dispositions, not idle-only): deriving "active
  // time" as (session lifetime) minus (idle time) is fragile - it needs
  // exact session-boundary timestamps, breaks across a task's multiple
  // sessions (resume) and suspend/resume gaps, and a crash-orphaned open
  // interval (see below) would corrupt the subtraction silently. Recording
  // both directly means "active time" and "idle time" are each a straight
  // SUM over this table, no inverse math or session-boundary reconciliation
  // needed.
  //
  // enter_trigger / exit_trigger carry the engine's own TransitionTrigger
  // labels (activity-engine.ts) so a consumer can tell a hook-authoritative
  // park (`event:idle`) from a watchdog guess (`timer:stale-thinking`,
  // `timer:stuck-subagent`, `force-idle`), and a real human reply
  // (`event:prompt` with no synthetic detail) from the agent resuming itself
  // (`event:prompt:pty-activity`, `force-thinking`) - without those, an
  // average "wait time" silently mixes in the engine's own known false-idle
  // classes.
  //
  // One row per INTERVAL, not per transition: a permission<->idle crossing
  // stays within the same 'idle'-disposition interval (both map to the same
  // disposition, so nothing closes/reopens), so `duration_ms` is a stored
  // column instead of requiring a self-join to reconstruct.
  //
  // KNOWN GAP - the seed span is NOT recorded. The window before a session's
  // first DISPOSITION FLIP is skipped, since the engine's `initSession` seed
  // carries no prior state to diff against. This is larger than it sounds:
  // events within a turn (tool/subagent/bg-shell) keep the predicate at
  // 'thinking' and commit no transition, so a fresh spawn's entire first
  // active turn contributes 0ms to `activeMs`, and an idle-seeded session
  // (resume) that is never answered produces NO ROW AT ALL - `getForTask`
  // returns empty for exactly the "how long has this been waiting on me"
  // question. The live board tooltip reads `needsUserSince` off the engine
  // instead and is unaffected. Closing this needs the engine to announce its
  // seed (an explicit onSessionSeeded hook), not a ring-shape heuristic.
  //
  // Deliberately NO sessions-DELETE cascade, matching conversation_turn_usage
  // above - but for a different reason: that table's no-cascade protects a
  // turn shared across a resume, which does not apply here (an interval
  // belongs to exactly one session). This table's durability is the entire
  // point: an interval must outlive the session row that produced it, the
  // same way the token ledger outlives the transcript file it was read from.
  // A session that crashes mid-interval leaves it permanently open
  // (`ended_ms IS NULL`); consumers filter that out rather than the engine
  // attempting reconciliation on restart.
  // started_ms/ended_ms are the epoch-ms columns the store's duration_ms
  // arithmetic and started_ms index actually use (matching
  // conversation_turn_usage's `ts INTEGER` above). started_at/ended_at are a
  // TEXT ISO 8601 MIRROR of those same two instants (per utc-timestamps.md),
  // written by the store from the same input so the two representations can
  // never drift - not independently sourced, not user-suppliable. They exist
  // purely for readability: a human (or an agent) reading raw SQL via
  // kangentic_query_db, or the kangentic_get_activity_intervals MCP tool's
  // response, gets a real timestamp instead of having to convert epoch ms by
  // hand. ended_at is NULL exactly when ended_ms is (the interval is open).
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_activity_intervals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task_id TEXT,
      disposition TEXT NOT NULL,
      state TEXT NOT NULL,
      previous_state TEXT NOT NULL,
      enter_trigger TEXT NOT NULL,
      started_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_ms INTEGER,
      ended_at TEXT,
      duration_ms INTEGER,
      exit_trigger TEXT,
      recorded_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_intervals_task ON session_activity_intervals(task_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_intervals_session ON session_activity_intervals(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_intervals_started ON session_activity_intervals(started_ms)');
  // Resolves the one open interval for a session (WHERE session_id = ? AND
  // ended_ms IS NULL) without holding row ids in memory across a restart.
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_intervals_open ON session_activity_intervals(session_id, ended_ms)');

  // Cascade cleanup when a session is deleted (mirrors trg_sessions_delete_transcript).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_delete_memory
    AFTER DELETE ON sessions
    BEGIN
      DELETE FROM memory_chunks WHERE session_id = OLD.id;
      DELETE FROM memory_index_state WHERE session_id = OLD.id;
    END
  `);

  // Hot-path indices for session lookups.
  // - sessions(task_id, started_at): getLatestForTask, cost summaries, per-task history
  // - sessions(task_id, session_type, isolated_swimlane_id, started_at): getLatestForTaskByTypeAndIsolation,
  //   the resume-decision hot path for per-column isolated sessions
  // - sessions(status): getResumable, getOrphaned, markRunningAsOrphaned
  // - sessions(agent_session_id): findByIdOrAgentSessionId (resume-by-agent-id path)
  // - tasks(session_id): listBySessionId used by session-changed IPC events
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_task_started ON sessions(task_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_task_type_isolation_started ON sessions(task_id, session_type, isolated_swimlane_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_id ON sessions(agent_session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)');

  // Import dedup scans promoted board tasks by external origin (mirrors idx_backlog_external).
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(external_source, external_id)');

  // usage_history query indices (usage-dashboard period bucketing uses session_started_at).
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_history_session_started_at ON usage_history(session_started_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_history_recorded_at ON usage_history(recorded_at)');

  // Migration: add 'agent' column so the usage dashboard can break usage down
  // by agent (Claude vs Codex vs ...). Stamped at capture time from the
  // session manager's recorded agent name (generic - no agent-name branching);
  // best-effort backfill resolves surviving session -> task rows (the agent
  // name lives on the task). Rows whose session/task was deleted stay NULL and
  // render as "(unknown)".
  const hasUsageHistoryAgent = (db.pragma('table_info(usage_history)') as Array<{ name: string }>)
    .some((col) => col.name === 'agent');
  if (!hasUsageHistoryAgent) {
    db.exec('ALTER TABLE usage_history ADD COLUMN agent TEXT');
    db.exec(`
      UPDATE usage_history SET agent = (
        SELECT t.agent
          FROM sessions s
          JOIN tasks t ON t.id = s.task_id
         WHERE s.id = usage_history.session_record_id
      )
      WHERE agent IS NULL
    `);
  }

  // Migration: add 'effort' column so the usage dashboard can break usage down
  // by reasoning effort. Stamped at capture time from the session record's
  // applied_effort (the last spawn/resume/live-switch value - the same ground
  // truth the injection delta uses); best-effort backfill from surviving
  // session rows. NULL means agent default (no flag), rendered "(default)".
  const hasUsageHistoryEffort = (db.pragma('table_info(usage_history)') as Array<{ name: string }>)
    .some((col) => col.name === 'effort');
  if (!hasUsageHistoryEffort) {
    db.exec('ALTER TABLE usage_history ADD COLUMN effort TEXT');
    db.exec(`
      UPDATE usage_history SET effort = (
        SELECT s.applied_effort
          FROM sessions s
         WHERE s.id = usage_history.session_record_id
      )
      WHERE effort IS NULL
    `);
  }

  // One-shot backfill: populate the history from existing sessions so that
  // installs upgrading to this version do not see "All Time" reset to zero.
  // Guarded by row count + INSERT OR IGNORE so re-running is safe.
  const historyRowCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_history').get() as { c: number }).c;
  if (historyRowCount === 0) {
    const sourceRows = db.prepare(`
      SELECT s.id, s.started_at, s.suspended_at, s.exited_at, s.session_type,
             s.total_cost_usd, s.total_input_tokens, s.total_output_tokens,
             s.total_duration_ms, s.tool_call_count, s.model_id, s.model_display_name,
             s.lines_added, s.lines_removed, s.files_changed,
             t.agent AS agent, s.applied_effort AS effort
      FROM sessions s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.total_cost_usd IS NOT NULL
    `).all() as Array<{
      id: string;
      started_at: string;
      suspended_at: string | null;
      exited_at: string | null;
      session_type: string | null;
      total_cost_usd: number;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      total_duration_ms: number | null;
      tool_call_count: number | null;
      model_id: string | null;
      model_display_name: string | null;
      lines_added: number | null;
      lines_removed: number | null;
      files_changed: number | null;
      agent: string | null;
      effort: string | null;
    }>;
    if (sourceRows.length > 0) {
      const insertBackfill = db.prepare(`
        INSERT OR IGNORE INTO usage_history
          (id, session_record_id, recorded_at, session_started_at, session_type,
           total_cost_usd, total_input_tokens, total_output_tokens,
           total_duration_ms, tool_call_count, model_id, model_display_name,
           lines_added, lines_removed, files_changed, agent, effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const transaction = db.transaction(() => {
        for (const row of sourceRows) {
          insertBackfill.run(
            uuidv4(),
            row.id,
            row.exited_at ?? row.suspended_at ?? row.started_at,
            row.started_at,
            row.session_type,
            row.total_cost_usd,
            row.total_input_tokens ?? 0,
            row.total_output_tokens ?? 0,
            row.total_duration_ms,
            row.tool_call_count ?? 0,
            row.model_id,
            row.model_display_name,
            row.lines_added ?? 0,
            row.lines_removed ?? 0,
            row.files_changed ?? 0,
            row.agent,
            row.effort,
          );
        }
      });
      transaction();
    }
  }

  // Migration: add per-task permission_mode override column. Mirrors
  // agent_override/model_override/effort_override: settable via the New Task
  // dialog's Advanced section and the task-detail edit form (pre-spawn or
  // suspended only, same lock as agent_override); takes precedence over the
  // swimlane's permission_mode and the project's default permission mode.
  // NULL means "inherit from the swimlane / project default".
  const hasTaskPermissionOverride = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'permission_mode');
  if (!hasTaskPermissionOverride) {
    db.exec('ALTER TABLE tasks ADD COLUMN permission_mode TEXT DEFAULT NULL');
  }

  // Migration: add per-task auto_command column. MCP-only: set via
  // kangentic_create_task's `autoCommand` param so a skill can mint a task
  // that runs an initial command (e.g. "/code-review") once the agent spawns.
  // Not surfaced in the New Task dialog or project settings. Takes
  // precedence over the swimlane's auto_command for this task only. NULL
  // means "inherit from the swimlane".
  const hasTaskAutoCommand = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'auto_command');
  if (!hasTaskAutoCommand) {
    db.exec('ALTER TABLE tasks ADD COLUMN auto_command TEXT DEFAULT NULL');
  }

  // Migration: record every message sent into a session via
  // kangentic_send_session_message - by another agent, or by a human steering
  // that session directly.
  //
  // The delivered text carries NO in-band marker: an attribution prefix costs
  // tokens on every send and, empirically (2026-07-25), reads to the receiving
  // agent as injected content asserting its own authority, which is the shape
  // of a prompt injection - it refused messages sent this way rather than
  // acting on them. So provenance lives here, out of the agent's context, where
  // it costs nothing and cannot be forged by anything the agent writes.
  // `message` is stored verbatim, which is exactly the transcript turn's
  // content now that nothing is prepended, so a consumer can match a turn to
  // the row that sent it.
  //
  // caller_session_id / caller_task_id are deliberately NOT foreign keys: a
  // cross-project send originates in a different project's database, so the
  // ids are not resolvable locally. They are null when a human sent the message
  // with no Kangentic session of their own.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages_sent (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      caller_session_id TEXT,
      caller_task_id TEXT,
      caller_project_id TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_messages_sent_session_id ON session_messages_sent(session_id)');

  // `error` was added after the table shipped: a row records every
  // ATTEMPT (delivered / queued / refused / failed), not just the ones that
  // landed, so "did my message go through?" always has an answer. Guarded so a
  // database created by the intermediate shape picks the column up.
  const hasSentMessageError = (db.pragma('table_info(session_messages_sent)') as Array<{ name: string }>)
    .some((col) => col.name === 'error');
  if (!hasSentMessageError) {
    db.exec('ALTER TABLE session_messages_sent ADD COLUMN error TEXT DEFAULT NULL');
  }

  // Migration: add per-task profile_id column. Points at a named Board Profile
  // in kangentic.json's `profiles` array, whose per-column strategy deltas this
  // task follows as it moves (e.g. Planning in Opus xhigh, Executing in Opus
  // high, Merge in Sonnet high). NULL means the synthetic "Default" profile -
  // the columns' own base settings - so existing tasks need no backfill and
  // behavior is unchanged until someone creates a profile.
  //
  // Deliberately NOT a foreign key: profiles live in a checked-in config file,
  // not this database, so a teammate deleting a profile must degrade to Default
  // rather than fail a write. Resolution is total (see resolveColumnStrategy).
  //
  // Mutually exclusive with agent_override / model_override / effort_override /
  // permission_mode, enforced in TaskRepository. That exclusivity is what keeps
  // lockAdvancedOverridesOnFirstSpawn from freezing a profile task's ladder at
  // its first column.
  const hasTaskProfileId = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((col) => col.name === 'profile_id');
  if (!hasTaskProfileId) {
    db.exec('ALTER TABLE tasks ADD COLUMN profile_id TEXT DEFAULT NULL');
  }

  // Migration: add per-task run_mode column. Which of the two dialog branches
  // ("Column Settings" vs "Agent Override") the user chose, persisted instead of
  // derived. It has to be stored, because "Agent Override with all four fields
  // left on inherit" writes exactly the same five nulls as "Column Settings"
  // while meaning the opposite: the first locks agent/model/effort/permission at
  // first spawn, the second follows the columns forever. Deriving it silently
  // dropped the user's choice on every save.
  //
  // The backfill reproduces the old `hasAnyOverrideSet` derivation exactly, so
  // every existing row keeps its current behavior: any of the four pins set means
  // the task was authored in override mode. auto_command is deliberately excluded
  // (it is an MCP escape hatch, not an Advanced pin - see ADVANCED_PIN_FIELDS in
  // task-repository.ts). The `profile_id IS NULL` clause is belt-and-braces: a
  // profile task cannot carry a pin (TaskRepository has enforced that since
  // profile_id shipped), so the clause changes no row today - but it makes the
  // backfill correct by construction rather than by trusting an invariant
  // enforced in another file, and a row claiming both a profile and override
  // mode is exactly what the first-spawn lock must never see.
  //
  // ALTER + backfill run in ONE transaction because the guard above tests only
  // for the column's existence. A crash between the two would leave the column
  // present and the guard satisfied, so the backfill would never run again and
  // every already-pinned task on that database would be stuck reporting
  // 'column_settings' forever.
  const hasTaskRunMode = (db.pragma('table_info(tasks)') as Array<{ name: string }>)
    .some((column) => column.name === 'run_mode');
  if (!hasTaskRunMode) {
    const addRunModeTransaction = db.transaction(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'column_settings'");
      db.exec(`UPDATE tasks SET run_mode = 'agent_override'
        WHERE profile_id IS NULL
          AND (agent_override IS NOT NULL OR model_override IS NOT NULL
            OR effort_override IS NOT NULL OR permission_mode IS NOT NULL)`);
    });
    addRunModeTransaction();
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
