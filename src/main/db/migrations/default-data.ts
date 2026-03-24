import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

/**
 * Seed default swimlanes, actions, and transitions for a new project database.
 * Called from project-schema.ts when the swimlanes table is empty.
 */
export function seedDefaultSwimlanes(db: Database.Database): void {
  const now = new Date().toISOString();
  const insertLane = db.prepare(
    'INSERT INTO swimlanes (id, name, role, position, color, icon, is_archived, permission_mode, auto_spawn, auto_command, plan_exit_target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const defaults = [
    { name: 'To Do', role: 'todo', color: '#6b7280', icon: 'layers', archived: 0, permission_mode: null, auto_spawn: 0, auto_command: null },
    { name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', archived: 0, permission_mode: 'plan', auto_spawn: 1, auto_command: null },
    { name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
    { name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
    { name: 'Tests', role: null, color: '#06b6d4', icon: 'flask-conical', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
    { name: 'Ship It', role: null, color: '#F97316', icon: 'sailboat', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
    { name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', archived: 1, permission_mode: null, auto_spawn: 0, auto_command: null },
  ];

  const tx = db.transaction(() => {
    const laneIds: string[] = [];
    defaults.forEach((lane, index) => {
      const id = uuidv4();
      laneIds.push(id);
      insertLane.run(id, lane.name, lane.role, index, lane.color, lane.icon, lane.archived, lane.permission_mode, lane.auto_spawn, lane.auto_command, null, now);
    });

    // Set Planning's plan_exit_target_id to Executing (index 1 -> index 2)
    db.prepare('UPDATE swimlanes SET plan_exit_target_id = ? WHERE id = ?').run(laneIds[2], laneIds[1]);

    // Seed default actions and transitions
    seedActionsAndTransitions(db, now);
  });
  tx();
}

/**
 * Seed default actions and transitions for an existing project that
 * has swimlanes but no actions (e.g. upgraded from pre-actions schema).
 */
export function seedDefaultActions(db: Database.Database): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    seedActionsAndTransitions(db, now);
  });
  tx();
}

function seedActionsAndTransitions(db: Database.Database, now: string): void {
  // Build role -> lane ID map from the DB so we don't rely on array indices
  const lanes = db.prepare('SELECT id, role FROM swimlanes WHERE role IS NOT NULL').all() as Array<{ id: string; role: string }>;
  const byRole: Record<string, string> = {};
  for (const lane of lanes) byRole[lane.role] = lane.id;

  // Find plan-mode column (no longer a system role - uses permission_mode)
  const planLane = db.prepare("SELECT id FROM swimlanes WHERE permission_mode = 'plan' LIMIT 1").get() as { id: string } | undefined;

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

  // * -> Planning: kill any existing session, then spawn planning agent
  if (planLane) {
    insertTransition.run(uuidv4(), '*', planLane.id, killActionId, 0);
    insertTransition.run(uuidv4(), '*', planLane.id, planActionId, 1);
  }
  // * -> Done: kill session
  if (byRole.done) {
    insertTransition.run(uuidv4(), '*', byRole.done, killActionId, 0);
  }
}
