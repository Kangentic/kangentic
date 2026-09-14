/**
 * Automation tools: read a column's automations, replace them, read the run
 * log, and re-run one row.
 *
 * These exist because a column's behavior moved out of two swimlane fields and
 * into an ordered list of typed rows. Without them an agent can read a column's
 * name and color but not what happens when a task lands in it, and the only
 * write it has is the single `autoCommand` message, which is a quarter of the
 * model at most.
 *
 * Addressed by COLUMN NAME throughout, matching every other board tool: a name
 * is what an agent can read out of a listing and the only key that means
 * anything when copying between projects.
 */

import { AutomationRepository, type AutomationWriteInput } from '../../db/repositories/automation-repository';
import { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import {
  AUTOMATION_MANIFEST,
  canColumnRun,
  isAutomationType,
  isRetiredActionType,
  stableAutomationTypes,
} from '../../../shared/automation-manifest';
import { describeAutomation } from '../../../shared/automation-describe';
import { resolveColumn, listActiveSwimlanes } from './column-resolver';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type {
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  ColumnAutomation,
} from '../../../shared/types';

/** How many run rows one read returns before the caller has to narrow. */
const RUN_HISTORY_LIMIT = 50;

export const handleListAutomations: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const db = context.getProjectDb();
  const automationRepo = new AutomationRepository(db);

  // One column, or the whole board. A board-wide read is the normal first call:
  // "what does this board do" is the question, and per-column paging would make
  // an agent issue one call per column to answer it.
  let columns = listActiveSwimlanes(db);
  if (params.column !== undefined && params.column !== null) {
    const resolution = resolveColumn(db, String(params.column), 'todo', { includeArchivedDone: true });
    if ('error' in resolution) return { success: false, error: resolution.error };
    columns = [resolution.swimlane];
  }

  const lines: string[] = [];
  const data: Array<Record<string, unknown>> = [];

  for (const column of columns) {
    const rows = automationRepo.listForColumn(column.id);
    if (rows.length === 0) {
      lines.push(`${column.name}: no automations.`);
      continue;
    }
    lines.push(`${column.name}:`);
    for (const trigger of ['enter', 'exit'] as const) {
      const group = rows
        .filter((row) => row.trigger === trigger)
        .sort((left, right) => left.position - right.position);
      if (group.length === 0) continue;
      lines.push(`  On ${trigger}:`);
      for (const row of group) {
        // `canColumnRun` is the same predicate the runner uses, so a row this
        // says is blocked is a row that will be recorded skipped. Reporting it
        // here is what stops an agent writing a message onto a column whose
        // agent never starts and believing it took effect.
        const runnable = canColumnRun(row.type, { autoSpawn: column.auto_spawn, role: column.role }, row.trigger);
        const flags = [
          row.enabled ? null : 'switched off',
          runnable.ok ? null : `cannot run: ${runnable.reason}`,
        ].filter((flag): flag is string => flag !== null);
        lines.push(
          `    ${row.position + 1}. ${row.name} (${row.type}) ${describeAutomation(row.type, row.config)}`
          + (flags.length > 0 ? ` [${flags.join('; ')}]` : ''),
        );
      }
    }
    data.push(...rows.map((row) => serializeRow(row, column.name)));
  }

  return {
    success: true,
    message: lines.length > 0 ? lines.join('\n') : 'This board has no automations.',
    data: { automations: data },
  };
};

export const handleSetAutomations: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;
  if (!columnName) return { success: false, error: 'column is required' };

  const db = context.getProjectDb();
  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in resolution) return { success: false, error: resolution.error };
  const { swimlane } = resolution;

  const rawRows = params.automations;
  if (!Array.isArray(rawRows)) {
    return {
      success: false,
      error: 'automations is required and must be an array. Pass [] to remove every automation on this column.',
    };
  }

  const parsed: AutomationWriteInput[] = [];
  const names = new Set<string>();
  const warnings: string[] = [];

  // Ids this column already owns. A supplied id is honored only if it is one of
  // these: `replaceForColumn` deletes THIS column's rows and then inserts with
  // whatever id it is given, so an id belonging to another column's row (or
  // repeated twice in one payload) hits the PRIMARY KEY and the agent gets a
  // raw SQLite string back. That is the likeliest call these tools will ever
  // see, because copying a column's list is `list_automations` then
  // `set_automations` with the ids carried through, which is exactly what the
  // tool description tells an agent to do.
  const ownIds = new Set(new AutomationRepository(db).listForColumn(swimlane.id).map((row) => row.id));
  const usedIds = new Set<string>();

  for (let index = 0; index < rawRows.length; index += 1) {
    const entry = rawRows[index] as Record<string, unknown> | null;
    const where = `automations[${index}]`;
    if (!entry || typeof entry !== 'object') {
      return { success: false, error: `${where} is not an object. Nothing was saved.` };
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      return { success: false, error: `${where} has no name. Every automation needs one. Nothing was saved.` };
    }
    // The unique index is COLLATE NOCASE, so a case-only difference is a
    // duplicate at the database and has to be refused here, where the caller
    // can still be told which row.
    const key = name.toLowerCase();
    if (names.has(key)) {
      return {
        success: false,
        error: `${where}: "${name}" repeats a name already used on this column. Names are unique per column, ignoring case. Nothing was saved.`,
      };
    }
    names.add(key);

    const rawType = typeof entry.type === 'string' ? entry.type : '';
    if (isRetiredActionType(rawType)) {
      return {
        success: false,
        error: `${where}: "${rawType}" is a retired type and Kangentic no longer runs it. `
          + `Valid types: ${stableAutomationTypes().join(', ')}. Nothing was saved.`,
      };
    }
    // The one type rename: `send_command` was wrong the moment its field
    // became `message`. Accepted on write so an older skill still lands.
    const type = rawType === 'send_command' ? 'send_message' : rawType;
    if (!isAutomationType(type)) {
      return {
        success: false,
        error: `${where}: unknown type "${rawType}". Valid types: ${stableAutomationTypes().join(', ')}. Nothing was saved.`,
      };
    }
    if (AUTOMATION_MANIFEST[type as AutomationType].status === 'legacy') {
      return {
        success: false,
        error: `${where}: "${type}" is a legacy type that cannot be created. `
          + `It survives only on boards that already had one. Valid types: ${stableAutomationTypes().join(', ')}. Nothing was saved.`,
      };
    }

    const trigger: AutomationTrigger = entry.on === 'exit' || entry.trigger === 'exit' ? 'exit' : 'enter';
    const runnable = canColumnRun(type as AutomationType, { autoSpawn: swimlane.auto_spawn, role: swimlane.role }, trigger);
    if (!runnable.ok) {
      // A warning, not a refusal: the row is legal and stored, and turning the
      // column's setting back on makes it run. Refusing would make an agent
      // unable to build a column's list before switching its agent on.
      warnings.push(`"${name}" will not run as things stand. ${runnable.reason}`);
    }

    // An id survives only when this column already owns it and no earlier row
    // in this payload claimed it. Everything else mints a fresh one, so a copy
    // between columns lands as new rows instead of failing on the primary key.
    const suppliedId = typeof entry.id === 'string' && entry.id ? entry.id : undefined;
    const keptId = suppliedId !== undefined && ownIds.has(suppliedId) && !usedIds.has(suppliedId)
      ? suppliedId
      : undefined;
    if (keptId !== undefined) usedIds.add(keptId);

    parsed.push({
      id: keptId,
      name,
      type: type as AutomationType,
      trigger,
      enabled: entry.enabled !== false,
      config: readConfig(entry, type as AutomationType),
    });
  }

  const saved = new AutomationRepository(db).replaceForColumn(swimlane.id, parsed);
  // The file re-seeds the DB on project open, so a write that skips the
  // write-back is undone the next time the project opens.
  //
  // No `previous`: that argument drives the live-session strategy propagation,
  // and nothing here touches a strategy field. Passing the row as its own
  // previous would walk every task in the column to build a diff that is empty
  // by construction.
  context.onSwimlaneUpdated(swimlane);

  const counts = { enter: saved.filter((row) => row.trigger === 'enter').length, exit: saved.filter((row) => row.trigger === 'exit').length };
  return {
    success: true,
    message: `Replaced "${swimlane.name}" automations: ${counts.enter} on enter, ${counts.exit} on exit.`
      + (warnings.length > 0 ? `\nHeads up: ${warnings.join(' ')}` : ''),
    data: { automations: saved.map((row) => serializeRow(row, swimlane.name)), warnings },
  };
};

export const handleGetAutomationRuns: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const db = context.getProjectDb();
  const runRepo = new AutomationRunRepository(db);
  const limit = clampLimit(params.limit);

  // By task or by automation, never both, because the two are different
  // questions: "what happened to this card" and "does this automation work".
  if (params.task !== undefined && params.task !== null) {
    const selector = String(params.task);
    const task = resolveTask(new TaskRepository(db), selector.replace(/^#/, ''));
    if (!task) return { success: false, error: `No task matches "${selector}". Pass a task id or its #number.` };
    return renderRuns(runRepo.listForTask(task.id, limit), `task #${task.display_id}`);
  }

  if (params.column !== undefined && params.column !== null) {
    const resolution = resolveColumn(db, String(params.column), 'todo', { includeArchivedDone: true });
    if ('error' in resolution) return { success: false, error: resolution.error };
    const automationRepo = new AutomationRepository(db);
    const ids = new Set(automationRepo.listForColumn(resolution.swimlane.id).map((row) => row.id));
    // Per automation rather than one column-wide query, because the run table
    // deliberately has no foreign key to `column_automations`: a run log that
    // empties itself on a rename or a delete is not a log, so the rows are
    // matched by the ids the column holds NOW.
    const runs = [...ids]
      .flatMap((id) => runRepo.listForAutomation(id, limit))
      .sort((left, right) => (left.started_at < right.started_at ? 1 : -1))
      .slice(0, limit);
    return renderRuns(runs, `column "${resolution.swimlane.name}"`);
  }

  return {
    success: false,
    error: 'Pass task (a task id or #number) or column (a column name) to say whose runs to read.',
  };
};

export const handleRunAutomation: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  if (!context.onRunAutomation) {
    return { success: false, error: 'Running an automation is not available from this connection.' };
  }

  const columnName = params.column as string | null;
  const automationName = params.automation as string | null;
  if (!columnName || !automationName) {
    return { success: false, error: 'column and automation are both required, naming the column and the automation on it.' };
  }

  const db = context.getProjectDb();
  const columnResolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in columnResolution) return { success: false, error: columnResolution.error };

  const rows = new AutomationRepository(db).listForColumn(columnResolution.swimlane.id);
  const wanted = automationName.trim().toLowerCase();
  const automation = rows.find((row) => row.name.trim().toLowerCase() === wanted);
  if (!automation) {
    const available = rows.map((row) => row.name).join(', ');
    return {
      success: false,
      error: `"${columnResolution.swimlane.name}" has no automation named "${automationName}".`
        + (available ? ` It has: ${available}.` : ' It has none.'),
    };
  }

  if (params.task === undefined || params.task === null) {
    return { success: false, error: 'task is required: an automation runs against one task, and this one has no move to infer it from.' };
  }
  const selector = String(params.task);
  const task = resolveTask(new TaskRepository(db), selector.replace(/^#/, ''));
  if (!task) return { success: false, error: `No task matches "${selector}". Pass a task id or its #number.` };

  const result = await context.onRunAutomation(automation.id, task.id);
  if (!result.ok) return { success: false, error: result.error };

  return {
    success: true,
    message: `Ran "${result.automationName}" (${result.columnName}) against task #${task.display_id}'s current state: `
      + `${result.status}${result.detail ? `. ${result.detail}` : ''}`,
    data: result,
  };
};

function renderRuns(runs: ReturnType<AutomationRunRepository['listForTask']>, subject: string): CommandResponse {
  if (runs.length === 0) {
    return { success: true, message: `No automation runs recorded for ${subject}.`, data: { runs: [] } };
  }
  const lines = runs.map((run) =>
    `${run.started_at} ${run.automation_name} (${run.type}, on ${run.trigger}): ${run.status}`
    + (run.attempts > 1 ? ` after ${run.attempts} attempts` : '')
    + (run.detail ? ` - ${run.detail}` : ''));
  return {
    success: true,
    message: `${runs.length} automation run(s) for ${subject}, newest first:\n${lines.join('\n')}`,
    data: { runs },
  };
}

/** Read only the keys the type declares, so a stray key is dropped rather than stored. */
function readConfig(entry: Record<string, unknown>, type: AutomationType): AutomationConfig {
  const config: Record<string, unknown> = {};
  for (const field of AUTOMATION_MANIFEST[type].fields) {
    const value = entry[field.key];
    if (value !== undefined) config[field.key] = value;
  }
  // The legacy `send_command` payload key, so an older skill's row still
  // carries its message across.
  if (type === 'send_message' && config.message === undefined && typeof entry.command === 'string') {
    config.message = entry.command;
  }
  return config as AutomationConfig;
}

function serializeRow(row: ColumnAutomation, columnName: string): Record<string, unknown> {
  return {
    id: row.id,
    column: columnName,
    name: row.name,
    type: row.type,
    on: row.trigger,
    position: row.position,
    enabled: row.enabled,
    ...row.config,
  };
}

function clampLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return RUN_HISTORY_LIMIT;
  return Math.min(Math.floor(value), RUN_HISTORY_LIMIT);
}
