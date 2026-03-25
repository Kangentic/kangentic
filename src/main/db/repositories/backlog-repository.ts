import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  BacklogItem,
  BacklogItemCreateInput,
  BacklogItemUpdateInput,
} from '../../../shared/types';

/** Row shape as stored in SQLite (labels is a JSON string). */
interface BacklogItemRow {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string;
  position: number;
  assignee: string | null;
  due_date: string | null;
  item_type: string | null;
  external_id: string | null;
  external_source: string | null;
  external_url: string | null;
  sync_status: string | null;
  external_metadata: string | null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: BacklogItemRow): BacklogItem {
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labels);
  } catch { /* default to empty */ }
  let externalMetadata: Record<string, unknown> | null = null;
  if (row.external_metadata) {
    try {
      externalMetadata = JSON.parse(row.external_metadata);
    } catch { /* default to null */ }
  }
  return {
    ...row,
    priority: row.priority,
    labels,
    external_metadata: externalMetadata,
  };
}

export class BacklogRepository {
  constructor(private db: Database.Database) {}

  list(): BacklogItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM backlog_items ORDER BY position ASC'
    ).all() as BacklogItemRow[];
    return rows.map(rowToItem);
  }

  getById(id: string): BacklogItem | undefined {
    const row = this.db.prepare(
      'SELECT * FROM backlog_items WHERE id = ?'
    ).get(id) as BacklogItemRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  create(input: BacklogItemCreateInput): BacklogItem {
    const now = new Date().toISOString();
    const id = uuidv4();
    const maxPos = this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) as max FROM backlog_items'
    ).get() as { max: number };
    const position = maxPos.max + 1;

    const row: BacklogItemRow = {
      id,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 0,
      labels: JSON.stringify(input.labels ?? []),
      position,
      assignee: input.assignee ?? null,
      due_date: input.dueDate ?? null,
      item_type: input.itemType ?? null,
      external_id: input.externalId ?? null,
      external_source: input.externalSource ?? null,
      external_url: input.externalUrl ?? null,
      sync_status: input.syncStatus ?? null,
      external_metadata: input.externalMetadata ? JSON.stringify(input.externalMetadata) : null,
      attachment_count: 0,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO backlog_items (id, title, description, priority, labels, position, assignee, due_date, item_type, external_id, external_source, external_url, sync_status, external_metadata, attachment_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.title, row.description, row.priority, row.labels, row.position,
      row.assignee, row.due_date, row.item_type,
      row.external_id, row.external_source, row.external_url, row.sync_status,
      row.external_metadata, row.attachment_count, row.created_at, row.updated_at,
    );

    return rowToItem(row);
  }

  update(input: BacklogItemUpdateInput): BacklogItem {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Backlog item ${input.id} not found`);

    const now = new Date().toISOString();
    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const priority = input.priority ?? existing.priority;
    const labels = input.labels ?? existing.labels;

    this.db.prepare(`
      UPDATE backlog_items
      SET title = ?, description = ?, priority = ?, labels = ?, updated_at = ?
      WHERE id = ?
    `).run(title, description, priority, JSON.stringify(labels), now, input.id);

    return {
      ...existing,
      title,
      description,
      priority,
      labels,
      updated_at: now,
    };
  }

  delete(id: string): void {
    const item = this.getById(id);
    if (!item) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM backlog_items WHERE id = ?').run(id);
      // Shift positions down for items after the deleted one
      this.db.prepare(
        'UPDATE backlog_items SET position = position - 1 WHERE position > ?'
      ).run(item.position);
    })();
  }

  reorder(ids: string[]): void {
    const updatePosition = this.db.prepare(
      'UPDATE backlog_items SET position = ? WHERE id = ?'
    );
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        updatePosition.run(index, id);
      });
    })();
  }

  bulkDelete(ids: string[]): void {
    if (ids.length === 0) return;
    this.db.transaction(() => {
      const deleteStmt = this.db.prepare('DELETE FROM backlog_items WHERE id = ?');
      for (const id of ids) {
        deleteStmt.run(id);
      }
      // Resequence all positions to remove gaps
      const remaining = this.db.prepare(
        'SELECT id FROM backlog_items ORDER BY position ASC'
      ).all() as Array<{ id: string }>;
      const updatePosition = this.db.prepare(
        'UPDATE backlog_items SET position = ? WHERE id = ?'
      );
      remaining.forEach((row, index) => {
        updatePosition.run(index, row.id);
      });
    })();
  }

  /** Rename a label across all backlog items. Returns count of modified items. */
  renameLabel(oldName: string, newName: string): number {
    const allItems = this.db.prepare(
      'SELECT id, labels FROM backlog_items'
    ).all() as Array<{ id: string; labels: string }>;

    let modifiedCount = 0;
    const now = new Date().toISOString();
    const updateStatement = this.db.prepare(
      'UPDATE backlog_items SET labels = ?, updated_at = ? WHERE id = ?'
    );

    this.db.transaction(() => {
      for (const row of allItems) {
        let labels: string[];
        try { labels = JSON.parse(row.labels); } catch { continue; }
        const index = labels.indexOf(oldName);
        if (index === -1) continue;
        labels[index] = newName;
        // Deduplicate in case newName already exists
        const unique = [...new Set(labels)];
        updateStatement.run(JSON.stringify(unique), now, row.id);
        modifiedCount++;
      }
    })();

    return modifiedCount;
  }

  /** Remove a label from all backlog items. Returns count of modified items. */
  deleteLabel(name: string): number {
    const allItems = this.db.prepare(
      'SELECT id, labels FROM backlog_items'
    ).all() as Array<{ id: string; labels: string }>;

    let modifiedCount = 0;
    const now = new Date().toISOString();
    const updateStatement = this.db.prepare(
      'UPDATE backlog_items SET labels = ?, updated_at = ? WHERE id = ?'
    );

    this.db.transaction(() => {
      for (const row of allItems) {
        let labels: string[];
        try { labels = JSON.parse(row.labels); } catch { continue; }
        const filtered = labels.filter((label) => label !== name);
        if (filtered.length === labels.length) continue;
        updateStatement.run(JSON.stringify(filtered), now, row.id);
        modifiedCount++;
      }
    })();

    return modifiedCount;
  }

  /** Remap item priorities using a mapping of old index -> new index. */
  remapPriorities(mapping: Record<number, number>): number {
    const allItems = this.db.prepare(
      'SELECT id, priority FROM backlog_items'
    ).all() as Array<{ id: string; priority: number }>;

    let modifiedCount = 0;
    const now = new Date().toISOString();
    const updateStatement = this.db.prepare(
      'UPDATE backlog_items SET priority = ?, updated_at = ? WHERE id = ?'
    );

    this.db.transaction(() => {
      for (const row of allItems) {
        const newPriority = mapping[row.priority];
        if (newPriority !== undefined && newPriority !== row.priority) {
          updateStatement.run(newPriority, now, row.id);
          modifiedCount++;
        }
      }
    })();

    return modifiedCount;
  }

  /** Find which external IDs from a given source are already imported. */
  findByExternalIds(source: string, externalIds: string[]): Set<string> {
    if (externalIds.length === 0) return new Set();
    const placeholders = externalIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT external_id FROM backlog_items WHERE external_source = ? AND external_id IN (${placeholders})`
    ).all(source, ...externalIds) as Array<{ external_id: string }>;
    return new Set(rows.map((row) => row.external_id));
  }

  /** Create a backlog item from an existing task's title/description. */
  createFromTask(
    title: string,
    description: string,
    priority?: number,
    labels?: string[],
  ): BacklogItem {
    return this.create({
      title,
      description,
      priority: priority ?? 0,
      labels: labels ?? [],
    });
  }
}
