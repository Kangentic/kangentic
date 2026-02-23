import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import os from 'node:os';
import path from 'node:path';

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

  // Seed sample projects if empty
  const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
  if (projectCount.c === 0) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO projects (id, name, path, default_agent, last_opened, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const ghDir = path.join(os.homedir(), 'Documents', 'GitHub');
    const samples = [
      { name: 'sample-api', path: path.join(ghDir, 'sample-api') },
      { name: 'sample-frontend', path: path.join(ghDir, 'sample-frontend') },
    ];
    samples.forEach((p) => {
      insert.run(uuidv4(), p.name, p.path, 'claude', now, now);
    });
  }
}

export function runProjectMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swimlanes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swimlane_transitions (
      id TEXT PRIMARY KEY,
      from_swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
      to_swimlane_id TEXT NOT NULL REFERENCES swimlanes(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
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

  // Seed default swimlanes if empty
  const laneCount = db.prepare('SELECT COUNT(*) as c FROM swimlanes').get() as { c: number };
  if (laneCount.c === 0) {
    const now = new Date().toISOString();
    const insertLane = db.prepare(
      'INSERT INTO swimlanes (id, name, position, color, is_terminal, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const defaults = [
      { name: 'Backlog', color: '#6b7280', terminal: 0 },
      { name: 'Planning', color: '#8b5cf6', terminal: 0 },
      { name: 'Running', color: '#3b82f6', terminal: 0 },
      { name: 'Review', color: '#f59e0b', terminal: 0 },
      { name: 'Done', color: '#10b981', terminal: 1 },
    ];

    const tx = db.transaction(() => {
      const laneIds: string[] = [];
      defaults.forEach((lane, i) => {
        const id = uuidv4();
        insertLane.run(id, lane.name, i, lane.color, lane.terminal, now);
        laneIds.push(id);
      });

      // Seed default skills and transitions
      seedSkillsAndTransitions(db, laneIds, now);

      // Seed test tasks in Backlog
      const insertTask = db.prepare(
        'INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      insertTask.run(uuidv4(), 'Agent 1', 'This is testing agent 1', laneIds[0], 0, now, now);
      insertTask.run(uuidv4(), 'Agent 2', 'This is testing agent 2', laneIds[0], 1, now, now);
    });
    tx();
  }

  // For existing projects: seed default skills if the skills table is empty
  const skillCount = db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number };
  if (skillCount.c === 0 && laneCount.c > 0) {
    const now = new Date().toISOString();
    const lanes = db.prepare('SELECT id, name FROM swimlanes ORDER BY position ASC').all() as Array<{ id: string; name: string }>;
    const laneIds = lanes.map((l) => l.id);
    if (laneIds.length >= 3) {
      const tx = db.transaction(() => {
        seedSkillsAndTransitions(db, laneIds, now);
      });
      tx();
    }
  }

  // Data migration: update spawn_agent skills that still use 'dangerously-skip'
  // permission mode to omit it (falling through to app default: project-settings).
  const agentSkills = db.prepare(
    "SELECT id, config_json FROM skills WHERE type = 'spawn_agent'"
  ).all() as Array<{ id: string; config_json: string }>;

  for (const skill of agentSkills) {
    try {
      const config = JSON.parse(skill.config_json);
      if (config.permissionMode === 'dangerously-skip') {
        delete config.permissionMode;
        db.prepare('UPDATE skills SET config_json = ? WHERE id = ?')
          .run(JSON.stringify(config), skill.id);
      }
    } catch { /* skip malformed config */ }
  }
}

function seedSkillsAndTransitions(db: Database.Database, laneIds: string[], now: string): void {
  const insertSkill = db.prepare(
    'INSERT INTO skills (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  // Planning agent: launches Claude in plan mode (--plan)
  const planSkillId = uuidv4();
  insertSkill.run(
    planSkillId,
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
  const runSkillId = uuidv4();
  insertSkill.run(
    runSkillId,
    'Start Running Agent',
    'spawn_agent',
    JSON.stringify({
      agent: 'claude',
      promptTemplate: 'Task: {{title}}\n\n{{description}}',
    }),
    now,
  );

  // Kill session skill
  const killSkillId = uuidv4();
  insertSkill.run(killSkillId, 'Kill Session', 'kill_session', '{}', now);

  const insertTransition = db.prepare(
    'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, skill_id, execution_order) VALUES (?, ?, ?, ?, ?)'
  );

  // Backlog[0] → Planning[1]: spawn planning agent
  insertTransition.run(uuidv4(), laneIds[0], laneIds[1], planSkillId, 0);
  // Backlog[0] → Running[2]: spawn running agent
  insertTransition.run(uuidv4(), laneIds[0], laneIds[2], runSkillId, 0);
  // Planning[1] → Running[2]: kill plan session then spawn running agent
  insertTransition.run(uuidv4(), laneIds[1], laneIds[2], killSkillId, 0);
  insertTransition.run(uuidv4(), laneIds[1], laneIds[2], runSkillId, 1);
  // Any → Done[4]: kill session
  if (laneIds.length >= 5) {
    for (let i = 0; i < 4; i++) {
      insertTransition.run(uuidv4(), laneIds[i], laneIds[4], killSkillId, 0);
    }
  }
}
