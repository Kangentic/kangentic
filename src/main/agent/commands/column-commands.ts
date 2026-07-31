import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { pruneDeletedColumnFromProfiles } from '../../config/board-config/prune-profile-references';
import { resolveColumn, listActiveSwimlanes } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { SwimlaneCreateInput, SwimlaneUpdateInput, PermissionMode } from '../../../shared/types';

const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'];

export const handleUpdateColumn: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const db = context.getProjectDb();
  const resolution = resolveColumn(db, columnName);
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane } = resolution;

  const updates: SwimlaneUpdateInput = { id: swimlane.id };
  const changedFields: string[] = [];

  if (params.name !== undefined && params.name !== null) {
    updates.name = String(params.name).slice(0, 100);
    changedFields.push('name');
  }
  if (params.description !== undefined) {
    updates.description = params.description === null ? null : String(params.description).slice(0, 1000);
    changedFields.push('description');
  }
  if (params.color !== undefined && params.color !== null) {
    updates.color = String(params.color);
    changedFields.push('color');
  }
  if (params.icon !== undefined) {
    updates.icon = params.icon === null ? null : String(params.icon);
    changedFields.push('icon');
  }
  if (params.autoSpawn !== undefined && params.autoSpawn !== null) {
    updates.auto_spawn = Boolean(params.autoSpawn);
    changedFields.push('autoSpawn');
  }
  if (params.autoCommand !== undefined) {
    updates.auto_command = params.autoCommand === null ? null : String(params.autoCommand).slice(0, 4000);
    changedFields.push('autoCommand');
  }
  if (params.agentOverride !== undefined) {
    updates.agent_override = params.agentOverride === null ? null : String(params.agentOverride);
    changedFields.push('agentOverride');
  }
  if (params.modelOverride !== undefined) {
    updates.model_override = params.modelOverride === null ? null : String(params.modelOverride).slice(0, 200);
    changedFields.push('modelOverride');
  }
  if (params.effortOverride !== undefined) {
    updates.effort_override = params.effortOverride === null ? null : String(params.effortOverride).slice(0, 50);
    changedFields.push('effortOverride');
  }
  if (params.permissionMode !== undefined) {
    if (params.permissionMode === null) {
      updates.permission_mode = null;
    } else {
      const mode = String(params.permissionMode);
      if (!VALID_PERMISSION_MODES.includes(mode as PermissionMode)) {
        return {
          success: false,
          error: `Invalid permissionMode "${mode}". Valid values: ${VALID_PERMISSION_MODES.join(', ')}.`,
        };
      }
      updates.permission_mode = mode as PermissionMode;
    }
    changedFields.push('permissionMode');
  }
  if (params.handoffContext !== undefined && params.handoffContext !== null) {
    updates.handoff_context = Boolean(params.handoffContext);
    changedFields.push('handoffContext');
  }
  if (params.planExitTargetColumn !== undefined) {
    if (params.planExitTargetColumn === null) {
      updates.plan_exit_target_id = null;
    } else {
      // includeArchivedDone: Done is stored archived, and "plan, then move
      // straight to Done" is a real workflow. Without the flag it resolved as
      // "Column not found", which read as a typo rather than a limitation.
      // Matches handleCreateColumn.
      const targetResolution = resolveColumn(db, String(params.planExitTargetColumn), 'todo', { includeArchivedDone: true });
      if ('error' in targetResolution) {
        return { success: false, error: `planExitTargetColumn: ${targetResolution.error}` };
      }
      updates.plan_exit_target_id = targetResolution.swimlane.id;
    }
    changedFields.push('planExitTargetColumn');
  }

  if (changedFields.length === 0) {
    return {
      success: false,
      error: 'No fields to update. Provide at least one of: name, description, color, icon, autoSpawn, autoCommand, agentOverride, modelOverride, effortOverride, permissionMode, handoffContext, planExitTargetColumn.',
    };
  }

  const swimlaneRepo = new SwimlaneRepository(db);
  const updated = swimlaneRepo.update(updates);

  // `swimlane` is the pre-update row resolved above. Handing it over lets the
  // host propagate the change into live sessions the same way the UI's
  // SWIMLANE_UPDATE does; without a before-row it cannot tell what changed.
  context.onSwimlaneUpdated(updated, swimlane);

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for column "${updated.name}".`,
    data: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      color: updated.color,
      icon: updated.icon,
      role: updated.role,
      autoSpawn: updated.auto_spawn,
      autoCommand: updated.auto_command,
      agentOverride: updated.agent_override,
      modelOverride: updated.model_override,
      effortOverride: updated.effort_override,
      permissionMode: updated.permission_mode,
      handoffContext: updated.handoff_context,
      planExitTargetId: updated.plan_exit_target_id,
    },
  };
};

export const handleCreateColumn: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const rawName = params.name === undefined || params.name === null ? '' : String(params.name).trim();
  if (!rawName) {
    return { success: false, error: 'name is required' };
  }
  const name = rawName.slice(0, 100);

  const db = context.getProjectDb();
  const swimlaneRepo = new SwimlaneRepository(db);

  // Case-insensitive duplicate check, matching the Column Manager's. Checked
  // against EVERY lane, not just the resolvable ones, so a new column cannot
  // collide with archived Done or a ghost and produce two lanes sharing a name
  // (which `apply-config.ts` then rejects as an invalid config).
  const existingLanes = swimlaneRepo.list();
  const collision = existingLanes.find((lane) => lane.name.trim().toLowerCase() === name.toLowerCase());
  if (collision) {
    return { success: false, error: `A column named "${collision.name}" already exists. Column names must be unique.` };
  }

  const input: SwimlaneCreateInput & { position?: number } = { name };

  if (params.description !== undefined && params.description !== null) {
    input.description = String(params.description).slice(0, 1000);
  }
  if (params.color !== undefined && params.color !== null) {
    input.color = String(params.color);
  }
  if (params.icon !== undefined && params.icon !== null) {
    input.icon = String(params.icon);
  }
  if (params.autoSpawn !== undefined && params.autoSpawn !== null) {
    input.auto_spawn = Boolean(params.autoSpawn);
  }
  if (params.autoCommand !== undefined && params.autoCommand !== null) {
    input.auto_command = String(params.autoCommand).slice(0, 4000);
  }
  if (params.agentOverride !== undefined && params.agentOverride !== null) {
    input.agent_override = String(params.agentOverride);
  }
  if (params.modelOverride !== undefined && params.modelOverride !== null) {
    input.model_override = String(params.modelOverride).slice(0, 200);
  }
  if (params.effortOverride !== undefined && params.effortOverride !== null) {
    input.effort_override = String(params.effortOverride).slice(0, 50);
  }
  if (params.permissionMode !== undefined && params.permissionMode !== null) {
    const mode = String(params.permissionMode);
    if (!VALID_PERMISSION_MODES.includes(mode as PermissionMode)) {
      return {
        success: false,
        error: `Invalid permissionMode "${mode}". Valid values: ${VALID_PERMISSION_MODES.join(', ')}.`,
      };
    }
    input.permission_mode = mode as PermissionMode;
  }
  if (params.handoffContext !== undefined && params.handoffContext !== null) {
    input.handoff_context = Boolean(params.handoffContext);
  }
  if (params.planExitTargetColumn !== undefined && params.planExitTargetColumn !== null) {
    const targetResolution = resolveColumn(db, String(params.planExitTargetColumn), 'todo', { includeArchivedDone: true });
    if ('error' in targetResolution) {
      return { success: false, error: `planExitTargetColumn: ${targetResolution.error}` };
    }
    input.plan_exit_target_id = targetResolution.swimlane.id;
  }

  // Placement. With `position` omitted, the repository already inserts before
  // Done and shifts the lanes at or after it, so the common case needs nothing.
  // An EXPLICIT position is taken raw by the repository with no shift, so make
  // room here or the new lane collides with an existing one's number.
  if (params.position !== undefined && params.position !== null) {
    const requested = Number(params.position);
    if (!Number.isInteger(requested) || requested < 0) {
      return { success: false, error: `Invalid position "${String(params.position)}". Provide a whole number >= 0, or omit it to place the column just before Done.` };
    }
    // `position` is documented (and schema'd) as a zero-based SLOT: an ordinal
    // index into the lane order. But the shift below and the repository both work
    // in RAW `position` values, and the two diverge the moment the sequence has a
    // gap. Deleting a lane leaves exactly that: nothing renumbers the survivors,
    // so a board can sit at 0,2,3,4 indefinitely. Reading the ordinal as a raw
    // value then sweeps a lane whose raw position merely coincides with the
    // requested ordinal, landing the column a slot early. So resolve the ordinal
    // against the ordered lanes and shift from the raw anchor it names.
    //
    // Clamp to the slots BETWEEN the role columns first. Slot 0 belongs to To Do
    // and the last to Done, and neither is a legal home for a role-less column:
    // `SwimlaneRepository.reorder` refuses any order whose first id has no role,
    // so a column created at slot 0 wedges every later reorder from the Column
    // Manager, and `apply-config.ts` re-sorts Done last on the next project open,
    // silently relocating a column created past Done.
    //
    // `swimlaneRepo.list()` is already `ORDER BY position ASC`, so index order is
    // slot order and includes archived Done plus any ghosts, exactly the sequence
    // the raw positions describe.
    const todoIndex = existingLanes.findIndex((lane) => lane.role === 'todo');
    const doneIndex = existingLanes.findIndex((lane) => lane.role === 'done');
    const lowestSlot = todoIndex >= 0 ? todoIndex + 1 : 0;
    const highestSlot = doneIndex >= 0 ? doneIndex : existingLanes.length;
    const slot = Math.min(Math.max(requested, lowestSlot), highestSlot);
    const lastPosition = existingLanes.length > 0 ? existingLanes[existingLanes.length - 1].position : -1;
    input.position = existingLanes[slot]?.position ?? lastPosition + 1;
  }

  // The shift and the insert are one transaction: a create that throws after the
  // shift would otherwise leave every later column bumped a slot with nothing
  // filling the gap.
  const created = db.transaction(() => {
    if (input.position !== undefined) {
      db.prepare('UPDATE swimlanes SET position = position + 1 WHERE position >= ?').run(input.position);
    }
    return swimlaneRepo.create(input);
  })();

  context.onSwimlaneUpdated(created);

  return {
    success: true,
    message: `Created column "${created.name}" at position ${created.position}.`,
    data: {
      id: created.id,
      name: created.name,
      description: created.description,
      color: created.color,
      icon: created.icon,
      role: created.role,
      position: created.position,
      autoSpawn: created.auto_spawn,
      autoCommand: created.auto_command,
      agentOverride: created.agent_override,
      modelOverride: created.model_override,
      effortOverride: created.effort_override,
      permissionMode: created.permission_mode,
      handoffContext: created.handoff_context,
      planExitTargetId: created.plan_exit_target_id,
    },
  };
};

export const handleDeleteColumn: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const db = context.getProjectDb();
  // includeArchivedDone is load-bearing: Done is stored archived, so without it
  // `delete_column({column: "Done"})` reports a bare "not found" instead of the
  // role refusal below, and the caller never learns WHY it cannot be deleted.
  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane } = resolution;

  if (swimlane.role) {
    return {
      success: false,
      error: `Cannot delete "${swimlane.name}": it is this board's ${swimlane.role} column and the board depends on it. Rename it instead if you want different wording.`,
    };
  }

  const taskCount = (db
    .prepare('SELECT COUNT(*) as count FROM tasks WHERE swimlane_id = ?')
    .get(swimlane.id) as { count: number } | undefined)?.count ?? 0;
  if (taskCount > 0) {
    return {
      success: false,
      error: `Cannot delete "${swimlane.name}": it holds ${taskCount} task(s). Move them to another column with kangentic_move_task (or delete them) first, then retry.`,
    };
  }

  // Counted before the delete: these rows are gone once it runs, and the caller
  // deserves to know what else the deletion took with it.
  const transitionCount = (db
    .prepare('SELECT COUNT(*) as count FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?')
    .get(swimlane.id, swimlane.id) as { count: number } | undefined)?.count ?? 0;
  const planExitCount = (db
    .prepare('SELECT COUNT(*) as count FROM swimlanes WHERE plan_exit_target_id = ?')
    .get(swimlane.id) as { count: number } | undefined)?.count ?? 0;

  const swimlaneRepo = new SwimlaneRepository(db);
  // Re-checks both guards above. Kept as defense in depth rather than reaching
  // for the raw helper: the guards are the repository's contract, not ours.
  swimlaneRepo.delete(swimlane.id);

  // Profiles live in kangentic.json with no FK, so nothing above touches them.
  // Runs BEFORE onSwimlaneDeleted, whose write-back would otherwise re-serialize
  // the stale entries straight back out of the on-disk file.
  const { removedEntries, clearedPlanExitTargets } = pruneDeletedColumnFromProfiles(
    { getBoardProfiles: context.getBoardProfiles, setBoardProfiles: context.setBoardProfiles },
    { columnId: swimlane.id, columnName: swimlane.name },
  );

  context.onSwimlaneDeleted(swimlane);

  const alsoCleaned: string[] = [];
  if (transitionCount > 0) alsoCleaned.push(`${transitionCount} transition(s)`);
  if (planExitCount > 0) alsoCleaned.push(`${planExitCount} plan-exit reference(s)`);
  if (removedEntries > 0) alsoCleaned.push(`${removedEntries} board-profile entr${removedEntries === 1 ? 'y' : 'ies'}`);
  if (clearedPlanExitTargets > 0) alsoCleaned.push(`${clearedPlanExitTargets} profile plan-exit target(s)`);

  return {
    success: true,
    message: alsoCleaned.length > 0
      ? `Deleted column "${swimlane.name}". Also cleaned up ${alsoCleaned.join(', ')}.`
      : `Deleted column "${swimlane.name}".`,
    data: {
      id: swimlane.id,
      name: swimlane.name,
      transitionsRemoved: transitionCount,
      planExitReferencesCleared: planExitCount,
      profileEntriesRemoved: removedEntries,
      profilePlanExitTargetsCleared: clearedPlanExitTargets,
      remainingColumns: listActiveSwimlanes(db).map((lane) => lane.name),
    },
  };
};
