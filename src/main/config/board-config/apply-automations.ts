import type {
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  BoardAutomationConfig,
  BoardColumnConfig,
  TextMatchSource,
} from '../../../shared/types';
import type { AutomationWriteInput } from '../../db/repositories/automation-repository';
import { isWholeMaxRuns, normalizeCondition, normalizeMaxRuns } from '../../db/repositories/automation-repository';
import {
  AUTOMATION_MANIFEST,
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_FILE_KEYS,
  isAutomationType,
  isRetiredActionType,
  isTypeOfferedOnTrigger,
} from '../../../shared/automation-manifest';
import { englishText } from '../../../shared/i18n/english';
import { legacyTextMatch, normalizeTextMatch, textMatchCanMatch, unmatchablePattern } from '../../../shared/final-line-match';
import { uniqueName } from '../../automations/column-message';
import { isJsonObject, isMalformedList } from './config-helpers';

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
  /**
   * The column's `automations` value, or one of its groups, is the wrong
   * shape, so the file has said nothing usable about this column. The caller
   * must leave the column's rows alone rather than replace them with `rows`.
   */
  keepExisting: boolean;
}

/**
 * Is this `automations` value present but not an object? Null is not
 * malformed. It reads as a column that declares none, as it always has.
 */
function isMalformedAutomations(value: unknown): boolean {
  return value !== undefined && value !== null && !isJsonObject(value);
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
 *
 * A malformed value does not count either. `"automations": "x"` on one column
 * says nothing about the others, and counting it would clear every column the
 * file is silent about.
 */
export function configIsAutomationAware(columns: BoardColumnConfig[]): boolean {
  return columns.some((column) => column.automations !== undefined && !isMalformedAutomations(column.automations));
}

export function planColumnAutomations(column: BoardColumnConfig): ColumnAutomationPlan {
  const warnings: string[] = [];
  const rows: AutomationWriteInput[] = [];

  // Read the containers through `unknown`. The declared types are what the app
  // writes, but this came from JSON.parse. A group that is truthy and not a list
  // (`"onEnter": {}`, or one row written without brackets) threw "is not
  // iterable" out of the reconcile transaction (Sentry DESKTOP-1H), rolling back
  // the whole board apply. It is reported instead, and the column keeps what it
  // has. Planning it as empty would delete its rows, and on project open the
  // export that follows would write that deletion into the committed file.
  const automations: unknown = column.automations;
  if (isMalformedAutomations(automations)) {
    warnings.push(
      `In "${column.name}", automations must be an object with ${listFileKeys()} lists. Kept the column's current automations.`,
    );
    return { rows, warnings, keepExisting: true };
  }

  if (column.automations) {
    const fileAutomations = column.automations;
    const groups = Object.fromEntries(
      AUTOMATION_TRIGGERS.map((trigger) => [trigger, fileAutomations[AUTOMATION_TRIGGER_FILE_KEYS[trigger]]]),
    ) as Record<AutomationTrigger, unknown>;
    const malformedKeys = AUTOMATION_TRIGGERS
      .filter((trigger) => isMalformedList(groups[trigger]))
      .map((trigger) => AUTOMATION_TRIGGER_FILE_KEYS[trigger]);
    if (malformedKeys.length > 0) {
      const verb = malformedKeys.length === 1 ? 'must be a list' : 'must be lists';
      warnings.push(
        `In "${column.name}", ${malformedKeys.join(' and ')} ${verb}. Kept the column's current automations.`,
      );
      return { rows, warnings, keepExisting: true };
    }

    // Names are unique PER COLUMN, across both groups, because that is what
    // `idx_column_automations_name` enforces. A hand-written or teammate-authored
    // file can easily carry "Notify" on enter and "Notify" on exit; left alone
    // that throws inside `applyBoardConfigToDb`'s transaction and fails the
    // WHOLE board reconcile on project open, not just this column. Renamed with
    // a warning instead, matching how every other malformed row in `readRow` is
    // handled: the file is reported, never allowed to take the board down.
    const takenNames: string[] = [];
    for (const trigger of AUTOMATION_TRIGGERS) {
      const group = groups[trigger];
      if (!Array.isArray(group)) continue;
      for (const entry of group as unknown[]) {
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
  // A non-string `autoCommand` (`5`, `{}`) threw "trim is not a function" out
  // of the reconcile transaction, the same class as the containers above.
  const legacyMessage = typeof column.autoCommand === 'string' ? column.autoCommand.trim() : undefined;
  if (legacyMessage && rows.length === 0) {
    rows.push({
      name: 'Message',
      type: 'send_message',
      trigger: 'enter',
      enabled: true,
      config: { message: legacyMessage, mode: column.autoCommandMode ?? 'immediate' },
      final_line: null,
      text_match_source: 'agent',
    });
  }

  return { rows, warnings, keepExisting: false };
}

function readRow(
  rawEntry: unknown,
  trigger: AutomationTrigger,
  columnName: string,
  warnings: string[],
): AutomationWriteInput | null {
  // `"onEnter": [null]` used to throw reading `.name` off null.
  if (!isJsonObject(rawEntry)) {
    warnings.push(`An automation on "${columnName}" is not an object. Skipped.`);
    return null;
  }
  const entry = rawEntry as BoardAutomationConfig;

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

  // A type filed under a trigger it is not offered on (a Move to column row in
  // onEnter, written by hand) would run inside the move that triggered it.
  if (!isTypeOfferedOnTrigger(type, trigger)) {
    warnings.push(
      `Automation "${name}" on "${columnName}" is a ${englishText(AUTOMATION_MANIFEST[type].label)} row, which runs only in `
      + `${offeredFileKeys(type)}, not ${AUTOMATION_TRIGGER_FILE_KEYS[trigger]}. Skipped.`,
    );
    return null;
  }

  // A guard of the wrong type is read as off, and said so: a hand-edited
  // `"maxRuns": "3"` would otherwise let a review loop run without its limit
  // with nothing to tell anyone.
  const rawMaxRuns: unknown = entry.maxRuns;
  if (rawMaxRuns !== undefined && rawMaxRuns !== null && typeof rawMaxRuns !== 'number') {
    warnings.push(`Automation "${name}" on "${columnName}" has a maxRuns that is not a number. It runs without a limit.`);
  } else if (typeof rawMaxRuns === 'number' && !isWholeMaxRuns(rawMaxRuns)) {
    // A number the MCP writer refuses (0, -1, 2.5) is read, not refused, and said so.
    const readAs = normalizeMaxRuns(rawMaxRuns);
    warnings.push(
      `Automation "${name}" on "${columnName}" has a maxRuns of ${rawMaxRuns}, which is not a whole number of at least 1. `
      + (readAs === null ? 'It runs without a limit.' : `Its limit is read as ${readAs}.`),
    );
  }
  const { condition, finalLine, source } = readCondition(entry, trigger, `Automation "${name}" on "${columnName}"`, warnings);
  return {
    name,
    type: type as AutomationType,
    trigger,
    enabled: entry.enabled !== false,
    config: readConfig(entry, type as AutomationType),
    condition: finalLine === null ? condition : null,
    final_line: finalLine,
    text_match_source: finalLine === null ? 'agent' : source,
    max_runs: normalizeMaxRuns(typeof rawMaxRuns === 'number' ? rawMaxRuns : null),
  };
}

/**
 * A row's Condition, one kind of two:
 *
 * - `"condition": { "text": "..." | ["...", ...] }`, a Text match, one pattern
 *   per item, on a turn end only (the one trigger with a final message).
 * - `"condition": { "agent": "..." }`, an Agent evaluation.
 *
 * What older builds wrote still reads: a plain string under `condition` is an
 * Agent evaluation, and `finalLine` is a Text match whose leading `!` meant
 * nothing then and is taken off (`legacyTextMatch`). Anything else is read as
 * written by hand and said so, and the row runs without a Condition, except a
 * pattern no line can match, which is kept: without it the row would run at
 * every turn end.
 */
function readCondition(
  entry: BoardAutomationConfig,
  trigger: AutomationTrigger,
  rowLabel: string,
  warnings: string[],
): { condition: string | null; finalLine: string | null; source: TextMatchSource } {
  const rawCondition: unknown = entry.condition;
  const rawFinalLine: unknown = entry.finalLine;
  let condition: string | null = null;
  let objectText: string | null = null;
  let source: TextMatchSource = 'agent';
  const conditionIsObject = isJsonObject(rawCondition);

  if (typeof rawCondition === 'string') {
    condition = normalizeCondition(rawCondition);
  } else if (conditionIsObject) {
    const kinds = Object.keys(rawCondition);
    const kind = kinds.length === 1 ? kinds[0] : null;
    const value: unknown = kind === null ? undefined : rawCondition[kind];
    if (kind === 'agent') {
      if (typeof value === 'string') condition = normalizeCondition(value);
      else warnings.push(`${rowLabel} has a condition.agent that is not text. It runs without a condition.`);
    } else if (kind === 'text') {
      // The long form says whose message it reads (#1078):
      // `{ "from": "user" | "agent", "patterns": "..." | [...] }`.
      const longForm = isJsonObject(value) ? readTextMatchLongForm(value) : null;
      const lines = isJsonObject(value) ? longForm?.lines ?? null : textMatchValueLines(value);
      if (lines === null) {
        warnings.push(isJsonObject(value)
          ? `${rowLabel} has a condition.text that is not { "from": "agent" | "user", "patterns": ... }. It runs without a condition.`
          : `${rowLabel} has a condition.text that is not text or a list of text. It runs without a condition.`);
      } else {
        objectText = readTextMatch(lines.join('\n'), 'condition.text', trigger, rowLabel, warnings);
        if (objectText !== null) source = longForm?.source ?? 'agent';
      }
    } else {
      warnings.push(`${rowLabel} has a condition that is not { "text": ... } or { "agent": ... }. It runs without one.`);
    }
  } else if (rawCondition !== undefined && rawCondition !== null) {
    warnings.push(`${rowLabel} has a condition that is not text or an object. It runs without one.`);
  }

  let legacyText: string | null = null;
  if (rawFinalLine !== undefined && rawFinalLine !== null && typeof rawFinalLine !== 'string') {
    warnings.push(`${rowLabel} has a finalLine that is not text. It runs without one.`);
  } else if (typeof rawFinalLine === 'string' && rawFinalLine.trim() !== '') {
    legacyText = readTextMatch(legacyTextMatch(rawFinalLine), 'finalLine', trigger, rowLabel, warnings);
  }

  // One kind per row. A written shape that gave a Condition wins over the old
  // key; between the two old keys, the Text match wins, as it always did. An
  // object that gave none (malformed, blank, or a Text match off a turn end)
  // leaves the finalLine in charge, so a bad edit never unguards the row.
  const objectGaveCondition = objectText !== null || (conditionIsObject && condition !== null);
  if (legacyText !== null && (objectGaveCondition || condition !== null)) {
    const kept = objectGaveCondition ? 'the condition' : 'the finalLine';
    warnings.push(`${rowLabel} has both a condition and a finalLine. A row holds one kind of condition, so it keeps ${kept}.`);
  }
  const finalLine = objectText ?? (objectGaveCondition ? null : legacyText);
  // A legacy finalLine is always the agent's line.
  return { condition: finalLine === null ? condition : null, finalLine, source: objectText !== null ? source : 'agent' };
}

/**
 * The long form of `condition.text`: whose message it reads and its patterns.
 * Null when `from` is missing or unknown, a key is extra, or `patterns` is not
 * text or a list of text: the row then runs without a condition, as any other
 * malformed condition does.
 */
function readTextMatchLongForm(value: Record<string, unknown>): { source: TextMatchSource; lines: string[] } | null {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'from' && key !== 'patterns')) return null;
  const from: unknown = value.from;
  if (from !== 'agent' && from !== 'user') return null;
  const lines = textMatchValueLines(value.patterns);
  return lines === null ? null : { source: from, lines };
}

/** A `condition.text` value as pattern lines: a string, or a list of strings, else null. */
function textMatchValueLines(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) return value;
  return null;
}

/**
 * A Text match read from the file, normalized, or null. Off a turn end it is
 * dropped and said so. A pattern no line can match is kept and said so.
 */
function readTextMatch(
  text: string,
  key: 'finalLine' | 'condition.text',
  trigger: AutomationTrigger,
  rowLabel: string,
  warnings: string[],
): string | null {
  const normalized = normalizeTextMatch(text);
  if (normalized === null) return null;
  if (trigger !== 'turn_end') {
    warnings.push(
      `${rowLabel} has a ${key} in ${AUTOMATION_TRIGGER_FILE_KEYS[trigger]}. `
      + `A text match reads the agent's last message, so it works in ${AUTOMATION_TRIGGER_FILE_KEYS.turn_end} only. It runs without it.`,
    );
    return null;
  }
  const unmatchable = unmatchablePattern(normalized);
  if (!textMatchCanMatch(normalized)) {
    warnings.push(`${rowLabel} has a ${key} with no letter, number or *, so no last line can match it and the row never runs.`);
  } else if (unmatchable !== null) {
    warnings.push(`${rowLabel} has a ${key} pattern "${unmatchable}" with no letter, number or *, so it can never match.`);
  }
  return normalized;
}

/** "onEnter, onTurnEnd and onExit", from the one trigger list. */
function listFileKeys(): string {
  const keys = AUTOMATION_TRIGGERS.map((trigger) => AUTOMATION_TRIGGER_FILE_KEYS[trigger]);
  return `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/** The file keys a type may be filed under. */
function offeredFileKeys(type: AutomationType): string {
  return AUTOMATION_TRIGGERS
    .filter((trigger) => isTypeOfferedOnTrigger(type, trigger))
    .map((trigger) => AUTOMATION_TRIGGER_FILE_KEYS[trigger])
    .join(' or ');
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
