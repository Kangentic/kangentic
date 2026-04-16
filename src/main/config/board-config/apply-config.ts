import { v4 as uuidv4 } from 'uuid';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { getProjectDb } from '../../db/database';
import type { BoardConfig, SwimlaneRole } from '../../../shared/types';
import { CURRENT_VERSION, validateBoardConfig } from './config-helpers';

/**
 * Apply a BoardConfig (already loaded + merged from kangentic.json and
 * kangentic.local.json) as the source of truth for the project's SQLite
 * database. One-way sync from config -> DB. If the DB has drift, the
 * config wins.
 *
 * Runs inside a single DB transaction so partial failures don't leave
 * the board in a weird state. Returns a list of warnings for the
 * renderer to surface (duplicate names, missing system columns, etc.).
 *
 * Key invariants enforced here:
 *   - "To Do" role exists and is the first column.
 *   - "Done" role exists and is the last column.
 *   - Columns present in the DB but absent from config are either
 *     ghosted (if they hold tasks) or deleted (if empty), but only
 *     when the config uses id-tracked columns. Hand-written configs
 *     without ids are treated as additive to avoid wiping the DB.
 *   - Action and transition reconciliation mirrors the same additive-
 *     vs-destructive rule based on id presence.
 *
 * Pure in the sense that it touches only the DB (via repositories) and
 * the passed-in config object - no file I/O, no network.
 */
export function applyBoardConfigToDb(
  projectId: string,
  effectiveConfig: BoardConfig | null,
): { warnings: string[] } {
  const warnings: string[] = [];
  if (!effectiveConfig) return { warnings };

  const fatalError = validateBoardConfig(effectiveConfig);
  if (fatalError) {
    return { warnings: [fatalError] };
  }

  const config = effectiveConfig;
  const db = getProjectDb(projectId);
  const swimlaneRepo = new SwimlaneRepository(db);
  const actionRepo = new ActionRepository(db);

  if (config.version > CURRENT_VERSION) {
    warnings.push(`kangentic.json uses version ${config.version}. Some features may not be supported.`);
  }

  const transaction = db.transaction(() => {
    const existingLanes = swimlaneRepo.list();

    // Normalize legacy role: "backlog" → "todo" (backlog is now a separate view)
    for (const column of config.columns) {
      if (column.role === 'backlog' as SwimlaneRole) {
        column.role = 'todo';
        if (column.name === 'Backlog') column.name = 'To Do';
      }
    }

    const hasTodo = config.columns.some((column) => column.role === 'todo');
    if (!hasTodo) {
      const existingTodo = existingLanes.find((lane) => lane.role === 'todo');
      config.columns.unshift({
        id: existingTodo?.id,
        name: existingTodo?.name ?? 'To Do',
        role: 'todo',
        icon: 'layers',
        color: '#6b7280',
        autoSpawn: false,
      });
      warnings.push('kangentic.json is missing a To Do column. Added default.');
    }

    const hasDone = config.columns.some((column) => column.role === 'done');
    if (!hasDone) {
      const existingDone = existingLanes.find((lane) => lane.role === 'done');
      config.columns.push({
        id: existingDone?.id,
        name: existingDone?.name ?? 'Done',
        role: 'done',
        icon: 'circle-check-big',
        color: '#10b981',
        autoSpawn: false,
        archived: true,
      });
      warnings.push('kangentic.json is missing a done column. Added default.');
    }

    // Enforce position: To Do first, Done last.
    const todoIndex = config.columns.findIndex((column) => column.role === 'todo');
    if (todoIndex > 0) {
      const [todoColumn] = config.columns.splice(todoIndex, 1);
      config.columns.unshift(todoColumn);
      warnings.push('To Do column must be first. Position corrected.');
    }

    const doneIndex = config.columns.findIndex((column) => column.role === 'done');
    if (doneIndex >= 0 && doneIndex < config.columns.length - 1) {
      const [doneColumn] = config.columns.splice(doneIndex, 1);
      config.columns.push(doneColumn);
      warnings.push('Done column must be last. Position corrected.');
    }

    // --- Reconcile columns ---
    const existingById = new Map(existingLanes.map((lane) => [lane.id, lane]));
    const configIds = new Set(config.columns.filter((column) => column.id).map((column) => column.id!));

    for (let index = 0; index < config.columns.length; index++) {
      const columnConfig = config.columns[index];
      const existing = columnConfig.id ? existingById.get(columnConfig.id) : undefined;

      const isTodo = columnConfig.role === 'todo';
      const isDone = columnConfig.role === 'done';

      if (existing) {
        swimlaneRepo.update({
          id: existing.id,
          name: columnConfig.name,
          color: columnConfig.color ?? existing.color,
          icon: columnConfig.icon ?? existing.icon,
          position: index,
          is_archived: isDone ? true : (isTodo ? false : (columnConfig.archived ?? existing.is_archived)),
          is_ghost: false,
          permission_mode: (isTodo || isDone) ? null : (columnConfig.permissionMode ?? existing.permission_mode),
          auto_spawn: (isTodo || isDone) ? false : (columnConfig.autoSpawn ?? existing.auto_spawn),
          auto_command: columnConfig.autoCommand ?? existing.auto_command,
          agent_override: (isTodo || isDone) ? null : (columnConfig.agentOverride ?? existing.agent_override),
          handoff_context: columnConfig.handoffContext ?? existing.handoff_context,
        });
      } else {
        swimlaneRepo.create({
          id: columnConfig.id,
          name: columnConfig.name,
          role: columnConfig.role as SwimlaneRole | undefined,
          color: columnConfig.color ?? '#3b82f6',
          icon: columnConfig.icon ?? null,
          is_archived: isDone ? true : (isTodo ? false : (columnConfig.archived ?? false)),
          is_ghost: false,
          permission_mode: (isTodo || isDone) ? null : (columnConfig.permissionMode ?? null),
          auto_spawn: (isTodo || isDone) ? false : (columnConfig.autoSpawn ?? true),
          auto_command: columnConfig.autoCommand ?? null,
          agent_override: (isTodo || isDone) ? null : (columnConfig.agentOverride ?? null),
          handoff_context: columnConfig.handoffContext ?? false,
          position: index,
        });
      }
    }

    // Ghost or delete columns not in config.
    // Skip when no config entries have ids (hand-written config without ids is additive,
    // not destructive. Write-back will serialize the new UUIDs for future reconciliation.)
    if (configIds.size > 0) {
      for (const existing of existingLanes) {
        if (configIds.has(existing.id)) continue;
        if (existing.is_ghost) continue;

        const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?').get(existing.id) as { c: number };
        if (taskCount.c > 0) {
          swimlaneRepo.setGhost(existing.id, true);
        } else {
          db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?').run(existing.id, existing.id);
          db.prepare('UPDATE swimlanes SET plan_exit_target_id = NULL WHERE plan_exit_target_id = ?').run(existing.id);
          db.prepare('DELETE FROM swimlanes WHERE id = ?').run(existing.id);
        }
      }
    }

    swimlaneRepo.deleteEmptyGhosts();

    // --- Reconcile actions ---
    const existingActions = actionRepo.list();
    const existingActionsById = new Map(existingActions.map((action) => [action.id, action]));
    const configActionIds = new Set((config.actions || []).filter((action) => action.id).map((action) => action.id!));

    for (const actionConfig of (config.actions || [])) {
      const existing = actionConfig.id ? existingActionsById.get(actionConfig.id) : undefined;

      if (existing) {
        actionRepo.update({
          id: existing.id,
          name: actionConfig.name,
          type: actionConfig.type,
          config_json: JSON.stringify(actionConfig.config),
        });
      } else {
        actionRepo.create({
          id: actionConfig.id,
          name: actionConfig.name,
          type: actionConfig.type,
          config_json: JSON.stringify(actionConfig.config),
        });
      }
    }

    if (configActionIds.size > 0) {
      for (const existing of existingActions) {
        if (configActionIds.has(existing.id)) continue;
        actionRepo.delete(existing.id);
      }
    }

    // --- Reconcile transitions ---
    // Delete-and-replace only the (from, to) pairs that appear in config.
    // Pairs NOT mentioned in config are preserved.
    if (config.transitions && config.transitions.length > 0) {
      const reconciledLanes = swimlaneRepo.list();
      const reconciledActions = actionRepo.list();
      const laneByName = new Map(reconciledLanes.map((lane) => [lane.name, lane]));
      const actionByName = new Map(reconciledActions.map((action) => [action.name, action]));

      for (const transitionConfig of config.transitions) {
        const toLane = laneByName.get(transitionConfig.to);
        if (!toLane) {
          warnings.push(`Transition references unknown column '${transitionConfig.to}'. Skipped.`);
          continue;
        }

        const fromId = transitionConfig.from === '*' ? '*' : laneByName.get(transitionConfig.from)?.id;
        if (!fromId) {
          warnings.push(`Transition references unknown column '${transitionConfig.from}'. Skipped.`);
          continue;
        }

        db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ?')
          .run(fromId, toLane.id);

        for (let order = 0; order < transitionConfig.actions.length; order++) {
          const actionName = transitionConfig.actions[order];
          const action = actionByName.get(actionName);
          if (!action) {
            warnings.push(`Transition references unknown action '${actionName}'. Skipped.`);
            continue;
          }

          db.prepare(
            'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)'
          ).run(uuidv4(), fromId, toLane.id, action.id, order);
        }
      }
    }

    // --- Resolve planExitTarget name -> UUID ---
    const finalLanes = swimlaneRepo.list();
    const finalLaneByName = new Map(finalLanes.map((lane) => [lane.name, lane]));

    for (const columnConfig of config.columns) {
      if (!columnConfig.planExitTarget) continue;
      const sourceLane = finalLaneByName.get(columnConfig.name);
      const targetLane = finalLaneByName.get(columnConfig.planExitTarget);
      if (sourceLane && targetLane) {
        swimlaneRepo.update({
          id: sourceLane.id,
          plan_exit_target_id: targetLane.id,
        });
      } else if (sourceLane && !targetLane) {
        swimlaneRepo.update({
          id: sourceLane.id,
          plan_exit_target_id: null,
        });
        warnings.push(`planExitTarget references unknown column '${columnConfig.planExitTarget}'. Cleared.`);
      }
    }
  });

  transaction();
  return { warnings };
}
