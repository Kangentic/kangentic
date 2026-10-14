import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  AutomationWriteInput,
  ColumnAutomation,
} from '../../../shared/types';
import { AUTOMATION_MANIFEST, isAutomationTrigger } from '../../../shared/automation-manifest';
import { conditionKindsAsStored } from '../../../shared/final-line-match';
import { columnNameKey } from '../../automations/move-target';
import { writeTransaction } from '../transaction';

interface AutomationRow {
  id: string;
  swimlane_id: string;
  name: string;
  type: string;
  trigger: string;
  position: number;
  enabled: number;
  config_json: string;
  condition: string | null;
  final_line: string | null;
  max_runs: number | null;
  created_at: string;
  updated_at: string;
}

/** What a caller hands `replaceForColumn`. `id` is kept when supplied, minted when not. */
export type { AutomationWriteInput };

export class AutomationRepository {
  constructor(private db: Database.Database) {}

  listAll(): ColumnAutomation[] {
    const rows = this.db
      .prepare('SELECT * FROM column_automations ORDER BY swimlane_id, trigger, position ASC')
      .all() as AutomationRow[];
    return mapRows(rows);
  }

  listForColumn(swimlaneId: string): ColumnAutomation[] {
    const rows = this.db
      .prepare('SELECT * FROM column_automations WHERE swimlane_id = ? ORDER BY trigger, position ASC')
      .all(swimlaneId) as AutomationRow[];
    return mapRows(rows);
  }

  /** One automation by id, or null. */
  getById(automationId: string): ColumnAutomation | null {
    const row = this.db
      .prepare('SELECT * FROM column_automations WHERE id = ?')
      .get(automationId) as AutomationRow | undefined;
    return row ? mapRow(row) : null;
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
    return mapRows(rows);
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
   * independently and the groups can never interleave. That is what makes the
   * file's arrays and the UI's groups the same thing as the DB's ordering,
   * rather than several orderings that have to be kept in step.
   */
  replaceForColumn(swimlaneId: string, automations: AutomationWriteInput[]): ColumnAutomation[] {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO column_automations
        (id, swimlane_id, name, type, trigger, position, enabled, config_json, condition, final_line, max_runs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = writeTransaction(this.db, () => {
      // Read the rows first so a row that survives the replace keeps the date it
      // was actually made on, not the date it was last saved.
      const existingRows = this.db.prepare(
        'SELECT id, name, type, trigger, created_at FROM column_automations WHERE swimlane_id = ?',
      ).all(swimlaneId) as Array<{ id: string; name: string; type: string; trigger: string; created_at: string }>;
      const existing = new Map(existingRows.map((row) => [row.id, row.created_at]));
      // A writer that carries no ids (the `kangentic.json` apply on every project
      // open, an agent's kangentic_set_automations) keeps the id of the row with
      // the same name, type and trigger. Frequency and "once per visit" count
      // runs by id, so a fresh id would hand every guarded row a clean slate.
      const idByIdentity = new Map(existingRows.map((row) => [automationIdentity(row.name, row.type, row.trigger), row.id]));
      const explicitIds = new Set(automations.flatMap((automation) => (automation.id ? [automation.id] : [])));
      const usedIds = new Set<string>();

      this.db.prepare('DELETE FROM column_automations WHERE swimlane_id = ?').run(swimlaneId);

      const nextPosition: Record<AutomationTrigger, number> = { enter: 0, turn_end: 0, exit: 0 };
      for (const automation of automations) {
        const kept = idByIdentity.get(automationIdentity(automation.name, automation.type, automation.trigger));
        const reusable = kept !== undefined && !explicitIds.has(kept) && !usedIds.has(kept) ? kept : undefined;
        const id = automation.id ?? reusable ?? randomUUID();
        usedIds.add(id);
        // One Condition kind per row, Text match on a turn end only. Every
        // writer already holds to this (the dialog, the file reader, MCP), so
        // this is the backstop, not the rule.
        const kinds = conditionKindsAsStored(automation);
        insert.run(
          id,
          swimlaneId,
          automation.name,
          automation.type,
          automation.trigger,
          nextPosition[automation.trigger],
          automation.enabled ? 1 : 0,
          JSON.stringify(automation.config ?? {}),
          kinds.condition,
          kinds.final_line,
          normalizeMaxRuns(automation.max_runs),
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

/**
 * Point every automation field that names a column (`kind: 'column'`, Move to
 * column's Column) at the column's new name. Run by `SwimlaneRepository.update`
 * inside the rename's own transaction. The fields come from the manifest, so a
 * second type that names a column needs no change here.
 *
 * A stored name matches through `columnNameKey`, the function
 * `resolveMoveTarget` reads it back with, so a row that would move a task to
 * the old column follows the rename. The match runs here, not in SQL: SQLite's
 * TRIM and LOWER know only ASCII, so padding JavaScript trims (a no-break
 * space) or a letter only it lowercases would leave the row on the old name.
 */
export function renameAutomationColumnReferences(db: Database.Database, oldName: string, newName: string): number {
  const oldKey = columnNameKey(oldName);
  const update = db.prepare('UPDATE column_automations SET config_json = json_set(config_json, ?, ?) WHERE id = ?');
  let changed = 0;
  for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
    for (const field of entry.fields) {
      if (field.kind !== 'column') continue;
      const path = `$.${field.key}`;
      const rows = db
        .prepare('SELECT id, json_extract(config_json, ?) AS target FROM column_automations WHERE type = ? AND json_valid(config_json)')
        .all(path, type) as Array<{ id: string; target: string | number | bigint | null }>;
      for (const row of rows) {
        if (row.target === null || columnNameKey(String(row.target)) !== oldKey) continue;
        changed += update.run(path, newName, row.id).changes;
      }
    }
  }
  return changed;
}

/** A blank or whitespace-only Condition is no Condition: the row always runs. */
export function normalizeCondition(condition: string | null | undefined): string | null {
  if (typeof condition !== 'string') return null;
  const trimmed = condition.trim();
  return trimmed ? trimmed : null;
}

/**
 * A Text match as stored: trimmed, a blank one is none, and none off a turn
 * end, the only trigger with a final message to read.
 */
export function normalizeFinalLine(finalLine: string | null | undefined, trigger: string): string | null {
  if (trigger !== 'turn_end' || typeof finalLine !== 'string') return null;
  const trimmed = finalLine.trim();
  return trimmed ? trimmed : null;
}

/** What makes a row in a column "the same automation" when a writer carries no id. Names are unique per column. */
function automationIdentity(name: string, type: string, trigger: string): string {
  return `${name}\n${type}\n${trigger}`;
}

/** A Frequency limit as written is one a writer accepts unchanged: a whole number of at least 1. */
export function isWholeMaxRuns(maxRuns: number): boolean {
  return Number.isInteger(maxRuns) && maxRuns >= 1;
}

/** The Frequency limit as stored: a number is floored to a whole one, and below 1 or not a number is no limit. */
export function normalizeMaxRuns(maxRuns: number | null | undefined): number | null {
  if (typeof maxRuns !== 'number' || !Number.isFinite(maxRuns)) return null;
  const whole = Math.floor(maxRuns);
  return whole >= 1 ? whole : null;
}

/**
 * Rows whose trigger this build does not know are left out rather than read as
 * one it does. The old mapping turned anything that was not `'exit'` into
 * `'enter'`, so a turn-end row read by a missed path, or by an older build after
 * a downgrade, would have run every time a task entered the column.
 */
function mapRows(rows: AutomationRow[]): ColumnAutomation[] {
  const automations: ColumnAutomation[] = [];
  for (const row of rows) {
    const automation = mapRow(row);
    if (automation) automations.push(automation);
  }
  return automations;
}

function mapRow(row: AutomationRow): ColumnAutomation | null {
  if (!isAutomationTrigger(row.trigger)) {
    console.warn(`[automations] skipped automation ${row.id.slice(0, 8)} with an unknown trigger "${row.trigger}"`);
    return null;
  }
  return {
    id: row.id,
    swimlane_id: row.swimlane_id,
    name: row.name,
    type: row.type as AutomationType,
    trigger: row.trigger,
    position: row.position,
    enabled: row.enabled === 1,
    config: parseConfig(row.config_json),
    condition: normalizeCondition(row.condition),
    final_line: normalizeFinalLine(row.final_line, row.trigger),
    max_runs: normalizeMaxRuns(row.max_runs),
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
