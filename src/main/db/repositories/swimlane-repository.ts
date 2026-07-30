import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Swimlane, SwimlaneCreateInput, SwimlaneUpdateInput, SwimlaneRole, PermissionMode, SessionTarget, SessionSpawnStrategy } from '../../../shared/types';

/** Raw row shape returned by better-sqlite3 for the swimlanes table. */
interface SwimlaneRow {
  id: string;
  name: string;
  role: string | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: number;
  is_ghost: number;
  permission_mode: string | null;
  auto_spawn: number;
  auto_command: string | null;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  handoff_context: number;
  // NOT NULL DEFAULT in the schema, so always a string from a SELECT. mapRow keeps
  // a defensive `?? default` purely for rows read mid-migration.
  session_target: string;
  session_spawn_strategy: string;
  created_at: string;
  // Added via ALTER TABLE, so physically last in the row.
  description: string | null;
}

/**
 * Delete a swimlane row and every DB reference that points at it, atomically.
 *
 * Three call sites need exactly this trio and used to each carry their own copy:
 * `SwimlaneRepository.delete`, `SwimlaneRepository.deleteEmptyGhosts`, and the
 * board-config reconciler (`apply-config.ts`), which deliberately bypasses
 * `delete()`'s guards so it can drop role-bearing lanes. Any fourth caller (the
 * MCP `delete_column` handler) would have forked it again, which is how a
 * reference gets missed.
 *
 * Deliberately NOT cleaned: `sessions.isolated_swimlane_id`. Null there MEANS
 * "main session" (see `SessionRepository.getLatestForTaskByTypeAndIsolation`), so
 * nulling a stale value would promote an isolated record into the main slot and
 * collide in the resume dedup key; deleting the rows would lose transcript
 * history. A stale id is inert - nothing ever matches a swimlane that is gone.
 *
 * Guards (role column, non-empty) belong to the CALLER, not here.
 */
export function deleteSwimlaneRowWithReferences(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?').run(id, id);
    // Clear dangling plan_exit_target_id references
    db.prepare('UPDATE swimlanes SET plan_exit_target_id = NULL WHERE plan_exit_target_id = ?').run(id);
    db.prepare('DELETE FROM swimlanes WHERE id = ?').run(id);
  });
  tx();
}

export class SwimlaneRepository {
  constructor(private db: Database.Database) {}

  list(): Swimlane[] {
    const rows = this.db.prepare('SELECT * FROM swimlanes ORDER BY position ASC').all() as SwimlaneRow[];
    return rows.map(this.mapRow);
  }

  getById(id: string): Swimlane | undefined {
    const row = this.db.prepare('SELECT * FROM swimlanes WHERE id = ?').get(id) as SwimlaneRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  create(input: SwimlaneCreateInput & { id?: string; is_ghost?: boolean; role?: SwimlaneRole; position?: number }): Swimlane {
    const now = new Date().toISOString();
    const id = input.id ?? uuidv4();

    let insertPos: number;
    if (input.position !== undefined) {
      insertPos = input.position;
    } else {
      // Insert before the 'done' column (if any), otherwise at the end
      const doneCol = this.db.prepare(
        "SELECT position FROM swimlanes WHERE role = 'done' ORDER BY position ASC LIMIT 1"
      ).get() as { position: number } | undefined;

      if (doneCol) {
        insertPos = doneCol.position;
        // Shift done column (and anything after) up by one
        this.db.prepare('UPDATE swimlanes SET position = position + 1 WHERE position >= ?').run(insertPos);
      } else {
        const maxPos = this.db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM swimlanes').get() as { max: number };
        insertPos = maxPos.max + 1;
      }
    }

    const swimlane: Swimlane = {
      id,
      name: input.name,
      description: input.description ?? null,
      role: input.role ?? null,
      position: insertPos,
      color: input.color || '#3b82f6',
      icon: input.icon || null,
      is_archived: input.is_archived || false,
      is_ghost: input.is_ghost || false,
      permission_mode: input.permission_mode ?? null,
      auto_spawn: input.auto_spawn ?? true,
      auto_command: input.auto_command ?? null,
      plan_exit_target_id: input.plan_exit_target_id ?? null,
      agent_override: input.agent_override ?? null,
      model_override: input.model_override ?? null,
      effort_override: input.effort_override ?? null,
      handoff_context: input.handoff_context ?? false,
      session_target: input.session_target ?? 'main',
      session_spawn_strategy: input.session_spawn_strategy ?? 'create_or_resume',
      created_at: now,
    };

    this.db.prepare(
      'INSERT INTO swimlanes (id, name, description, role, position, color, icon, is_archived, is_ghost, permission_mode, auto_spawn, auto_command, plan_exit_target_id, agent_override, model_override, effort_override, handoff_context, session_target, session_spawn_strategy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(swimlane.id, swimlane.name, swimlane.description, swimlane.role, swimlane.position, swimlane.color, swimlane.icon, swimlane.is_archived ? 1 : 0, swimlane.is_ghost ? 1 : 0, swimlane.permission_mode, swimlane.auto_spawn ? 1 : 0, swimlane.auto_command, swimlane.plan_exit_target_id, swimlane.agent_override, swimlane.model_override, swimlane.effort_override, swimlane.handoff_context ? 1 : 0, swimlane.session_target, swimlane.session_spawn_strategy, swimlane.created_at);

    return swimlane;
  }

  update(input: SwimlaneUpdateInput): Swimlane {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Swimlane ${input.id} not found`);

    const updated = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.description !== undefined) updated.description = input.description;
    if (input.color !== undefined) updated.color = input.color;
    if (input.icon !== undefined) updated.icon = input.icon;
    if (input.position !== undefined) updated.position = input.position;
    if (input.is_archived !== undefined) updated.is_archived = input.is_archived;
    if (input.is_ghost !== undefined) updated.is_ghost = input.is_ghost;
    if (input.permission_mode !== undefined) updated.permission_mode = input.permission_mode;
    if (input.auto_spawn !== undefined) updated.auto_spawn = input.auto_spawn;
    if (input.auto_command !== undefined) updated.auto_command = input.auto_command;
    if (input.plan_exit_target_id !== undefined) updated.plan_exit_target_id = input.plan_exit_target_id;
    if (input.agent_override !== undefined) updated.agent_override = input.agent_override;
    if (input.model_override !== undefined) updated.model_override = input.model_override;
    if (input.effort_override !== undefined) updated.effort_override = input.effort_override;
    if (input.handoff_context !== undefined) updated.handoff_context = input.handoff_context;
    if (input.session_target !== undefined) updated.session_target = input.session_target;
    if (input.session_spawn_strategy !== undefined) updated.session_spawn_strategy = input.session_spawn_strategy;

    this.db.prepare(
      'UPDATE swimlanes SET name = ?, description = ?, color = ?, icon = ?, position = ?, is_archived = ?, is_ghost = ?, permission_mode = ?, auto_spawn = ?, auto_command = ?, plan_exit_target_id = ?, agent_override = ?, model_override = ?, effort_override = ?, handoff_context = ?, session_target = ?, session_spawn_strategy = ? WHERE id = ?'
    ).run(updated.name, updated.description, updated.color, updated.icon, updated.position, updated.is_archived ? 1 : 0, updated.is_ghost ? 1 : 0, updated.permission_mode, updated.auto_spawn ? 1 : 0, updated.auto_command, updated.plan_exit_target_id, updated.agent_override, updated.model_override, updated.effort_override, updated.handoff_context ? 1 : 0, updated.session_target, updated.session_spawn_strategy, updated.id);

    return updated;
  }

  reorder(ids: string[]): void {
    // Build a map of id → role for validation
    const allLanes = this.db.prepare('SELECT id, role FROM swimlanes').all() as Array<{ id: string; role: string | null }>;
    const roleById = new Map(allLanes.map((l) => [l.id, l.role]));

    // Validate locked column constraints:
    // 1. 'todo' must be at position 0
    const todoId = allLanes.find((lane) => lane.role === 'todo')?.id;
    if (todoId && ids[0] !== todoId) {
      throw new Error('To Do column must remain at position 0.');
    }

    // 2. Custom columns (role=null) cannot be at position 0 (To Do slot)
    if (!roleById.get(ids[0])) {
      throw new Error('Custom columns cannot be at the first position.');
    }

    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE swimlanes SET position = ? WHERE id = ?');
      ids.forEach((id, index) => {
        stmt.run(index, id);
      });
    });
    tx();
  }

  delete(id: string): void {
    // Cannot delete system columns (backlog, done)
    const lane = this.getById(id);
    if (lane && lane.role) {
      throw new Error(`Cannot delete the ${lane.role} column.`);
    }

    const taskCount = this.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?').get(id) as { c: number };
    if (taskCount.c > 0) {
      throw new Error('Cannot delete swimlane with tasks. Move or delete tasks first.');
    }
    deleteSwimlaneRowWithReferences(this.db, id);
  }

  /** Mark a swimlane as a ghost column (removed from team config but has tasks). */
  setGhost(id: string, isGhost: boolean): void {
    this.db.prepare('UPDATE swimlanes SET is_ghost = ? WHERE id = ?').run(isGhost ? 1 : 0, id);
  }

  /** Delete empty ghost columns. Returns number of ghosts removed. */
  deleteEmptyGhosts(): number {
    const ghosts = this.db.prepare('SELECT id FROM swimlanes WHERE is_ghost = 1').all() as Array<{ id: string }>;
    let removed = 0;
    for (const ghost of ghosts) {
      const taskCount = this.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?').get(ghost.id) as { c: number };
      if (taskCount.c === 0) {
        deleteSwimlaneRowWithReferences(this.db, ghost.id);
        removed++;
      }
    }
    return removed;
  }

  private mapRow(row: SwimlaneRow): Swimlane {
    return {
      id: row.id,
      name: row.name,
      description: row.description || null,
      role: (row.role as SwimlaneRole) || null,
      position: row.position,
      color: row.color,
      icon: row.icon || null,
      is_archived: Boolean(row.is_archived),
      is_ghost: Boolean(row.is_ghost),
      permission_mode: (row.permission_mode as PermissionMode) ?? null,
      auto_spawn: Boolean(row.auto_spawn),
      auto_command: row.auto_command || null,
      plan_exit_target_id: row.plan_exit_target_id || null,
      agent_override: row.agent_override || null,
      model_override: row.model_override || null,
      effort_override: row.effort_override || null,
      handoff_context: Boolean(row.handoff_context),
      session_target: (row.session_target as SessionTarget) ?? 'main',
      session_spawn_strategy: (row.session_spawn_strategy as SessionSpawnStrategy) ?? 'create_or_resume',
      created_at: row.created_at,
    };
  }
}
