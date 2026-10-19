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
} from '../../../shared/types';
import { CURRENT_VERSION } from './config-helpers';
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
 * Used by the write-back path (DB -> kangentic.json). The resulting
 * BoardConfig is stamped with `_modifiedBy = fingerprint` as last-writer
 * provenance (which device last wrote the file); it is not used to suppress
 * the reconciliation dialog (see computeFingerprint and onFileChanged).
 *
 * `existingTeamConfig` lets the caller pass in the currently-on-disk
 * kangentic.json so fields that are NOT stored in the DB (shortcuts,
 * defaultBaseBranch) are preserved across writes. Passing `null`
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
  const db = getProjectDb(params.projectId);
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

  const boardConfig: BoardConfig = {
    version: CURRENT_VERSION,
    columns: lanes.map((lane) => {
      const column: BoardColumnConfig = {
        id: lane.id,
        name: lane.name,
      };
      if (lane.role) column.role = lane.role;
      if (lane.description) column.description = lane.description;
      if (lane.icon) column.icon = lane.icon;
      if (lane.color && lane.color !== '#3b82f6') column.color = lane.color;
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
      if (lane.session_target !== 'main') column.sessionTarget = lane.session_target;
      if (lane.session_spawn_strategy !== 'create_or_resume') column.sessionSpawnStrategy = lane.session_spawn_strategy;
      if (lane.plan_approval !== 'manual') column.planApproval = lane.plan_approval;

      const existingColumn = params.existingTeamConfig?.columns?.find((candidate) => candidate.id === lane.id)
        ?? params.existingTeamConfig?.columns?.find((candidate) => candidate.name === lane.name)
        ?? null;
      const automations = serializeAutomations(
        automationsByLane.get(lane.id) ?? [],
        readExistingAutomations(existingColumn),
      );
      if (automations) column.automations = automations;

      // Resolve plan_exit_target_id to target column name
      if (lane.plan_exit_target_id) {
        const target = laneById.get(lane.plan_exit_target_id);
        if (target) column.planExitTarget = target.name;
      }

      return column;
    }),
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
  if (params.existingTeamConfig?.shortcuts && params.existingTeamConfig.shortcuts.length > 0) {
    boardConfig.shortcuts = params.existingTeamConfig.shortcuts;
  }
  if (params.existingTeamConfig?.profiles && params.existingTeamConfig.profiles.length > 0) {
    boardConfig.profiles = params.existingTeamConfig.profiles;
  }
  if (params.existingTeamConfig?.defaultBaseBranch) {
    boardConfig.defaultBaseBranch = params.existingTeamConfig.defaultBaseBranch;
  }

  boardConfig._modifiedBy = params.fingerprint;
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
function serializeAutomations(
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
      // One Condition kind per row: a Text match is written as `finalLine`, an
      // Agent evaluation as `condition`, and the other key is left out.
      if (automation.final_line) row.finalLine = automation.final_line;
      else if (automation.condition) row.condition = automation.condition;
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
          isPlainObject(candidate) && candidate.name === automation.name && candidate.type === automation.type,
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
    if (!isPlainObject(candidate)) continue;
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
function readExistingAutomations(column: BoardColumnConfig | null): Record<string, unknown> | null {
  const automations: unknown = column?.automations;
  return isPlainObject(automations) ? automations : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
