import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { getProjectDb } from '../../db/database';
import type { BoardConfig, BoardColumnConfig } from '../../../shared/types';
import { CURRENT_VERSION } from './config-helpers';

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
  const actionRepo = new ActionRepository(db);

  const lanes = swimlaneRepo.list().filter((lane) => !lane.is_ghost);
  const actions = actionRepo.list();
  const transitions = actionRepo.listTransitions();

  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const actionById = new Map(actions.map((action) => [action.id, action]));

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
      if (lane.auto_command) column.autoCommand = lane.auto_command;
      if (lane.agent_override) column.agentOverride = lane.agent_override;
      if (lane.model_override) column.modelOverride = lane.model_override;
      if (lane.effort_override) column.effortOverride = lane.effort_override;
      if (lane.handoff_context) column.handoffContext = true;
      // Omit defaults so a backward-compatible board stays byte-identical until
      // a column is set non-default (matches the sibling fields above).
      if (lane.session_target !== 'main') column.sessionTarget = lane.session_target;
      if (lane.session_spawn_strategy !== 'create_or_resume') column.sessionSpawnStrategy = lane.session_spawn_strategy;

      // Resolve plan_exit_target_id to target column name
      if (lane.plan_exit_target_id) {
        const target = laneById.get(lane.plan_exit_target_id);
        if (target) column.planExitTarget = target.name;
      }

      return column;
    }),
    actions: actions.map((action) => ({
      id: action.id,
      name: action.name,
      type: action.type,
      config: JSON.parse(action.config_json),
    })),
    transitions: [],
  };

  // Group transitions by (from, to) using column/action names so the
  // serialized form stays stable across UUID regeneration.
  const transitionGroups = new Map<string, { from: string; to: string; actions: string[] }>();
  for (const transition of transitions) {
    const fromLane = transition.from_swimlane_id === '*' ? null : laneById.get(transition.from_swimlane_id);
    const toLane = laneById.get(transition.to_swimlane_id);
    const action = actionById.get(transition.action_id);

    const fromName = transition.from_swimlane_id === '*' ? '*' : fromLane?.name;
    const toName = toLane?.name;
    const actionName = action?.name;

    if (!fromName || !toName || !actionName) continue;

    const key = `${fromName}\0${toName}`;
    if (!transitionGroups.has(key)) {
      transitionGroups.set(key, { from: fromName, to: toName, actions: [] });
    }
    transitionGroups.get(key)!.actions.push(actionName);
  }
  boardConfig.transitions = Array.from(transitionGroups.values());

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
