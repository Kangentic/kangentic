import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRepository } from '../../db/repositories/automation-repository';
import { getProjectDb } from '../../db/database';
import type {
  BoardConfig,
  BoardColumnConfig,
  BoardAutomationConfig,
  BoardColumnAutomations,
  ColumnAutomation,
} from '../../../shared/types';
import { CURRENT_VERSION } from './config-helpers';
import { AUTOMATION_MANIFEST, isAutomationType } from '../../../shared/automation-manifest';

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

      const automations = serializeAutomations(automationsByLane.get(lane.id) ?? []);
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
 * Serialize a column's automations into the file's two named arrays.
 *
 * Array order IS each row's position within its group, so the file, the UI's two
 * groups, and the DB's per-trigger `position` are the same fact rather than
 * three that have to be kept in step. A group with no rows is an absent key, and
 * a column with no automations at all serializes to nothing.
 *
 * Only fields the type actually declares are written, so a config key left
 * behind by a type change (a script's retired `workingDir`, a webhook body kept
 * while the draft was briefly a notification) does not leak into a file the team
 * reviews.
 */
function serializeAutomations(automations: ColumnAutomation[]): BoardColumnAutomations | undefined {
  const onEnter = serializeGroup(automations, 'enter');
  const onExit = serializeGroup(automations, 'exit');
  if (onEnter.length === 0 && onExit.length === 0) return undefined;

  const result: BoardColumnAutomations = {};
  if (onEnter.length > 0) result.onEnter = onEnter;
  if (onExit.length > 0) result.onExit = onExit;
  return result;
}

function serializeGroup(automations: ColumnAutomation[], trigger: 'enter' | 'exit'): BoardAutomationConfig[] {
  return automations
    .filter((automation) => automation.trigger === trigger)
    .sort((left, right) => left.position - right.position)
    .map((automation) => {
      const row: BoardAutomationConfig = { name: automation.name, type: automation.type };
      // Only `false` is written: an absent key means enabled, which keeps the
      // common row to two keys plus its fields.
      if (!automation.enabled) row.enabled = false;

      const fields = isAutomationType(automation.type) ? AUTOMATION_MANIFEST[automation.type].fields : [];
      for (const field of fields) {
        const value = (automation.config as Record<string, unknown>)[field.key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object' && Object.keys(value as object).length === 0) continue;
        row[field.key] = value;
      }
      return row;
    });
}
