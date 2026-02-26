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

}

export function runProjectMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swimlanes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      position INTEGER NOT NULL,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      is_terminal INTEGER NOT NULL DEFAULT 0,
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
    const lanes = db.prepare('SELECT id, position, is_terminal FROM swimlanes ORDER BY position ASC').all() as Array<{ id: string; position: number; is_terminal: number }>;
    const roleMap: Record<number, string> = { 0: 'backlog', 1: 'planning', 2: 'running' };
    for (const lane of lanes) {
      const role = lane.is_terminal ? 'done' : roleMap[lane.position] || null;
      if (role) {
        db.prepare('UPDATE swimlanes SET role = ? WHERE id = ?').run(role, lane.id);
      }
    }
  }

  // Seed default swimlanes if empty
  const laneCount = db.prepare('SELECT COUNT(*) as c FROM swimlanes').get() as { c: number };
  if (laneCount.c === 0) {
    const now = new Date().toISOString();
    const insertLane = db.prepare(
      'INSERT INTO swimlanes (id, name, role, position, color, is_terminal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const defaults = [
      { name: 'Backlog', role: 'backlog', color: '#6b7280', terminal: 0 },
      { name: 'Planning', role: 'planning', color: '#8b5cf6', terminal: 0 },
      { name: 'Running', role: 'running', color: '#3b82f6', terminal: 0 },
      { name: 'Review', role: null, color: '#f59e0b', terminal: 0 },
      { name: 'Done', role: 'done', color: '#10b981', terminal: 1 },
    ];

    const tx = db.transaction(() => {
      const laneIds: string[] = [];
      defaults.forEach((lane, i) => {
        const id = uuidv4();
        insertLane.run(id, lane.name, lane.role, i, lane.color, lane.terminal, now);
        laneIds.push(id);
      });

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

  // Data migration: update spawn_agent actions that still use 'dangerously-skip'
  // permission mode to omit it (falling through to app default: project-settings).
  const agentActions = db.prepare(
    "SELECT id, config_json FROM actions WHERE type = 'spawn_agent'"
  ).all() as Array<{ id: string; config_json: string }>;

  for (const action of agentActions) {
    try {
      const config = JSON.parse(action.config_json);
      if (config.permissionMode === 'dangerously-skip') {
        delete config.permissionMode;
        db.prepare('UPDATE actions SET config_json = ? WHERE id = ?')
          .run(JSON.stringify(config), action.id);
      }
    } catch { /* skip malformed config */ }
  }
}

function seedActionsAndTransitions(db: Database.Database, now: string): void {
  // Build role → lane ID map from the DB so we don't rely on array indices
  const lanes = db.prepare('SELECT id, role FROM swimlanes WHERE role IS NOT NULL').all() as Array<{ id: string; role: string }>;
  const byRole: Record<string, string> = {};
  for (const lane of lanes) byRole[lane.role] = lane.id;

  const insertAction = db.prepare(
    'INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  // Planning agent: launches Claude in plan mode (--plan)
  const planActionId = uuidv4();
  insertAction.run(
    planActionId,
    'Start Planning Agent',
    'spawn_agent',
    JSON.stringify({
      agent: 'claude',
      promptTemplate: 'Task: {{title}}\n\n{{description}}',
      permissionMode: 'plan-mode',
    }),
    now,
  );

  // Running agent: launches Claude with project-settings permissions (default)
  const runActionId = uuidv4();
  insertAction.run(
    runActionId,
    'Start Running Agent',
    'spawn_agent',
    JSON.stringify({
      agent: 'claude',
      promptTemplate: 'Task: {{title}}\n\n{{description}}',
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
  if (byRole.planning) {
    insertTransition.run(uuidv4(), '*', byRole.planning, killActionId, 0);
    insertTransition.run(uuidv4(), '*', byRole.planning, planActionId, 1);
  }
  // * → Running: kill any existing session, then spawn running agent
  if (byRole.running) {
    insertTransition.run(uuidv4(), '*', byRole.running, killActionId, 0);
    insertTransition.run(uuidv4(), '*', byRole.running, runActionId, 1);
  }
  // * → Done: kill session
  if (byRole.done) {
    insertTransition.run(uuidv4(), '*', byRole.done, killActionId, 0);
  }
}
