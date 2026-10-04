import type {
  BoardActionConfig,
  BoardConfig,
  BoardColumnConfig,
  BoardTransitionConfig,
  PermissionMode,
  ShortcutConfig,
} from '../../../shared/types';

export const CURRENT_VERSION = 1;
export const TEAM_FILE = 'kangentic.json';
export const LOCAL_FILE = 'kangentic.local.json';

/**
 * Backward-compat migration for old kangentic.json permission values.
 * Applied in-place to BoardColumnConfig.permissionMode.
 */
const PERMISSION_VALUE_MIGRATION: Record<string, PermissionMode> = {
  'bypass-permissions': 'bypassPermissions',
  'manual': 'default',
  'dangerously-skip': 'bypassPermissions',
};

/**
 * Migrate old field names in BoardColumnConfig in-place:
 *   - `permissionStrategy` → `permissionMode` (renamed field)
 *   - Old permission mode values (e.g. 'bypass-permissions') → new values
 *
 * Exported so the loaders and the reconciler can share migration.
 *
 * Runs while the file is parsed, where a throw makes the loader treat the
 * whole file as missing. So it touches only the object entries of a real list,
 * and leaves a malformed `columns` for the validator to report.
 */
export function migrateBoardColumnFields(config: BoardConfig): void {
  for (const column of readObjectList<BoardColumnConfig>(config.columns)) {
    const legacy = column as unknown as Record<string, unknown>;
    if (!column.permissionMode && legacy.permissionStrategy) {
      column.permissionMode = legacy.permissionStrategy as PermissionMode;
      delete legacy.permissionStrategy;
    }
    if (column.permissionMode && column.permissionMode in PERMISSION_VALUE_MIGRATION) {
      column.permissionMode = PERMISSION_VALUE_MIGRATION[column.permissionMode as string];
    }
  }
}

/**
 * Parse one of the config files. Strips a leading UTF-8 byte order mark first:
 * editors on Windows save one, JSON.parse rejects it, and a file read as
 * unreadable is one the app refuses to write. Every reader and writer of the
 * two files parses through here, so they agree on what the file holds.
 */
export function parseConfigJson(raw: string): unknown {
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/**
 * A write to kangentic.json or kangentic.local.json was refused because the
 * file exists and cannot be read, typically git merge conflict markers. The
 * message is written for the user: an IPC caller toasts it, and an MCP command
 * returns it as its error, so an agent can tell the user what to fix.
 */
export class BoardConfigUnreadableError extends Error {
  constructor(fileName: string, reason: string) {
    super(`${fileName} could not be read, so this change was not saved to it. Fix the file and try again. ${reason}`);
    this.name = 'BoardConfigUnreadableError';
  }
}

/** A JSON object, as opposed to null, an array, or a primitive. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The object entries of a list read from one of the config files, or `[]` when
 * the value is not a list. For the readers that run outside the reconcile
 * (shortcuts, profiles), where there is no fatal path to fall back on and a
 * malformed list must read as an empty one rather than throw.
 */
export function readObjectList<Entry>(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject) as Entry[];
}

/** Present, and not a list. Null and absent both read as none. */
export function isMalformedList(value: unknown): boolean {
  return value !== undefined && value !== null && !Array.isArray(value);
}

/** A team list the merge can read: absent, or a list of objects. */
function isMergeableTeamList(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(isJsonObject));
}

/**
 * Validate the shape of a BoardConfig loaded from kangentic.json.
 *
 * Returns a human-readable error string if the config is fatally bad
 * (the caller should abandon reconciliation and fall back to DB), or
 * null if the config passes the structural checks.
 *
 * Non-fatal concerns (e.g. version > CURRENT_VERSION) are NOT reported
 * here - the reconciler emits them as warnings so the board still loads.
 *
 * The lists are checked for shape before anything iterates them. The config
 * came from JSON.parse, so `"actions": {}` or `"columns": ["Planning"]` is a
 * real input, and each used to throw out of this function or out of the
 * reconcile transaction it guards (the same class as Sentry DESKTOP-1H)
 * instead of falling back to the database with a message. Automations are not
 * checked here: a bad one is a warning in `apply-automations.ts`, never a
 * reason to reject the whole file.
 */
export function validateBoardConfig(config: BoardConfig): string | null {
  const fallback = 'Board loaded from local database.';
  if (!config.version) {
    return `kangentic.json is missing the version field. ${fallback}`;
  }

  const columns: unknown = config.columns;
  if (isMalformedList(columns)) {
    return `kangentic.json has a columns value that is not a list. ${fallback}`;
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    return `kangentic.json has no columns defined. ${fallback}`;
  }
  for (const column of columns) {
    if (!isJsonObject(column)) {
      return `kangentic.json has a column that is not an object. ${fallback}`;
    }
    if (typeof column.name !== 'string') {
      return `kangentic.json has a column with no name. ${fallback}`;
    }
  }

  const actions: unknown = config.actions;
  if (isMalformedList(actions)) {
    return `kangentic.json has an actions value that is not a list. ${fallback}`;
  }
  if (Array.isArray(actions) && !actions.every(isJsonObject)) {
    return `kangentic.json has an action that is not an object. ${fallback}`;
  }

  const transitions: unknown = config.transitions;
  if (isMalformedList(transitions)) {
    return `kangentic.json has a transitions value that is not a list. ${fallback}`;
  }
  if (Array.isArray(transitions)) {
    for (const transition of transitions) {
      if (!isJsonObject(transition)) {
        return `kangentic.json has a transition that is not an object. ${fallback}`;
      }
      if (!Array.isArray(transition.actions)) {
        return `kangentic.json has a transition whose actions is not a list. ${fallback}`;
      }
    }
  }

  const columnNames = new Set<string>();
  for (const column of config.columns) {
    if (columnNames.has(column.name)) {
      return `kangentic.json has duplicate column name '${column.name}'. ${fallback}`;
    }
    columnNames.add(column.name);
  }

  if (config.actions) {
    const actionNames = new Set<string>();
    for (const action of config.actions) {
      if (actionNames.has(action.name)) {
        return `kangentic.json has duplicate action name '${action.name}'. ${fallback}`;
      }
      actionNames.add(action.name);
    }
  }

  return null;
}

/**
 * Merge team-shared BoardConfig with the developer's local overrides.
 *
 * Merge strategy per field:
 *   - columns: matched by id. Local override replaces team entry in-place;
 *     local-only columns are inserted before the 'done' column (or appended
 *     if no done column exists) so they don't disturb the terminal column.
 *   - actions: matched by id. Local overrides team; local-only actions
 *     are appended.
 *   - transitions: matched by (from, to). Local replaces team; local-only
 *     transitions are appended.
 *   - defaultBaseBranch: scalar - local wins when defined.
 *   - shortcuts: matched by id, same rules as actions.
 *
 * Both files came from JSON.parse, and this runs before the validator for
 * every reader of the effective config, including the default base branch on
 * each task finalization. So a list is merged only when both sides can be
 * read. A local value that is not a list is ignored, along with any local
 * entry that is not an object. A team value that is not a list of objects is
 * left as it is, for the validator to reject with a message instead of a throw.
 *
 * Pure: does not mutate inputs, returns a fresh BoardConfig.
 */
export function mergeBoardConfigs(team: BoardConfig, local: Partial<BoardConfig>): BoardConfig {
  const result: BoardConfig = { ...team };

  if (Array.isArray(local.columns) && Array.isArray(team.columns) && team.columns.every(isJsonObject)) {
    const localColumns = readObjectList<BoardColumnConfig>(local.columns);
    const mergedColumns: BoardColumnConfig[] = [];
    const usedIds = new Set<string>();

    for (const teamColumn of team.columns) {
      if (teamColumn.id) usedIds.add(teamColumn.id);
      const localColumn = localColumns.find((candidate) => candidate.id && candidate.id === teamColumn.id);
      if (localColumn) {
        mergedColumns.push({ ...teamColumn, ...localColumn });
      } else {
        mergedColumns.push(teamColumn);
      }
    }

    const localOnlyColumns = localColumns.filter((candidate) => !candidate.id || !usedIds.has(candidate.id));
    if (localOnlyColumns.length > 0) {
      const doneIndex = mergedColumns.findIndex((column) => column.role === 'done');
      const insertIndex = doneIndex >= 0 ? doneIndex : mergedColumns.length;
      mergedColumns.splice(insertIndex, 0, ...localOnlyColumns);
    }

    result.columns = mergedColumns;
  }

  if (Array.isArray(local.actions) && isMergeableTeamList(team.actions)) {
    const mergedActions = [...(team.actions || [])];
    for (const localAction of readObjectList<BoardActionConfig>(local.actions)) {
      const existingIndex = mergedActions.findIndex((candidate) => candidate.id && candidate.id === localAction.id);
      if (existingIndex >= 0) {
        mergedActions[existingIndex] = localAction;
      } else {
        mergedActions.push(localAction);
      }
    }
    result.actions = mergedActions;
  }

  if (Array.isArray(local.transitions) && isMergeableTeamList(team.transitions)) {
    const mergedTransitions = [...(team.transitions || [])];
    for (const localTransition of readObjectList<BoardTransitionConfig>(local.transitions)) {
      const existingIndex = mergedTransitions.findIndex(
        (candidate) => candidate.from === localTransition.from && candidate.to === localTransition.to,
      );
      if (existingIndex >= 0) {
        mergedTransitions[existingIndex] = localTransition;
      } else {
        mergedTransitions.push(localTransition);
      }
    }
    result.transitions = mergedTransitions;
  }

  if (local.defaultBaseBranch !== undefined) {
    result.defaultBaseBranch = local.defaultBaseBranch;
  }

  if (Array.isArray(local.shortcuts) && isMergeableTeamList(team.shortcuts)) {
    const mergedShortcuts = [...(team.shortcuts || [])];
    for (const localAction of readObjectList<ShortcutConfig>(local.shortcuts)) {
      const existingIndex = mergedShortcuts.findIndex(
        (candidate) => candidate.id && candidate.id === localAction.id,
      );
      if (existingIndex >= 0) {
        mergedShortcuts[existingIndex] = localAction;
      } else {
        mergedShortcuts.push(localAction);
      }
    }
    result.shortcuts = mergedShortcuts;
  }

  return result;
}
