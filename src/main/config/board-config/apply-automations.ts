import type {
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  BoardAutomationConfig,
  BoardColumnConfig,
} from '../../../shared/types';
import type { AutomationWriteInput } from '../../db/repositories/automation-repository';
import { AUTOMATION_MANIFEST, isAutomationType, isRetiredActionType } from '../../../shared/automation-manifest';
import { uniqueName } from '../../automations/column-message';

/**
 * Convert one column's `kangentic.json` entry into the automations it should
 * have, reading the new shape and the legacy one it replaced.
 *
 * This is the half of the migration the DB pass cannot do. `apply-config` runs
 * on EVERY project open, after the schema migration, and it writes whatever the
 * file says onto the lane. So a file still carrying `columns[].autoCommand`
 * would put the message back on `swimlanes.auto_command` immediately after the
 * migration cleared it, and the column would go quiet: nothing reads that field
 * any more. Converting on read is what makes a `git pull` from a teammate on an
 * older build, or simply a file that has not been rewritten yet, behave.
 */

export interface ColumnAutomationPlan {
  rows: AutomationWriteInput[];
  warnings: string[];
}

/**
 * Does this config declare automations anywhere? Decides whether a column with
 * no `automations` key means "none" or "leave what the database has".
 *
 * Same additive-vs-destructive rule the file already uses for columns and
 * actions: a hand-written config that has never mentioned automations must not
 * silently delete the ones a user built in the app.
 */
export function configDeclaresAutomations(columns: BoardColumnConfig[]): boolean {
  return columns.some((column) => column.automations !== undefined || column.autoCommand !== undefined);
}

/**
 * Does this file know the `automations` key at all?
 *
 * The rule above answers "is there anything to apply". This one answers a
 * different question: what an ABSENT key on a column MEANS. In a file the app
 * has written, absent means none, and clearing the column is the whole point of
 * deleting the key. In a file written by a build that predated automations,
 * absent means the writer had never heard of them, and clearing would delete
 * whatever the schema migration had just rescued from that board's transitions.
 *
 * `autoCommand` cannot be the signal, which is the bug this separates out: a
 * legacy board with three messages and one transition-borne script flipped the
 * whole config to "automation-aware" on the strength of the messages, and the
 * script's column, silent in the file, was emptied on the first open after the
 * upgrade. The script was gone before anyone opened the Column Manager.
 */
export function configIsAutomationAware(columns: BoardColumnConfig[]): boolean {
  return columns.some((column) => column.automations !== undefined);
}

export function planColumnAutomations(column: BoardColumnConfig): ColumnAutomationPlan {
  const warnings: string[] = [];
  const rows: AutomationWriteInput[] = [];

  if (column.automations) {
    // Names are unique PER COLUMN, across both groups, because that is what
    // `idx_column_automations_name` enforces. A hand-written or teammate-authored
    // file can easily carry "Notify" on enter and "Notify" on exit; left alone
    // that throws inside `applyBoardConfigToDb`'s transaction and fails the
    // WHOLE board reconcile on project open, not just this column. Renamed with
    // a warning instead, matching how every other malformed row in `readRow` is
    // handled: the file is reported, never allowed to take the board down.
    const takenNames: string[] = [];
    for (const trigger of ['enter', 'exit'] as const) {
      const group = trigger === 'enter' ? column.automations.onEnter : column.automations.onExit;
      for (const entry of group ?? []) {
        const row = readRow(entry, trigger, column.name, warnings);
        if (!row) continue;
        const deduped = uniqueName(row.name, takenNames);
        if (deduped !== row.name) {
          warnings.push(
            `"${column.name}" has more than one automation named "${row.name}". Renamed the later one to "${deduped}".`,
          );
          row.name = deduped;
        }
        takenNames.push(row.name);
        rows.push(row);
      }
    }
  }

  // The legacy message. Applied only when the column declares no automations of
  // its own, so a file carrying BOTH (mid-upgrade, or a hand edit) does not end
  // up with the message twice.
  const legacyMessage = column.autoCommand?.trim();
  if (legacyMessage && rows.length === 0) {
    rows.push({
      name: 'Message',
      type: 'send_message',
      trigger: 'enter',
      enabled: true,
      config: { message: legacyMessage, mode: column.autoCommandMode ?? 'immediate' },
    });
  }

  return { rows, warnings };
}

function readRow(
  entry: BoardAutomationConfig,
  trigger: AutomationTrigger,
  columnName: string,
  warnings: string[],
): AutomationWriteInput | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) {
    warnings.push(`An automation on "${columnName}" has no name. Skipped.`);
    return null;
  }

  const rawType = typeof entry.type === 'string' ? entry.type : '';

  // A retired type is WARNED and skipped, never a validation error. That
  // matches what this file already does with an unknown action, and what the
  // database migration does to the same row: each of the three was a no-op or a
  // duplicate of the move path, so dropping it changes no behavior. Failing the
  // whole config over one would take the board down with it.
  if (isRetiredActionType(rawType)) {
    warnings.push(`Automation "${name}" on "${columnName}" uses the retired type "${rawType}". Skipped.`);
    return null;
  }

  // The one type rename. `send_command` was wrong the moment its field became
  // `message`.
  const type = rawType === 'send_command' ? 'send_message' : rawType;
  if (!isAutomationType(type)) {
    warnings.push(`Automation "${name}" on "${columnName}" has an unknown type "${rawType}". Skipped.`);
    return null;
  }

  return {
    name,
    type: type as AutomationType,
    trigger,
    enabled: entry.enabled !== false,
    config: readConfig(entry, type as AutomationType),
  };
}

/** Read only the keys the type declares, so a stray key in a hand-edited file is dropped. */
function readConfig(entry: BoardAutomationConfig, type: AutomationType): AutomationConfig {
  const config: Record<string, unknown> = {};
  for (const field of AUTOMATION_MANIFEST[type].fields) {
    const value = entry[field.key];
    if (value !== undefined) config[field.key] = value;
  }
  // The legacy `send_command` payload key, so a hand-written file that predates
  // the rename still carries its message across.
  if (type === 'send_message' && config.message === undefined && typeof entry.command === 'string') {
    config.message = entry.command;
  }
  return config as AutomationConfig;
}
