import type {
  BoardConfig,
  BoardColumnConfig,
  PermissionMode,
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
 */
export function migrateBoardColumnFields(config: BoardConfig): void {
  for (const column of config.columns) {
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
 * Validate the shape of a BoardConfig loaded from kangentic.json.
 *
 * Returns a human-readable error string if the config is fatally bad
 * (the caller should abandon reconciliation and fall back to DB), or
 * null if the config passes the structural checks.
 *
 * Non-fatal concerns (e.g. version > CURRENT_VERSION) are NOT reported
 * here - the reconciler emits them as warnings so the board still loads.
 */
export function validateBoardConfig(config: BoardConfig): string | null {
  if (!config.version) {
    return 'kangentic.json is missing the version field. Board loaded from local database.';
  }
  if (!config.columns || config.columns.length === 0) {
    return 'kangentic.json has no columns defined. Board loaded from local database.';
  }

  const columnNames = new Set<string>();
  for (const column of config.columns) {
    if (columnNames.has(column.name)) {
      return `kangentic.json has duplicate column name '${column.name}'. Board loaded from local database.`;
    }
    columnNames.add(column.name);
  }

  if (config.actions) {
    const actionNames = new Set<string>();
    for (const action of config.actions) {
      if (actionNames.has(action.name)) {
        return `kangentic.json has duplicate action name '${action.name}'. Board loaded from local database.`;
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
 * Pure: does not mutate inputs, returns a fresh BoardConfig.
 */
export function mergeBoardConfigs(team: BoardConfig, local: Partial<BoardConfig>): BoardConfig {
  const result: BoardConfig = { ...team };

  if (local.columns) {
    const mergedColumns: BoardColumnConfig[] = [];
    const usedIds = new Set<string>();

    for (const teamColumn of team.columns) {
      if (teamColumn.id) usedIds.add(teamColumn.id);
      const localColumn = local.columns.find((candidate) => candidate.id && candidate.id === teamColumn.id);
      if (localColumn) {
        mergedColumns.push({ ...teamColumn, ...localColumn });
      } else {
        mergedColumns.push(teamColumn);
      }
    }

    const localOnlyColumns = local.columns.filter((candidate) => !candidate.id || !usedIds.has(candidate.id));
    if (localOnlyColumns.length > 0) {
      const doneIndex = mergedColumns.findIndex((column) => column.role === 'done');
      const insertIndex = doneIndex >= 0 ? doneIndex : mergedColumns.length;
      mergedColumns.splice(insertIndex, 0, ...localOnlyColumns);
    }

    result.columns = mergedColumns;
  }

  if (local.actions) {
    const mergedActions = [...(team.actions || [])];
    for (const localAction of local.actions) {
      const existingIndex = mergedActions.findIndex((candidate) => candidate.id && candidate.id === localAction.id);
      if (existingIndex >= 0) {
        mergedActions[existingIndex] = localAction;
      } else {
        mergedActions.push(localAction);
      }
    }
    result.actions = mergedActions;
  }

  if (local.transitions) {
    const mergedTransitions = [...(team.transitions || [])];
    for (const localTransition of local.transitions) {
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

  if (local.shortcuts) {
    const mergedShortcuts = [...(team.shortcuts || [])];
    for (const localAction of local.shortcuts) {
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
