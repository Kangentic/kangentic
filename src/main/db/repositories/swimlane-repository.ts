import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Swimlane, SwimlaneCreateInput, SwimlaneUpdateInput } from '../../../shared/types';

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
    const maxPos = this.db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM swimlanes').get() as { max: number };

    const swimlane: Swimlane = {
      id,
      name: input.name,
      position: maxPos.max + 1,
      color: input.color || '#3b82f6',
      is_terminal: input.is_terminal || false,
      created_at: now,
    };

    this.db.prepare(
      'INSERT INTO swimlanes (id, name, position, color, is_terminal, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(swimlane.id, swimlane.name, swimlane.position, swimlane.color, swimlane.is_terminal ? 1 : 0, swimlane.created_at);

    return swimlane;
  }

  update(input: SwimlaneUpdateInput): Swimlane {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Swimlane ${input.id} not found`);

    const updated = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.color !== undefined) updated.color = input.color;
    if (input.position !== undefined) updated.position = input.position;
    if (input.is_terminal !== undefined) updated.is_terminal = input.is_terminal;

    this.db.prepare(
      'UPDATE swimlanes SET name = ?, color = ?, position = ?, is_terminal = ? WHERE id = ?'
    ).run(updated.name, updated.color, updated.position, updated.is_terminal ? 1 : 0, updated.id);

    return updated;
  }

  reorder(ids: string[]): void {
    // System columns (positions 0, 1, 2) must keep their positions
    const systemLanes = this.db.prepare('SELECT id, position FROM swimlanes WHERE position <= 2 ORDER BY position ASC').all() as Array<{ id: string; position: number }>;
    for (const lane of systemLanes) {
      if (ids[lane.position] !== lane.id) {
        throw new Error('System columns cannot be reordered.');
      }
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
    // Cannot delete system columns (positions 0, 1, 2)
    const lane = this.getById(id);
    if (lane && lane.position <= 2) {
      throw new Error('Cannot delete a system column.');
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
      is_terminal: Boolean(row.is_terminal),
    };
  }
}
