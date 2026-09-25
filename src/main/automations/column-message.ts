/**
 * Writing a column's message to its agent as an automation.
 *
 * `swimlanes.auto_command` used to hold this, and the MCP column tools still
 * take an `autoCommand` parameter because that is the vocabulary skills were
 * written against. The field is gone from every read path, so the parameter has
 * to land on the row the engine actually delivers: the column's first
 * `send_message` row in its On enter group, which is exactly what
 * `resolveColumnMessage` picks.
 *
 * Without this the parameter wrote a column nothing reads and reported success,
 * which is the worst of the three silent-failure shapes this subsystem was built
 * to end: the caller is told it worked.
 */

import type { AutomationRepository, AutomationWriteInput } from '../db/repositories/automation-repository';
import type { AutoCommandMode, ColumnAutomation } from '../../shared/types';

/** The name a message row gets when the caller did not name one. */
const DEFAULT_MESSAGE_NAME = 'Message';

export type ColumnMessageWriteAction = 'created' | 'updated' | 'cleared' | 'unchanged';

export interface ColumnMessageWriteResult {
  action: ColumnMessageWriteAction;
  /** The row's name, so a caller can say which automation it wrote. Null when nothing exists. */
  name: string | null;
}

/**
 * Point a column's message at `message`, or clear it with null or an empty
 * string.
 *
 * Targets the first `send_message` enter row by position whether or not it is
 * switched ON, and switches it on when writing. Skipping a disabled row would
 * make the call quietly build a SECOND message row beside one the user turned
 * off, and the engine would then deliver neither the old one nor, necessarily,
 * the new one's position. Asking for a message is asking for it to be sent.
 */
export function setColumnMessage(
  automations: AutomationRepository,
  swimlaneId: string,
  message: string | null,
  mode?: AutoCommandMode,
): ColumnMessageWriteResult {
  const rows = automations.listForColumn(swimlaneId);
  const target = firstMessageRow(rows);
  const trimmed = (message ?? '').trim();

  if (!trimmed) {
    if (!target) return { action: 'unchanged', name: null };
    automations.replaceForColumn(swimlaneId, rows.filter((row) => row.id !== target.id).map(toWriteInput));
    return { action: 'cleared', name: target.name };
  }

  if (target) {
    const next = rows.map((row) => (row.id === target.id
      ? {
          ...toWriteInput(row),
          enabled: true,
          // `command` is the legacy `send_command` key. Dropped here rather
          // than carried, so the row stops having two message fields the
          // moment anyone edits it.
          config: { message: trimmed, mode: mode ?? row.config.mode ?? 'immediate' },
        }
      : toWriteInput(row)));
    automations.replaceForColumn(swimlaneId, next);
    return { action: 'updated', name: target.name };
  }

  const name = uniqueName(DEFAULT_MESSAGE_NAME, rows.map((row) => row.name));
  automations.replaceForColumn(swimlaneId, [
    ...rows.map(toWriteInput),
    { name, type: 'send_message', trigger: 'enter', enabled: true, config: { message: trimmed, mode: mode ?? 'immediate' } },
  ]);
  return { action: 'created', name };
}

/**
 * Change WHEN the column's message is delivered, leaving its text alone.
 *
 * Split out from `setColumnMessage` rather than folded into it because the two
 * callers differ: setting a message is asking for it to be sent (so that path
 * switches the row on), while setting a delivery mode says nothing about
 * whether the message should run, so this one leaves `enabled` as it found it.
 *
 * It exists at all because `autoCommandMode` alone used to write only
 * `swimlanes.auto_command_mode`, which the automations migration resets and no
 * delivery path reads. The caller was told it worked and nothing changed, which
 * is the exact failure this module's own header calls the worst of the three.
 *
 * Targets the same row `setColumnMessage` does, NOT the one
 * `resolveColumnMessage` returns: that one filters on `enabled`, so reading the
 * text back through it and re-writing it could land on a different row.
 */
export function setColumnMessageMode(
  automations: AutomationRepository,
  swimlaneId: string,
  mode: AutoCommandMode,
): ColumnMessageWriteResult {
  const rows = automations.listForColumn(swimlaneId);
  const target = firstMessageRow(rows);
  if (!target) return { action: 'unchanged', name: null };
  if ((target.config.mode ?? 'immediate') === mode) return { action: 'unchanged', name: target.name };

  automations.replaceForColumn(swimlaneId, rows.map((row) => (row.id === target.id
    ? { ...toWriteInput(row), config: { ...row.config, mode } }
    : toWriteInput(row))));
  return { action: 'updated', name: target.name };
}

/**
 * The row `resolveColumnMessage` would deliver, ignoring its `enabled` filter.
 * Position order, because that is the order the group runs in and the order the
 * Column Manager shows.
 */
function firstMessageRow(rows: ColumnAutomation[]): ColumnAutomation | null {
  return [...rows]
    .filter((row) => row.type === 'send_message' && row.trigger === 'enter')
    .sort((left, right) => left.position - right.position)[0] ?? null;
}

/**
 * `replaceForColumn` takes the whole column, so every untouched row has to come
 * back through with its id. Dropping an id would mint a new one and lose that
 * row's `created_at` and its run history's tie to it.
 */
function toWriteInput(row: ColumnAutomation): AutomationWriteInput {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    trigger: row.trigger,
    enabled: row.enabled,
    config: row.config,
  };
}

/**
 * A name no other row on the column holds. The unique index is
 * `COLLATE NOCASE`, so the comparison folds case here too or the insert throws
 * on a column that already has a "message".
 */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}
