import type {
  BoardColumnAutomations,
  BoardColumnConfig,
  BoardConfig,
  Swimlane,
} from '../../../shared/types';
import { AUTOMATION_TRIGGER_FILE_KEYS } from '../../../shared/automation-manifest';
import { AUTOMATION_OWNERSHIP_KEYS, isJsonObject, readObjectList } from './config-helpers';
import { COLUMN_FIELD_DEFAULTS } from './column-field-defaults';
import {
  assembleBoardConfig,
  buildBoardConfigFromDb,
  findExistingColumn,
  readBoardLanes,
  readColumnFieldValue,
  readExistingAutomations,
  serializeAutomations,
  serializeColumn,
  type BoardLanes,
} from './build-config';

/**
 * What a write-back puts in each file: the team file whole, and the local
 * file's new `columns`, or null when they are unchanged (the caller then
 * leaves `kangentic.local.json` as it is).
 */
export interface SplitBoardConfig {
  team: BoardConfig;
  localColumns: BoardColumnConfig[] | null;
}


/**
 * Build both config files from the database, keeping what came from
 * `kangentic.local.json` out of `kangentic.json` (GitHub #806).
 *
 * The database holds the MERGED board: `mergeBoardConfigs` spread each local
 * column over its team column and applied the result. So the write-back
 * cannot serialize every lane into the team file, or a personal override and
 * a local-only column reach every teammate on the next commit. Instead, per
 * lane:
 *
 * - A lane whose local entry has no team column is local-only. Its whole
 *   column goes to the local entry, and the team file never hears of it.
 * - For a team lane with a local entry, each key the entry sets takes the
 *   database's value into the entry and keeps the team file's value in the
 *   team file. Every other key goes to the team file. That is what saves an
 *   edit to a locally set field to the local file: the Column Manager and
 *   `kangentic_update_column` write the database, and this sends the value to
 *   the file it is read from (the same rule `setStopScript` follows).
 * - A local entry that declares automations owns the whole list, since an
 *   ordered list has no stable key to merge a row against.
 * - A team column that points at a local-only column (`planExitTarget`, a Move
 *   to column row's `targetColumn`) keeps the team file's value, because no
 *   teammate has that column. The pointer is saved in the column's local entry
 *   instead, so the next open does not undo the edit.
 *
 * A local entry whose lane is not in the database is left as it is. A delete
 * removes its entry explicitly (`BoardConfigManager.removeLocalColumn`), so a
 * local file the last open could not read is never emptied here.
 */
export function buildSplitBoardConfigFromDb(params: {
  projectId: string;
  existingTeamConfig: BoardConfig | null;
  existingLocalOverrides: Partial<BoardConfig> | null;
  fingerprint: string;
}): SplitBoardConfig {
  // With no local columns there is nothing to keep out, and the team file is
  // the whole board, as it always was.
  const localColumns: unknown = params.existingLocalOverrides?.columns;
  if (!Array.isArray(localColumns) || localColumns.length === 0) {
    return {
      team: buildBoardConfigFromDb({
        projectId: params.projectId,
        existingTeamConfig: params.existingTeamConfig,
        fingerprint: params.fingerprint,
      }),
      localColumns: null,
    };
  }
  return splitBoardConfig({
    boardLanes: readBoardLanes(params.projectId),
    existingTeamConfig: params.existingTeamConfig,
    existingLocalOverrides: params.existingLocalOverrides,
    fingerprint: params.fingerprint,
  });
}

/** The pure half of `buildSplitBoardConfigFromDb`, over lanes already read. */
export function splitBoardConfig(params: {
  boardLanes: BoardLanes;
  existingTeamConfig: BoardConfig | null;
  existingLocalOverrides: Partial<BoardConfig> | null;
  fingerprint: string;
}): SplitBoardConfig {
  const { lanes, laneById, automationsByLane } = params.boardLanes;
  const teamColumns = readObjectList<BoardColumnConfig>(params.existingTeamConfig?.columns);
  const existingLocalColumns: unknown = params.existingLocalOverrides?.columns;
  const localColumns = Array.isArray(existingLocalColumns) ? readObjectList<BoardColumnConfig>(existingLocalColumns) : [];

  const teamColumnIds = new Set(teamColumns.map((column) => column.id).filter((id): id is string => typeof id === 'string'));
  const teamColumnById = new Map(teamColumns.filter((column) => typeof column.id === 'string').map((column) => [column.id!, column]));
  // A hand-written team file may carry no ids, and its columns then match
  // lanes by name. No local entry can rename such a column (the merge matches
  // by id), so the lane still has the team file's name.
  const idlessTeamNames = new Set(teamColumns.filter((column) => typeof column.id !== 'string').map((column) => column.name));
  const isTeamLane = (lane: Swimlane): boolean => teamColumnIds.has(lane.id) || idlessTeamNames.has(lane.name);

  // Each lane's local entry. By id first; a local-only entry with no id was
  // given one by the apply, so it is found by name, and the id is written back.
  const localEntryByLane = new Map<string, BoardColumnConfig>();
  const claimedEntries = new Set<BoardColumnConfig>();
  for (const lane of lanes) {
    const byId = localColumns.find((entry) => entry.id === lane.id);
    if (byId) {
      localEntryByLane.set(lane.id, byId);
      claimedEntries.add(byId);
    }
  }
  for (const lane of lanes) {
    if (localEntryByLane.has(lane.id) || isTeamLane(lane)) continue;
    const byName = localColumns.find((entry) => !entry.id && entry.name === lane.name && !claimedEntries.has(entry));
    if (byName) {
      localEntryByLane.set(lane.id, byName);
      claimedEntries.add(byName);
    }
  }

  const isLocalOnly = (lane: Swimlane): boolean => localEntryByLane.has(lane.id) && !isTeamLane(lane);

  // A lane's name as the team file has it. A local `name` override renamed the
  // lane in the database, and a team pointer must keep naming the column the
  // way teammates know it.
  const teamNameOf = (laneId: string): string | undefined => {
    const lane = laneById.get(laneId);
    if (!lane) return undefined;
    const localEntry = localEntryByLane.get(laneId);
    const teamColumn = teamColumnById.get(laneId);
    if (localEntry && teamColumn && 'name' in localEntry) return teamColumn.name;
    return lane.name;
  };
  const localNameOf = (laneId: string): string | undefined => laneById.get(laneId)?.name;
  const laneByLocalName = new Map(lanes.map((lane) => [lane.name, lane]));

  const outputTeamColumns: BoardColumnConfig[] = [];
  const outputEntryByLane = new Map<string, BoardColumnConfig>();

  for (const lane of lanes) {
    const automations = automationsByLane.get(lane.id) ?? [];
    const localEntry = localEntryByLane.get(lane.id) ?? null;

    if (localEntry && isLocalOnly(lane)) {
      // The whole column is personal. Every key it sets is read back from the
      // database, and a key it does not set yet is added when the lane holds a
      // non-default value, written the way the team file would write it.
      const serialized = serializeColumn(lane, {
        automations,
        existingColumn: localEntry,
        targetNameOf: localNameOf,
      });
      const entry = mergeLocalEntry(localEntry, lane, localNameOf, Object.keys(localEntry));
      const entryFields = entry as unknown as Record<string, unknown>;
      const defaults: Record<string, unknown> = COLUMN_FIELD_DEFAULTS;
      for (const [key, value] of Object.entries(serialized)) {
        if (key === 'automations' || key in entryFields) continue;
        // A key at the value an absent key creates the column with says
        // nothing, so a local-only column is not rewritten just for it.
        if (key in defaults && jsonEqual(defaults[key], value)) continue;
        entryFields[key] = value;
      }
      writeOwnedAutomations(entry, localEntry, serialized.automations);
      entry.id = lane.id;
      outputEntryByLane.set(lane.id, entry);
      continue;
    }

    const existingTeamColumn = teamColumnById.get(lane.id) ?? findExistingColumn(teamColumns, lane);
    const teamColumn = serializeColumn(lane, {
      automations,
      existingColumn: existingTeamColumn,
      targetNameOf: teamNameOf,
    });
    const rowsPointLocal = renameRowTargets(teamColumn.automations, laneByLocalName, teamNameOf, isLocalOnly);

    const planExitTargetLane = lane.plan_exit_target_id ? laneById.get(lane.plan_exit_target_id) : undefined;
    const planExitPointsLocal = planExitTargetLane !== undefined && isLocalOnly(planExitTargetLane);

    if (!localEntry && !rowsPointLocal && !planExitPointsLocal) {
      outputTeamColumns.push(teamColumn);
      continue;
    }

    // Keys this column's local entry sets, plus the pointers the team file
    // cannot hold. A pointer moved here becomes a key the entry sets, so the
    // next write-back keeps it local without looking again.
    const localKeys = new Set(localEntry ? Object.keys(localEntry) : []);
    localKeys.delete('id');
    if (planExitPointsLocal) localKeys.add('planExitTarget');
    const ownsAutomations = rowsPointLocal || [...localKeys].some((key) => AUTOMATION_OWNERSHIP_KEYS.has(key));

    for (const key of localKeys) {
      if (AUTOMATION_OWNERSHIP_KEYS.has(key)) continue;
      keepTeamValue(teamColumn, existingTeamColumn, key);
    }
    if (ownsAutomations) keepTeamValue(teamColumn, existingTeamColumn, 'automations');
    outputTeamColumns.push(teamColumn);

    const baseEntry: BoardColumnConfig = localEntry ?? ({ id: lane.id } as BoardColumnConfig);
    const entry = mergeLocalEntry(baseEntry, lane, localNameOf, [...localKeys]);
    if (ownsAutomations) {
      const localAutomations = serializeAutomations(automations, readExistingAutomations(localEntry));
      writeOwnedAutomations(entry, localEntry, localAutomations);
    }
    entry.id = lane.id;
    outputEntryByLane.set(lane.id, entry);
  }

  const team = assembleBoardConfig(outputTeamColumns, params.existingTeamConfig, params.fingerprint);

  // The local file keeps its own order and every entry this write-back did not
  // touch, including one that is not an object (the merge ignores it), so a
  // stray value in a hand-edited file is not a reason to rewrite it. A pointer
  // moved local for a column with no entry yet is appended.
  if (!params.existingLocalOverrides) return { team, localColumns: null };
  const nextLocalColumns: BoardColumnConfig[] = [];
  const written = new Set<string>();
  const rawLocalColumns: unknown[] = Array.isArray(existingLocalColumns) ? existingLocalColumns : [];
  for (const rawEntry of rawLocalColumns) {
    if (!isJsonObject(rawEntry)) {
      nextLocalColumns.push(rawEntry as unknown as BoardColumnConfig);
      continue;
    }
    const entry = rawEntry as unknown as BoardColumnConfig;
    const lane = lanes.find((candidate) => localEntryByLane.get(candidate.id) === entry);
    if (lane && outputEntryByLane.has(lane.id)) {
      nextLocalColumns.push(outputEntryByLane.get(lane.id)!);
      written.add(lane.id);
    } else {
      nextLocalColumns.push(entry);
    }
  }
  for (const [laneId, entry] of outputEntryByLane) {
    if (!written.has(laneId)) nextLocalColumns.push(entry);
  }

  const unchanged = Array.isArray(existingLocalColumns) && jsonEqual(existingLocalColumns, nextLocalColumns);
  return { team, localColumns: unchanged ? null : nextLocalColumns };
}

/**
 * The local entry with each of `keys` read back from the lane. A value the
 * database still agrees with is kept exactly as the file wrote it, so an open
 * that changed nothing never rewrites the local file. A key this build cannot
 * read back is kept as the file has it.
 */
function mergeLocalEntry(
  existingEntry: BoardColumnConfig,
  lane: Swimlane,
  targetNameOf: (laneId: string) => string | undefined,
  keys: string[],
): BoardColumnConfig {
  const entry = { ...existingEntry } as Record<string, unknown>;
  for (const key of keys) {
    if (key === 'id' || AUTOMATION_OWNERSHIP_KEYS.has(key)) continue;
    const read = readColumnFieldValue(lane, key, targetNameOf);
    if (!read.known) continue;
    if (read.value === undefined) {
      delete entry[key];
      continue;
    }
    // `null` and `""` both say "none here", and either may be in the file.
    if (isEmptyFieldValue(entry[key]) && isEmptyFieldValue(read.value)) continue;
    if (!jsonEqual(entry[key], read.value)) entry[key] = read.value;
  }
  return entry as unknown as BoardColumnConfig;
}

function isEmptyFieldValue(value: unknown): boolean {
  return value === null || value === '';
}

/**
 * Put a column's automations, as the database has them, on its local entry.
 * Left exactly as the file wrote them when they serialize the same. A legacy
 * `autoCommand` is replaced by the list it converted into, the same move the
 * team file made when automations arrived. An empty list is `{}`, not an
 * absent key, so the entry keeps owning the column's automations.
 */
function writeOwnedAutomations(
  entry: BoardColumnConfig,
  existingEntry: BoardColumnConfig | null,
  automations: BoardColumnAutomations | undefined,
): void {
  const previous: unknown = existingEntry?.automations;
  const carriesLegacyMessage = existingEntry?.autoCommand !== undefined;
  // Nothing in the database and nothing in the file: there is nothing to say.
  if (automations === undefined && previous === undefined && !carriesLegacyMessage) return;
  const next: BoardColumnAutomations = automations ?? {};
  if (previous !== undefined && jsonEqual(previous, next)) return;
  entry.automations = next;
  delete entry.autoCommand;
  delete entry.autoCommandMode;
}

/** Give a team column the team file's own value for `key`, or none when the file had none. */
function keepTeamValue(teamColumn: BoardColumnConfig, existingTeamColumn: BoardColumnConfig | null, key: string): void {
  const target = teamColumn as unknown as Record<string, unknown>;
  const source = existingTeamColumn as unknown as Record<string, unknown> | null;
  if (key === 'name') {
    // A column always has a name. With no team entry to read it from, the
    // lane's own name is the only one there is.
    if (typeof source?.name === 'string') target.name = source.name;
    return;
  }
  if (source && key in source) target[key] = source[key];
  else delete target[key];
}

/**
 * Rewrite each Move to column row's target into the team file's name for that
 * column, and report whether any row targets a column that is local-only.
 * Rows carried over unread from the file already name the team's columns.
 */
function renameRowTargets(
  automations: BoardColumnAutomations | undefined,
  laneByLocalName: Map<string, Swimlane>,
  teamNameOf: (laneId: string) => string | undefined,
  isLocalOnly: (lane: Swimlane) => boolean,
): boolean {
  if (!automations) return false;
  let pointsLocal = false;
  for (const fileKey of Object.values(AUTOMATION_TRIGGER_FILE_KEYS)) {
    const group: unknown = automations[fileKey];
    if (!Array.isArray(group)) continue;
    for (let index = 0; index < group.length; index++) {
      const row: unknown = group[index];
      if (!isJsonObject(row) || typeof row.targetColumn !== 'string') continue;
      const target = laneByLocalName.get(row.targetColumn);
      if (!target) continue;
      if (isLocalOnly(target)) {
        pointsLocal = true;
        continue;
      }
      // A copy, never an assignment: a row of a type this build does not know
      // is the team file's own object, carried over by reference.
      const teamName = teamNameOf(target.id);
      if (teamName && teamName !== row.targetColumn) group[index] = { ...row, targetColumn: teamName };
    }
  }
  return pointsLocal;
}

/** Structural equality for values read from JSON, ignoring object key order. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => jsonEqual(left[key], right[key]));
  }
  return false;
}
