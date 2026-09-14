import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

/**
 * The seeded default board. Exported (not just function-local) so the
 * board_snapshot analytics event can classify a board as customized against
 * the same literal the seeder writes, with no second copy to drift.
 * Readonly (as const): a consumer mutating the shared array would corrupt
 * every later seed in this process, so mutation must fail at compile time.
 */
export const DEFAULT_SWIMLANES = [
  { name: 'To Do', role: 'todo', color: '#6b7280', icon: 'layers', archived: 0, permission_mode: null, auto_spawn: 0, auto_command: null },
  { name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', archived: 0, permission_mode: 'plan', auto_spawn: 1, auto_command: null },
  { name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
  { name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
  { name: 'Testing', role: null, color: '#06b6d4', icon: 'flask-conical', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
  { name: 'Merge', role: null, color: '#f97316', icon: 'merge', archived: 0, permission_mode: null, auto_spawn: 1, auto_command: null },
  { name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', archived: 1, permission_mode: null, auto_spawn: 0, auto_command: null },
] as const;

/**
 * Seed default swimlanes, actions, and transitions for a new project database.
 * Called from project-schema.ts when the swimlanes table is empty.
 */
export function seedDefaultSwimlanes(db: Database.Database): void {
  const now = new Date().toISOString();
  const insertLane = db.prepare(
    'INSERT INTO swimlanes (id, name, role, position, color, icon, is_archived, permission_mode, auto_spawn, auto_command, plan_exit_target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const defaults = DEFAULT_SWIMLANES;

  const tx = db.transaction(() => {
    const laneIds: string[] = [];
    defaults.forEach((lane, index) => {
      const id = uuidv4();
      laneIds.push(id);
      insertLane.run(id, lane.name, lane.role, index, lane.color, lane.icon, lane.archived, lane.permission_mode, lane.auto_spawn, lane.auto_command, null, now);
    });

    // Set Planning's plan_exit_target_id to Executing (index 1 -> index 2)
    db.prepare('UPDATE swimlanes SET plan_exit_target_id = ? WHERE id = ?').run(laneIds[2], laneIds[1]);
  });
  tx();
}

/**
 * Nothing seeds actions, transitions, or automations any more, and a fresh
 * board is not missing anything as a result.
 *
 * The two rows this used to write were both dead weight. `* -> Planning: Kill
 * Session` ran at Priority 4, where the task has no active session, so
 * `executeKillSession` found nothing to suspend and did nothing at all. `Start
 * Planning Agent` carried `DEFAULT_SPAWN_PROMPT_TEMPLATE`, which is exactly
 * what the fallback spawn uses when no action supplies a prompt, so it
 * duplicated behavior the column's own "Start an agent here" setting already
 * produces.
 *
 * Seeding them also taught the wrong model: it made starting an agent look like
 * an automation a user could reorder or delete, when it is a column setting. A
 * new board now shows an empty automations list, which is both true and the
 * right blank page to start from.
 */
