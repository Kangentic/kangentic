import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb } from '../database';
import type { ProjectGroup, ProjectGroupCreateInput } from '../../../shared/types';
import { writeTransaction } from '../transaction';

interface ProjectGroupRow {
  id: string;
  name: string;
  position: number;
  is_collapsed: number;
}

function rowToGroup(row: ProjectGroupRow): ProjectGroup {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    is_collapsed: row.is_collapsed === 1,
  };
}

export class ProjectGroupRepository {
  list(): ProjectGroup[] {
    const db = getGlobalDb();
    const rows = db.prepare('SELECT * FROM project_groups ORDER BY position ASC').all() as ProjectGroupRow[];
    return rows.map(rowToGroup);
  }

  create(input: ProjectGroupCreateInput): ProjectGroup {
    const db = getGlobalDb();
    const id = uuidv4();
    const maxPosition = db.prepare('SELECT MAX(position) as maxPos FROM project_groups').get() as { maxPos: number | null };
    const position = (maxPosition.maxPos ?? -1) + 1;
    db.prepare(
      'INSERT INTO project_groups (id, name, position, is_collapsed) VALUES (?, ?, ?, 0)'
    ).run(id, input.name, position);
    return { id, name: input.name, position, is_collapsed: false };
  }

  update(id: string, name: string): ProjectGroup {
    const db = getGlobalDb();
    db.prepare('UPDATE project_groups SET name = ? WHERE id = ?').run(name, id);
    const row = db.prepare('SELECT * FROM project_groups WHERE id = ?').get(id) as ProjectGroupRow;
    if (!row) throw new Error(`Project group not found: ${id}`);
    return rowToGroup(row);
  }

  delete(id: string): void {
    const db = getGlobalDb();
    const tx = writeTransaction(db, () => {
      // Move all projects in this group to ungrouped
      db.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(id);
      // Delete the group
      db.prepare('DELETE FROM project_groups WHERE id = ?').run(id);
      // Reindex positions
      const remaining = db.prepare('SELECT id FROM project_groups ORDER BY position ASC').all() as Array<{ id: string }>;
      const stmt = db.prepare('UPDATE project_groups SET position = ? WHERE id = ?');
      remaining.forEach((row, index) => {
        stmt.run(index, row.id);
      });
    });
    tx();
  }

  reorder(ids: string[]): void {
    const db = getGlobalDb();
    const tx = writeTransaction(db, () => {
      const stmt = db.prepare('UPDATE project_groups SET position = ? WHERE id = ?');
      ids.forEach((id, index) => {
        stmt.run(index, id);
      });
    });
    tx();
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const db = getGlobalDb();
    db.prepare('UPDATE project_groups SET is_collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, id);
  }
}
