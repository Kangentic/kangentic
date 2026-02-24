import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Swimlane, SwimlaneCreateInput, SwimlaneUpdateInput, SwimlaneRole } from '../../../shared/types';

export class SwimlaneRepository {
  constructor(private db: Database.Database) {}

  list(): Swimlane[] {
    return this.db.prepare('SELECT * FROM swimlanes ORDER BY position ASC').all().map(this.mapRow) as Swimlane[];
  }

  getById(id: string): Swimlane | undefined {
    const row = this.db.prepare('SELECT * FROM swimlanes WHERE id = ?').get(id);
    return row ? this.mapRow(row) : undefined;
  }

  create(input: SwimlaneCreateInput): Swimlane {
    const now = new Date().toISOString();
    const id = uuidv4();

    // Insert before the 'done' column (if any), otherwise at the end
    const doneCol = this.db.prepare(
      "SELECT position FROM swimlanes WHERE role = 'done' ORDER BY position ASC LIMIT 1"
    ).get() as { position: number } | undefined;

    let insertPos: number;
    if (doneCol) {
      insertPos = doneCol.position;
      // Shift done column (and anything after) up by one
      this.db.prepare('UPDATE swimlanes SET position = position + 1 WHERE position >= ?').run(insertPos);
    } else {
      const maxPos = this.db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM swimlanes').get() as { max: number };
      insertPos = maxPos.max + 1;
    }

    const swimlane: Swimlane = {
      id,
      name: input.name,
      role: null,
      position: insertPos,
      color: input.color || '#3b82f6',
      icon: input.icon || null,
      is_terminal: input.is_terminal || false,
      created_at: now,
    };

    this.db.prepare(
      'INSERT INTO swimlanes (id, name, role, position, color, icon, is_terminal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(swimlane.id, swimlane.name, swimlane.role, swimlane.position, swimlane.color, swimlane.icon, swimlane.is_terminal ? 1 : 0, swimlane.created_at);

    return swimlane;
  }

  update(input: SwimlaneUpdateInput): Swimlane {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Swimlane ${input.id} not found`);

    const updated = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.color !== undefined) updated.color = input.color;
    if (input.icon !== undefined) updated.icon = input.icon;
    if (input.position !== undefined) updated.position = input.position;
    if (input.is_terminal !== undefined) updated.is_terminal = input.is_terminal;

    this.db.prepare(
      'UPDATE swimlanes SET name = ?, color = ?, icon = ?, position = ?, is_terminal = ? WHERE id = ?'
    ).run(updated.name, updated.color, updated.icon, updated.position, updated.is_terminal ? 1 : 0, updated.id);

    return updated;
  }

  reorder(ids: string[]): void {
    // Build a map of id → role for validation
    const allLanes = this.db.prepare('SELECT id, role FROM swimlanes').all() as Array<{ id: string; role: string | null }>;
    const roleById = new Map(allLanes.map((l) => [l.id, l.role]));

    // Validate locked column constraints:
    // 1. 'backlog' must be at position 0
    const backlogId = allLanes.find((l) => l.role === 'backlog')?.id;
    if (backlogId && ids[0] !== backlogId) {
      throw new Error('Backlog column must remain at position 0.');
    }

    // 2. 'planning' must be immediately before 'running'
    const planningId = allLanes.find((l) => l.role === 'planning')?.id;
    const runningId = allLanes.find((l) => l.role === 'running')?.id;
    if (planningId && runningId) {
      const planIdx = ids.indexOf(planningId);
      const runIdx = ids.indexOf(runningId);
      if (planIdx === -1 || runIdx === -1 || runIdx !== planIdx + 1) {
        throw new Error('Planning and Running columns must remain adjacent.');
      }
    }

    // 3. Custom columns (role=null) cannot be at position 0 (Backlog slot)
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
    // Cannot delete columns with a role (backlog, planning, running, done)
    const lane = this.getById(id);
    if (lane && lane.role) {
      throw new Error(`Cannot delete the ${lane.role} column.`);
    }

    const taskCount = this.db.prepare('SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?').get(id) as { c: number };
    if (taskCount.c > 0) {
      throw new Error('Cannot delete swimlane with tasks. Move or delete tasks first.');
    }
    this.db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?').run(id, id);
    this.db.prepare('DELETE FROM swimlanes WHERE id = ?').run(id);
  }

  private mapRow(row: any): Swimlane {
    return {
      ...row,
      role: row.role || null,
      icon: row.icon || null,
      is_terminal: Boolean(row.is_terminal),
    };
  }
}
