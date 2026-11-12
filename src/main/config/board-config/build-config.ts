import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRepository } from '../../db/repositories/automation-repository';
import { getProjectDb } from '../../db/database';
import type {
  AutomationTrigger,
  BoardConfig,
  BoardColumnConfig,
  BoardAutomationConfig,
  BoardColumnAutomations,
  ColumnAutomation,
  Swimlane,
} from '../../../shared/types';
import { CURRENT_VERSION, isJsonObject } from './config-helpers';
import { COLUMN_FIELD_DEFAULTS } from './column-field-defaults';
import { textMatchFileValue } from '../../../shared/final-line-match';
import {
  AUTOMATION_MANIFEST,
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_FILE_KEYS,
  RESERVED_AUTOMATION_KEYS,
  isAutomationType,
  isRetiredActionType,
} from '../../../shared/automation-manifest';

/**
 * Build a BoardConfig object from the current SQLite state for a project.
 *
 * The write-back (DB -> kangentic.json) uses it when kangentic.local.json has
 * no columns. When it has some, `splitBoardConfig` (split-config.ts) builds
 * the team file instead, from the same `serializeColumn`. The resulting
 * BoardConfig is stamped with `_modifiedBy = fingerprint` as last-writer
 * provenance (which device last wrote the file); it is not used to suppress
 * the reconciliation dialog (see computeFingerprint and onFileChanged).
 *
 * `existingTeamConfig` lets the caller pass in the currently-on-disk
 * kangentic.json so fields that are NOT stored in the DB (shortcuts,
 * defaultBaseBranch, stopScript) are preserved across writes. Passing `null`
 * drops them.
 *
 * Excludes ghost lanes (they represent columns with orphaned tasks
 * that aren't in the team config; writing them back would re-introduce
 * them as real columns).
 */
export function buildBoardConfigFromDb(params: {
  projectId: string;
  existingTeamConfig: BoardConfig | null;
  fingerprint: string;
}): BoardConfig {
  const { lanes, laneById, automationsByLane } = readBoardLanes(params.projectId);
  const columns = lanes.map((lane) => serializeColumn(lane, {
    automations: automationsByLane.get(lane.id) ?? [],
    existingColumn: findExistingColumn(params.existingTeamConfig?.columns, lane),
    targetNameOf: (laneId) => laneById.get(laneId)?.name,
  }));
  return assembleBoardConfig(columns, params.existingTeamConfig, params.fingerprint);
}

/** The board's real (non-ghost) lanes in order, with each lane's automations. */
export interface BoardLanes {
  lanes: Swimlane[];
  laneById: Map<string, Swimlane>;
  automationsByLane: Map<string, ColumnAutomation[]>;
}

/**
 * Read the lanes the write-back serializes. Excludes ghost lanes: they hold
 * orphaned tasks for a column the file no longer has, and writing them back
 * would re-introduce them as real columns.
 */
export function readBoardLanes(projectId: string): BoardLanes {
  const db = getProjectDb(projectId);
  const swimlaneRepo = new SwimlaneRepository(db);
  const automationRepo = new AutomationRepository(db);

  const lanes = swimlaneRepo.list().filter((lane) => !lane.is_ghost);
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const automationsByLane = new Map<string, ColumnAutomation[]>();
  for (const automation of automationRepo.listAll()) {
    const existing = automationsByLane.get(automation.swimlane_id) ?? [];
    existing.push(automation);
    automationsByLane.set(automation.swimlane_id, existing);
  }
  return { lanes, laneById, automationsByLane };
}

/** The file's entry for a lane: by id, else by name (a hand-written file may carry no ids). */
export function findExistingColumn(columns: BoardColumnConfig[] | undefined, lane: Swimlane): BoardColumnConfig | null {
  if (!Array.isArray(columns)) return null;
  return columns.find((candidate) => candidate.id === lane.id)
    ?? columns.find((candidate) => candidate.name === lane.name)
    ?? null;
}

/**
 * Serialize one lane as a `kangentic.json` column, omitting every field at its
 * default so a backward-compatible board stays byte-identical until a column
 * is set non-default.
 *
 * `existingColumn` is the file's current entry for the lane, read for the
 * automation rows and keys this build does not understand. `targetNameOf`
 * names the column a `planExitTarget` points at, so the caller decides which
 * file's names a pointer is written in.
 */
export function serializeColumn(
  lane: Swimlane,
  options: {
    automations: ColumnAutomation[];
    existingColumn: BoardColumnConfig | null;
    targetNameOf: (laneId: string) => string | undefined;
  },
): BoardColumnConfig {
  const column: BoardColumnConfig = {
    id: lane.id,
    name: lane.name,
  };
  if (lane.role) column.role = lane.role;
  if (lane.description) column.description = lane.description;
  if (lane.icon) column.icon = lane.icon;
  if (lane.color && lane.color !== COLUMN_FIELD_DEFAULTS.color) column.color = lane.color;
  if (lane.auto_spawn) column.autoSpawn = true;
  if (!lane.auto_spawn && !lane.role) column.autoSpawn = false;
  if (lane.permission_mode) column.permissionMode = lane.permission_mode;
  if (lane.is_archived && lane.role !== 'done') column.archived = true;
  if (lane.agent_override) column.agentOverride = lane.agent_override;
  if (lane.model_override) column.modelOverride = lane.model_override;
  if (lane.effort_override) column.effortOverride = lane.effort_override;
  if (lane.handoff_context) column.handoffContext = true;
  // Omit defaults so a backward-compatible board stays byte-identical until
  // a column is set non-default (matches the sibling fields above).
  if (lane.session_target !== COLUMN_FIELD_DEFAULTS.sessionTarget) column.sessionTarget = lane.session_target;
  if (lane.session_spawn_strategy !== COLUMN_FIELD_DEFAULTS.sessionSpawnStrategy) column.sessionSpawnStrategy = lane.session_spawn_strategy;
  // A To Do or Done column never approves plans (apply-config forces Manual).
  if (lane.plan_approval !== 'manual' && lane.role !== 'todo' && lane.role !== 'done') column.planApproval = lane.plan_approval;
  // A To Do or Done column runs no agent, so it has no limit to share.
  if (lane.max_agents !== null && lane.role !== 'todo' && lane.role !== 'done') column.maxAgents = lane.max_agents;

  const automations = serializeAutomations(options.automations, readExistingAutomations(options.existingColumn));
  if (automations) column.automations = automations;

  // Resolve plan_exit_target_id to target column name
  if (lane.plan_exit_target_id) {
    const targetName = options.targetNameOf(lane.plan_exit_target_id);
    if (targetName) column.planExitTarget = targetName;
  }

  return column;
}

/**
 * The column keys a lane's value can be read back for, with no default
 * omission. A local override holds only the keys it sets, so a value cleared
 * in the Column Manager must be written there explicitly (`null` or `false`),
 * or the merge would fall through to the team file's value. A null in the
 * local file is a clear: apply resets that field to its default
 * (`localNullResets` in board-config-manager.ts).
 *
 * `automations` is not here: the caller serializes it with the rows.
 *
 * Exported for the parity test, which checks every team-shared field has one.
 */
export const COLUMN_FIELD_VALUE_READERS: Partial<Record<keyof BoardColumnConfig, (lane: Swimlane, targetNameOf: (laneId: string) => string | undefined) => unknown>> = {
  name: (lane) => lane.name,
  description: (lane) => lane.description || null,
  role: (lane) => lane.role ?? undefined,
  icon: (lane) => lane.icon ?? null,
  color: (lane) => lane.color,
  autoSpawn: (lane) => lane.auto_spawn,
  permissionMode: (lane) => lane.permission_mode ?? null,
  planExitTarget: (lane, targetNameOf) => (lane.plan_exit_target_id ? targetNameOf(lane.plan_exit_target_id) ?? null : null),
  planApproval: (lane) => lane.plan_approval,
  maxAgents: (lane) => lane.max_agents,
  archived: (lane) => lane.is_archived,
  agentOverride: (lane) => lane.agent_override,
  modelOverride: (lane) => lane.model_override,
  effortOverride: (lane) => lane.effort_override,
  handoffContext: (lane) => lane.handoff_context,
  sessionTarget: (lane) => lane.session_target,
  sessionSpawnStrategy: (lane) => lane.session_spawn_strategy,
};

/**
 * The fields `applyBoardConfigToDb` forces on a To Do or Done column, its
 * `(isTodo || isDone) ? <value> :` guards. A field that gains one joins this list.
 */
export const ROLE_PINNED_FIELDS = new Set<keyof BoardColumnConfig>([
  'permissionMode',
  'autoSpawn',
  'agentOverride',
  'modelOverride',
  'effortOverride',
  'sessionTarget',
  'sessionSpawnStrategy',
  'planApproval',
  'maxAgents',
  'archived',
]);

/**
 * A lane's current value for one column key, or `{ known: false }` for a key
 * this build cannot read back from the database (a legacy key, or one a newer
 * build wrote), which the caller keeps as the file has it. A known key whose
 * value is `undefined` is omitted.
 */
export function readColumnFieldValue(
  lane: Swimlane,
  key: string,
  targetNameOf: (laneId: string) => string | undefined,
): { known: true; value: unknown } | { known: false } {
  const reader = COLUMN_FIELD_VALUE_READERS[key as keyof BoardColumnConfig];
  if (!reader) return { known: false };
  // Apply pins these on a To Do or Done column whatever the file says, so the
  // database cannot tell what was written and nothing can edit them there.
  if ((lane.role === 'todo' || lane.role === 'done') && ROLE_PINNED_FIELDS.has(key as keyof BoardColumnConfig)) {
    return { known: false };
  }
  return { known: true, value: reader(lane, targetNameOf) };
}

/**
 * Wrap serialized columns into the team file, carrying across the keys that
 * have no database representation.
 */
export function assembleBoardConfig(
  columns: BoardColumnConfig[],
  existingTeamConfig: BoardConfig | null,
  fingerprint: string,
): BoardConfig {
  const boardConfig: BoardConfig = {
    version: CURRENT_VERSION,
    columns,
  };

  // `actions` and `transitions` are no longer written. Every automation belongs
  // to a column now, so the top-level arrays and the `from -> to` pairs have
  // nothing left to say. They are still READ (see apply-config) so a file
  // written by an older build still converts.

  // Preserve fields that aren't stored in the DB.
  //
  // This function rebuilds kangentic.json wholesale from the database, so any
  // key without a DB representation is DESTROYED unless it is carried across
  // here. Adding a config-only key elsewhere and forgetting this block means it
  // silently vanishes the first time anyone edits a column.
  if (existingTeamConfig?.shortcuts && existingTeamConfig.shortcuts.length > 0) {
    boardConfig.shortcuts = existingTeamConfig.shortcuts;
  }
  if (existingTeamConfig?.profiles && existingTeamConfig.profiles.length > 0) {
    boardConfig.profiles = existingTeamConfig.profiles;
  }
  if (existingTeamConfig?.defaultBaseBranch) {
    boardConfig.defaultBaseBranch = existingTeamConfig.defaultBaseBranch;
  }
  if (existingTeamConfig?.stopScript) {
    boardConfig.stopScript = existingTeamConfig.stopScript;
  }

  boardConfig._modifiedBy = fingerprint;
  return boardConfig;
}

/**
 * Serialize a column's automations into the file's named arrays, one per
 * trigger (`AUTOMATION_TRIGGER_FILE_KEYS`).
 *
 * Array order IS each row's position within its group, so the file, the UI's
 * groups, and the DB's per-trigger `position` are the same fact rather than
 * several that have to be kept in step. A group with no rows is an absent key,
 * and a column with no automations at all serializes to nothing.
 *
 * Only fields the type actually declares are written, so a config key left
 * behind by a type change (a script's retired `workingDir`, a webhook body kept
 * while the draft was briefly a notification) does not leak into a file the team
 * reviews.
 *
 * What this build does not understand is carried over from the file it last
 * read instead of dropped (`existing`): a list under a key it does not know, a
 * row whose type it does not know (kept after the row it followed), and a key
 * it does not know on a row it matches by name. The file is rebuilt from the
 * database, and none of those ever reached the database, so without this a
 * build older than whoever wrote the file strips their work on its next export
 * and the commit after that takes it from the whole team.
 */
export function serializeAutomations(
  automations: ColumnAutomation[],
  existing: Record<string, unknown> | null,
): BoardColumnAutomations | undefined {
  const result: Record<string, unknown> = {};
  for (const trigger of AUTOMATION_TRIGGERS) {
    const fileKey = AUTOMATION_TRIGGER_FILE_KEYS[trigger];
    const existingGroup = Array.isArray(existing?.[fileKey]) ? (existing?.[fileKey] as unknown[]) : [];
    const group = carryUnknownRows(serializeGroup(automations, trigger, existingGroup), existingGroup);
    if (group.length > 0) result[fileKey] = group;
  }
  if (existing) {
    const knownKeys = new Set<string>(Object.values(AUTOMATION_TRIGGER_FILE_KEYS));
    for (const [key, value] of Object.entries(existing)) {
      if (!knownKeys.has(key) && value !== undefined) result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? (result as BoardColumnAutomations) : undefined;
}

function serializeGroup(
  automations: ColumnAutomation[],
  trigger: AutomationTrigger,
  existingGroup: unknown[],
): BoardAutomationConfig[] {
  return automations
    .filter((automation) => automation.trigger === trigger)
    .sort((left, right) => left.position - right.position)
    .map((automation) => {
      const row: BoardAutomationConfig = { name: automation.name, type: automation.type };
      // Only `false` is written: an absent key means enabled, which keeps the
      // common row to two keys plus its fields.
      if (!automation.enabled) row.enabled = false;
      // One Condition kind per row, written as the dialog's card holds it: the
      // kind inside `condition`. One pattern stays a string, as a reader expects
      // in a diff; several are a list. The old `finalLine` key is never written.
      const text = textMatchFileValue(automation.final_line);
      if (text !== null) row.condition = { text };
      else if (automation.condition) row.condition = { agent: automation.condition };
      if (automation.max_runs !== null) row.maxRuns = automation.max_runs;

      const fields = isAutomationType(automation.type) ? AUTOMATION_MANIFEST[automation.type].fields : [];
      for (const field of fields) {
        const value = (automation.config as Record<string, unknown>)[field.key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object' && Object.keys(value as object).length === 0) continue;
        row[field.key] = value;
      }

      // Keys a newer build wrote on this same row, which this one has no field for.
      const existingRow = existingGroup.find(
        (candidate): candidate is Record<string, unknown> =>
          isJsonObject(candidate) && candidate.name === automation.name && candidate.type === automation.type,
      );
      if (existingRow) {
        const understood = understoodRowKeys(automation.type);
        for (const [key, value] of Object.entries(existingRow)) {
          if (!understood.has(key) && !(key in row) && value !== undefined) row[key] = value;
        }
      }
      return row;
    });
}

/**
 * Put back the rows of a type this build does not know, each right after the
 * nearest earlier row in the file that is still in the list (or first, when
 * none is). Order is the run order, so appending them at the end would change
 * what runs first, and so would anchoring on a row the user since deleted.
 */
function carryUnknownRows(group: BoardAutomationConfig[], existingGroup: unknown[]): BoardAutomationConfig[] {
  const merged = group.slice();
  let anchorName: string | null = null;
  for (const candidate of existingGroup) {
    if (!isJsonObject(candidate)) continue;
    const candidateType = typeof candidate.type === 'string' ? candidate.type : '';
    const candidateName = typeof candidate.name === 'string' ? candidate.name : null;
    const known = isAutomationType(candidateType) || candidateType === 'send_command' || isRetiredActionType(candidateType);
    if (!known && candidateName) {
      const anchorIndex = anchorName === null ? -1 : merged.findIndex((row) => row.name === anchorName);
      merged.splice(anchorIndex + 1, 0, candidate as BoardAutomationConfig);
      anchorName = candidateName;
    } else if (candidateName && merged.some((row) => row.name === candidateName)) {
      anchorName = candidateName;
    }
  }
  return merged;
}

/** The keys this build reads off a row of `type`: the row's own, the type's fields, and legacy keys. */
function understoodRowKeys(type: string): Set<string> {
  const keys = new Set<string>([...RESERVED_AUTOMATION_KEYS, 'command', 'workingDir']);
  if (isAutomationType(type)) {
    for (const field of AUTOMATION_MANIFEST[type].fields) keys.add(field.key);
  }
  return keys;
}

/** The column's `automations` object from the file on disk, when it is one. */
export function readExistingAutomations(column: BoardColumnConfig | null): Record<string, unknown> | null {
  const automations: unknown = column?.automations;
  return isJsonObject(automations) ? automations : null;
}
