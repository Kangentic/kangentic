import type { AutomationTaskFilter, BoardAutomationFilter } from './types';

/**
 * A row's Condition Task lines (#872): the task's priority and labels, checked
 * in code with no agent call. The runner, the Evaluation pre-check, the
 * repository, the `kangentic.json` reader and writer, the MCP tools and the
 * Edit automation dialog all go through this module, so a row matches the
 * same tasks wherever it is asked.
 */

/** The fields of a task a filter reads. */
export interface FilterableTaskFacts {
  priority: number;
  labels: readonly string[] | null | undefined;
}

/**
 * A filter as stored: whole, non-negative levels and trimmed labels, each list
 * deduped and in order, and a filter with neither list null, so "no Task lines"
 * has one shape.
 */
export function normalizeTaskFilter(filter: Partial<AutomationTaskFilter> | null | undefined): AutomationTaskFilter | null {
  if (!filter) return null;
  const priorities: number[] = [];
  for (const level of filter.priorities ?? []) {
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || priorities.includes(level)) continue;
    priorities.push(level);
  }
  const labels: string[] = [];
  for (const label of filter.labels ?? []) {
    if (typeof label !== 'string') continue;
    const trimmed = label.trim();
    if (trimmed === '' || labels.includes(trimmed)) continue;
    labels.push(trimmed);
  }
  if (priorities.length === 0 && labels.length === 0) return null;
  return { priorities: priorities.sort((first, second) => first - second), labels };
}

/** Whether a row has Task lines to check. */
export function hasTaskFilter(row: { filter?: AutomationTaskFilter | null }): row is { filter: AutomationTaskFilter } {
  return normalizeTaskFilter(row.filter) !== null;
}

/**
 * Whether a task matches a row's Task lines: its priority is one of the
 * listed levels and it carries one of the listed labels, each list checked
 * only when it has entries. No Task lines matches every task. The same
 * any-of rule as the board toolbar's Filter (`board-task-filter.ts`).
 */
export function matchesTaskFilter(filter: AutomationTaskFilter | null | undefined, task: FilterableTaskFacts): boolean {
  const normalized = normalizeTaskFilter(filter);
  if (normalized === null) return true;
  if (normalized.priorities.length > 0 && !normalized.priorities.includes(task.priority)) return false;
  if (normalized.labels.length > 0) {
    const taskLabels = task.labels ?? [];
    if (!normalized.labels.some((label) => taskLabels.includes(label))) return false;
  }
  return true;
}

/** The stored JSON for a filter, or null for none. */
export function taskFilterToJson(filter: AutomationTaskFilter | null | undefined): string | null {
  const normalized = normalizeTaskFilter(filter);
  return normalized === null ? null : JSON.stringify(normalized);
}

/** A stored filter read back. Anything that is not a filter object reads as none. */
export function taskFilterFromJson(json: string | null | undefined): AutomationTaskFilter | null {
  if (typeof json !== 'string' || json.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return normalizeTaskFilter({
      priorities: Array.isArray(record.priorities) ? record.priorities.filter((level): level is number => typeof level === 'number') : [],
      labels: Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : [],
    });
  } catch {
    // report-ok: a malformed blob reads as no Task lines, as a malformed config blob reads as empty
    return null;
  }
}

/** A priority level's name as the file and MCP write it. */
export interface PriorityLevelName {
  label: string;
}

/**
 * A filter in the shape `kangentic.json` and the MCP tools write: level names
 * from the project's priority list. A level the list no longer has is left
 * out, since no name can say it.
 */
export function taskFilterToBoard(
  filter: AutomationTaskFilter | null | undefined,
  priorityLevels: readonly PriorityLevelName[],
): BoardAutomationFilter | null {
  const normalized = normalizeTaskFilter(filter);
  if (normalized === null) return null;
  const board: BoardAutomationFilter = {};
  const priorityNames = normalized.priorities.flatMap((level) => {
    const name = priorityLevels[level]?.label;
    return typeof name === 'string' && name.trim() !== '' ? [name] : [];
  });
  if (priorityNames.length > 0) board.priorities = priorityNames;
  if (normalized.labels.length > 0) board.labels = [...normalized.labels];
  return board.priorities || board.labels ? board : null;
}

/** What reading a written filter gave: the stored filter, and the level names no level has. */
export interface BoardFilterReadResult {
  filter: AutomationTaskFilter | null;
  unknownPriorities: string[];
  /** Set when the value is not `{ priorities?: string[], labels?: string[] }`. */
  malformed: boolean;
}

/**
 * Read a filter as `kangentic.json` and the MCP tools write it. Level names
 * match the project's priority list without regard to case or padding. A name
 * no level has is reported, never dropped quietly: a row that lost a level
 * would run for tasks it was written to skip.
 */
export function taskFilterFromBoard(
  value: unknown,
  priorityLevels: readonly PriorityLevelName[],
): BoardFilterReadResult {
  if (value === undefined || value === null) return { filter: null, unknownPriorities: [], malformed: false };
  if (typeof value !== 'object' || Array.isArray(value)) return { filter: null, unknownPriorities: [], malformed: true };
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).some((key) => key !== 'priorities' && key !== 'labels');
  const priorityValues = record.priorities ?? [];
  const labelValues = record.labels ?? [];
  if (unknownKey || !isStringList(priorityValues) || !isStringList(labelValues)) {
    return { filter: null, unknownPriorities: [], malformed: true };
  }
  const priorities: number[] = [];
  const unknownPriorities: string[] = [];
  for (const name of priorityValues) {
    const level = priorityLevelIndex(name, priorityLevels);
    if (level === null) unknownPriorities.push(name);
    else priorities.push(level);
  }
  return { filter: normalizeTaskFilter({ priorities, labels: labelValues }), unknownPriorities, malformed: false };
}

/** A level's index by name, or null. */
export function priorityLevelIndex(name: string, priorityLevels: readonly PriorityLevelName[]): number | null {
  const key = name.trim().toLowerCase();
  if (key === '') return null;
  const index = priorityLevels.findIndex((level) => level.label.trim().toLowerCase() === key);
  return index === -1 ? null : index;
}

/**
 * A filter after the project's priority levels were deleted or reordered:
 * the same mapping `BACKLOG_REMAP_PRIORITIES` applies to the tasks.
 */
export function remapTaskFilterPriorities(
  filter: AutomationTaskFilter | null,
  mapping: Readonly<Record<number, number>>,
): AutomationTaskFilter | null {
  if (filter === null) return null;
  return normalizeTaskFilter({
    priorities: filter.priorities.map((level) => mapping[level] ?? level),
    labels: filter.labels,
  });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
