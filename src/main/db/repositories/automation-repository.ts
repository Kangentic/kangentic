import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  ColumnAutomation,
} from '../../../shared/types';

interface AutomationRow {
  id: string;
  swimlane_id: string;
  name: string;
  type: string;
  trigger: string;
  position: number;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

/** What a caller hands `replaceForColumn`. `id` is kept when supplied, minted when not. */
export interface AutomationWriteInput {
  id?: string;
  name: string;
  type: AutomationType;
  trigger: AutomationTrigger;
  enabled: boolean;
  config: AutomationConfig;
}

export class AutomationRepository {
  constructor(private db: Database.Database) {}

  listAll(): ColumnAutomation[] {
    const rows = this.db
      .prepare('SELECT * FROM column_automations ORDER BY swimlane_id, trigger, position ASC')
      .all() as AutomationRow[];
    return rows.map(mapRow);
  }

  listForColumn(swimlaneId: string): ColumnAutomation[] {
    const rows = this.db
      .prepare('SELECT * FROM column_automations WHERE swimlane_id = ? ORDER BY trigger, position ASC')
      .all(swimlaneId) as AutomationRow[];
    return rows.map(mapRow);
  }

  /**
   * The rows the engine will actually run for one column on one trigger, in
   * order. Enabled only: a switched-off automation is skipped, and skipping it
   * here rather than in the engine is what keeps "what runs" a single query.
   */
  getForTrigger(swimlaneId: string, trigger: AutomationTrigger): ColumnAutomation[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM column_automations WHERE swimlane_id = ? AND trigger = ? AND enabled = 1 ORDER BY position ASC',
      )
      .all(swimlaneId, trigger) as AutomationRow[];
    return rows.map(mapRow);
  }

  /**
   * Replace a column's whole list in one transaction.
   *
   * Whole-column rather than per-row because the dialog edits a draft and saves
   * it: a reorder, a delete and an insert arrive together, and applying them as
   * separate statements would make the unique name index reject an intermediate
   * state that the final state does not have (swapping two names, for instance).
   *
   * `position` is assigned PER TRIGGER, so each group numbers from 0
   * independently and the two groups can never interleave. That is what makes
   * the file's two arrays and the UI's two groups the same thing as the DB's
   * ordering, rather than three orderings that have to be kept in step.
   */
  replaceForColumn(swimlaneId: string, automations: AutomationWriteInput[]): ColumnAutomation[] {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO column_automations
        (id, swimlane_id, name, type, trigger, position, enabled, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      // Read the created_at values first so a row that survives the replace
      // keeps the date it was actually made on, not the date it was last saved.
      const existing = new Map(
        (this.db.prepare('SELECT id, created_at FROM column_automations WHERE swimlane_id = ?').all(swimlaneId) as Array<{
          id: string;
          created_at: string;
        }>).map((row) => [row.id, row.created_at]),
      );

      this.db.prepare('DELETE FROM column_automations WHERE swimlane_id = ?').run(swimlaneId);

      const nextPosition: Record<AutomationTrigger, number> = { enter: 0, exit: 0 };
      for (const automation of automations) {
        const id = automation.id ?? randomUUID();
        insert.run(
          id,
          swimlaneId,
          automation.name,
          automation.type,
          automation.trigger,
          nextPosition[automation.trigger],
          automation.enabled ? 1 : 0,
          JSON.stringify(automation.config ?? {}),
          existing.get(id) ?? now,
          now,
        );
        nextPosition[automation.trigger] += 1;
      }
    });
    tx();

    return this.listForColumn(swimlaneId);
  }

  deleteForColumn(swimlaneId: string): void {
    this.db.prepare('DELETE FROM column_automations WHERE swimlane_id = ?').run(swimlaneId);
  }
}

function mapRow(row: AutomationRow): ColumnAutomation {
  return {
    id: row.id,
    swimlane_id: row.swimlane_id,
    name: row.name,
    type: row.type as AutomationType,
    trigger: row.trigger === 'exit' ? 'exit' : 'enter',
    position: row.position,
    enabled: row.enabled === 1,
    config: parseConfig(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseConfig(configJson: string): AutomationConfig {
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (parsed && typeof parsed === 'object') return parsed as AutomationConfig;
  } catch {
    // A malformed blob must not take the board down with it. An automation
    // whose config will not parse renders as an empty one and the dialog can
    // repair it, which beats a column that refuses to load.
    console.error('[automations] could not parse a config blob; treating it as empty');
  }
  return {};
}
