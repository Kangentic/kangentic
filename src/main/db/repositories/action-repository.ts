import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Action, ActionCreateInput, ActionUpdateInput, SwimlaneTransition } from '../../../shared/types';
import { writeTransaction } from '../transaction';

/** Raw row shape returned by better-sqlite3 for the actions table. */
interface ActionRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
  created_at: string;
}

export class ActionRepository {
  constructor(private db: Database.Database) {}

  list(): Action[] {
    const rows = this.db.prepare('SELECT * FROM actions ORDER BY name ASC').all() as ActionRow[];
    return rows.map(this.mapRow);
  }

  getById(id: string): Action | undefined {
    const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  create(input: ActionCreateInput & { id?: string }): Action {
    const now = new Date().toISOString();
    const id = input.id ?? uuidv4();
    const action: Action = {
      id,
      name: input.name,
      type: input.type,
      config_json: input.config_json,
      created_at: now,
    };
    this.db.prepare(
      'INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(action.id, action.name, action.type, action.config_json, action.created_at);
    return action;
  }

  update(input: ActionUpdateInput): Action {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Action ${input.id} not found`);

    const updated = { ...existing };
    if (input.name !== undefined) updated.name = input.name;
    if (input.type !== undefined) updated.type = input.type;
    if (input.config_json !== undefined) updated.config_json = input.config_json;

    this.db.prepare(
      'UPDATE actions SET name = ?, type = ?, config_json = ? WHERE id = ?'
    ).run(updated.name, updated.type, updated.config_json, updated.id);
    return updated;
  }

  private mapRow(row: ActionRow): Action {
    return {
      id: row.id,
      name: row.name,
      type: row.type as Action['type'],
      config_json: row.config_json,
      created_at: row.created_at,
    };
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM swimlane_transitions WHERE action_id = ?').run(id);
    this.db.prepare('DELETE FROM actions WHERE id = ?').run(id);
  }

  // Transition management
  listTransitions(): SwimlaneTransition[] {
    return this.db.prepare('SELECT * FROM swimlane_transitions ORDER BY from_swimlane_id, to_swimlane_id, execution_order').all() as SwimlaneTransition[];
  }

  getTransitionsFor(fromId: string, toId: string): SwimlaneTransition[] {
    // Exact match takes priority; fall back to wildcard '*' source
    const exact = this.db.prepare(
      'SELECT * FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ? ORDER BY execution_order'
    ).all(fromId, toId) as SwimlaneTransition[];
    if (exact.length > 0) return exact;
    return this.db.prepare(
      "SELECT * FROM swimlane_transitions WHERE from_swimlane_id = '*' AND to_swimlane_id = ? ORDER BY execution_order"
    ).all(toId) as SwimlaneTransition[];
  }

  /** Returns the set of swimlane IDs that have spawn_agent transitions targeting them. */
  getAgentSwimlaneIds(): Set<string> {
    const transitions = this.listTransitions();
    const actions = this.list();
    const ids = new Set<string>();
    for (const t of transitions) {
      const action = actions.find((a) => a.id === t.action_id);
      if (action?.type === 'spawn_agent') {
        ids.add(t.to_swimlane_id);
      }
    }
    return ids;
  }

  setTransitions(fromId: string, toId: string, actionIds: string[]): void {
    const tx = writeTransaction(this.db, () => {
      this.db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ?').run(fromId, toId);
      const insert = this.db.prepare(
        'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)'
      );
      actionIds.forEach((actionId, order) => {
        insert.run(uuidv4(), fromId, toId, actionId, order);
      });
    });
    tx();
  }
}
