import type Database from 'better-sqlite3';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRepository } from '../../db/repositories/automation-repository';
import { setColumnMessage, setColumnMessageMode } from '../../automations/column-message';
import { resolveColumnMessage } from '../../transition-engine/column-strategy';
import { pruneDeletedColumnFromProfiles } from '../../config/board-config/prune-profile-references';
import { snapSpawnStrategyToTarget } from '../../../shared/session-track';
import { resolveColumn, listActiveSwimlanes } from './column-resolver';
import {
  VALID_PERMISSION_MODES,
  VALID_SESSION_TARGETS,
  VALID_SESSION_SPAWN_STRATEGIES,
  VALID_AUTO_COMMAND_MODES,
  parseEnumParam,
} from './column-enums';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type {
  AutoCommandMode,
  SwimlaneCreateInput,
  SwimlaneUpdateInput,
  SessionTarget,
  SessionSpawnStrategy,
} from '../../../shared/types';

/** The defaults a brand-new column starts at, matching the two NOT NULL column DEFAULTs. */
const DEFAULT_SESSION_TARGET: SessionTarget = 'main';
const DEFAULT_SESSION_SPAWN_STRATEGY: SessionSpawnStrategy = 'create_or_resume';

/**
 * The message this column actually sends, for the `autoCommand` field these
 * tools echo back. Goes through the same resolver the engine uses, so what a
 * caller reads is what the column will deliver.
 */
function readColumnMessage(db: Database.Database, swimlaneId: string): string | null {
  return resolveColumnMessage(new AutomationRepository(db).listForColumn(swimlaneId))?.message ?? null;
}

export const handleUpdateColumn: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;
  if (!columnName) {
    return { success: false, error: 'column is required' };
  }

  const db = context.getProjectDb();
  // includeArchivedDone: Done is a real, editable column - the Board Manager
  // lets a user rename and recolor it - and kangentic_list_columns now prints
  // it, so resolving it as "not found" was both a lie and a capability the UI
  // had and MCP did not. Nothing here can dislodge it from its structural role:
  // this handler never writes `role` or `is_archived`, and `auto_spawn` is inert
  // on a done lane (NEVER_AUTO_SPAWN_ROLES gates the transition engine). Renames
  // go unchecked for name collisions here, as they do for every other column.
  const resolution = resolveColumn(db, columnName, 'todo', { includeArchivedDone: true });
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
  // `autoCommand` is NOT a lane field any more. It writes the column's first
  // `send_message` enter automation, which is the row the engine delivers.
  // Deferred until after the lane write below, so a call that also renames the
  // column does not half-apply if the rename throws.
  const messageWrite = params.autoCommand === undefined
    ? null
    : { text: params.autoCommand === null ? null : String(params.autoCommand).slice(0, 4000) };
  if (messageWrite) {
    changedFields.push('autoCommand');
  }
  let messageMode: AutoCommandMode | undefined;
  if (params.autoCommandMode !== undefined && params.autoCommandMode !== null) {
    const parsed = parseEnumParam(params.autoCommandMode, VALID_AUTO_COMMAND_MODES, 'autoCommandMode');
    if ('error' in parsed) return { success: false, error: parsed.error };
    // The lane field is still written because the Column Manager round-trips
    // it, but it is NOT what the engine honours. The delivered mode lives on
    // the `send_message` row's config, so `messageMode` carries it down to the
    // automation write below. Writing only this line reported success and
    // changed nothing the delivery path reads.
    updates.auto_command_mode = parsed.value;
    messageMode = parsed.value;
    changedFields.push('autoCommandMode');
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
      const parsed = parseEnumParam(params.permissionMode, VALID_PERMISSION_MODES, 'permissionMode');
      if ('error' in parsed) return { success: false, error: parsed.error };
      updates.permission_mode = parsed.value;
    }
    changedFields.push('permissionMode');
  }
  if (params.handoffContext !== undefined && params.handoffContext !== null) {
    updates.handoff_context = Boolean(params.handoffContext);
    changedFields.push('handoffContext');
  }
  if (params.sessionTarget !== undefined && params.sessionTarget !== null) {
    const parsed = parseEnumParam(params.sessionTarget, VALID_SESSION_TARGETS, 'sessionTarget');
    if ('error' in parsed) return { success: false, error: parsed.error };
    updates.session_target = parsed.value;
    changedFields.push('sessionTarget');
  }
  if (params.sessionSpawnStrategy !== undefined && params.sessionSpawnStrategy !== null) {
    const parsed = parseEnumParam(params.sessionSpawnStrategy, VALID_SESSION_SPAWN_STRATEGIES, 'sessionSpawnStrategy');
    if ('error' in parsed) return { success: false, error: parsed.error };
    updates.session_spawn_strategy = parsed.value;
    changedFields.push('sessionSpawnStrategy');
  } else if (updates.session_target !== undefined) {
    // Target moved without an explicit strategy, so carry the track's default
    // across, exactly as the Column Manager's Session select does. This has to
    // WRITE the derived value rather than leave the field out: the repository's
    // update is read-modify-write off the existing row, not a sparse UPDATE, so
    // an omitted strategy re-persists the old one - which is how an isolated
    // review column ends up resuming its own previous review.
    const snapped = snapSpawnStrategyToTarget(
      swimlane.session_target,
      updates.session_target,
      swimlane.session_spawn_strategy,
    );
    if (snapped !== swimlane.session_spawn_strategy) {
      updates.session_spawn_strategy = snapped;
      changedFields.push('sessionSpawnStrategy');
    }
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
      error: 'No fields to update. Provide at least one of: name, description, color, icon, autoSpawn, autoCommand, autoCommandMode, agentOverride, modelOverride, effortOverride, permissionMode, handoffContext, sessionTarget, sessionSpawnStrategy, planExitTargetColumn.',
    };
  }

  const swimlaneRepo = new SwimlaneRepository(db);
  const updated = swimlaneRepo.update(updates);

  let messageNote = '';
  if (messageWrite) {
    const result = setColumnMessage(new AutomationRepository(db), updated.id, messageWrite.text, messageMode);
    messageNote = result.action === 'unchanged'
      ? ' This column had no message to clear.'
      : ` The message is the "${result.name}" automation on this column's On enter group (${result.action}).`;
  } else if (messageMode !== undefined) {
    // Mode with no message of its own to attach to. Says so rather than
    // reporting a success that moved nothing.
    const result = setColumnMessageMode(new AutomationRepository(db), updated.id, messageMode);
    messageNote = result.name === null
      ? ' It has no message for that delivery mode to apply to, so nothing is scheduled yet.'
      : ` The delivery mode is on the "${result.name}" automation on this column's On enter group.`;
  }

  // `swimlane` is the pre-update row resolved above. Handing it over lets the
  // host propagate the change into live sessions the same way the UI's
  // SWIMLANE_UPDATE does; without a before-row it cannot tell what changed.
  context.onSwimlaneUpdated(updated, swimlane);

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for column "${updated.name}".${messageNote}`,
    data: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      color: updated.color,
      icon: updated.icon,
      role: updated.role,
      autoSpawn: updated.auto_spawn,
      // The column's live message, read back off the automation. Echoing
      // `updated.auto_command` reported the retired field, which is null on
      // every board the migration has touched.
      autoCommand: readColumnMessage(db, updated.id),
      agentOverride: updated.agent_override,
      modelOverride: updated.model_override,
      effortOverride: updated.effort_override,
      permissionMode: updated.permission_mode,
      handoffContext: updated.handoff_context,
      sessionTarget: updated.session_target,
      sessionSpawnStrategy: updated.session_spawn_strategy,
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
  // Not a lane field. Written as the new column's message automation once the
  // row exists, since an automation needs its column's id.
  const initialMessage = params.autoCommand === undefined || params.autoCommand === null
    ? null
    : String(params.autoCommand).slice(0, 4000);
  // Validated here, the same way `handleUpdateColumn` validates it, rather than
  // coerced at the write below. Coercing turned every unrecognized value into
  // 'immediate' and still reported success, so a typo silently changed the
  // delivery mode instead of being refused. The MCP tool's zod schema catches
  // this for the released tool only; a direct handler call had nothing.
  let initialMessageMode: AutoCommandMode | undefined;
  if (params.autoCommandMode !== undefined && params.autoCommandMode !== null) {
    const parsed = parseEnumParam(params.autoCommandMode, VALID_AUTO_COMMAND_MODES, 'autoCommandMode');
    if ('error' in parsed) return { success: false, error: parsed.error };
    initialMessageMode = parsed.value;
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
    const parsed = parseEnumParam(params.permissionMode, VALID_PERMISSION_MODES, 'permissionMode');
    if ('error' in parsed) return { success: false, error: parsed.error };
    input.permission_mode = parsed.value;
  }
  if (params.handoffContext !== undefined && params.handoffContext !== null) {
    input.handoff_context = Boolean(params.handoffContext);
  }
  if (params.sessionTarget !== undefined && params.sessionTarget !== null) {
    const parsed = parseEnumParam(params.sessionTarget, VALID_SESSION_TARGETS, 'sessionTarget');
    if ('error' in parsed) return { success: false, error: parsed.error };
    input.session_target = parsed.value;
  }
  if (params.sessionSpawnStrategy !== undefined && params.sessionSpawnStrategy !== null) {
    const parsed = parseEnumParam(params.sessionSpawnStrategy, VALID_SESSION_SPAWN_STRATEGIES, 'sessionSpawnStrategy');
    if ('error' in parsed) return { success: false, error: parsed.error };
    input.session_spawn_strategy = parsed.value;
  } else if (input.session_target !== undefined) {
    // Same carry-the-default rule the Column Manager applies, measured from the
    // defaults a new column would otherwise take. Without it, asking for an
    // isolated column and nothing else persists 'create_or_resume', so the
    // column resumes one long conversation instead of running an independent
    // pass per entry - which is the whole point of isolating it.
    input.session_spawn_strategy = snapSpawnStrategyToTarget(
      DEFAULT_SESSION_TARGET,
      input.session_target,
      DEFAULT_SESSION_SPAWN_STRATEGY,
    );
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

  let messageNote = '';
  if (initialMessage) {
    const result = setColumnMessage(new AutomationRepository(db), created.id, initialMessage, initialMessageMode);
    messageNote = ` Its message is the "${result.name}" automation on its On enter group.`;
  }

  context.onSwimlaneUpdated(created);

  return {
    success: true,
    message: `Created column "${created.name}" at position ${created.position}.${messageNote}`,
    data: {
      id: created.id,
      name: created.name,
      description: created.description,
      color: created.color,
      icon: created.icon,
      role: created.role,
      position: created.position,
      autoSpawn: created.auto_spawn,
      autoCommand: readColumnMessage(db, created.id),
      agentOverride: created.agent_override,
      modelOverride: created.model_override,
      effortOverride: created.effort_override,
      permissionMode: created.permission_mode,
      handoffContext: created.handoff_context,
      sessionTarget: created.session_target,
      sessionSpawnStrategy: created.session_spawn_strategy,
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
  // The column's automations go with it (`deleteSwimlaneRowWithReferences`
  // drops them, and the foreign key cascades anyway). Counted and reported
  // because this is the part a caller actually loses: the transition count
  // above is zero on every board the automations migration has touched, so
  // reporting only that told an agent nothing had been cleaned up while its
  // column's whole enter and exit groups went with the delete.
  const automationCount = new AutomationRepository(db).listForColumn(swimlane.id).length;
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
  if (automationCount > 0) alsoCleaned.push(`${automationCount} automation(s)`);
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
      automationsRemoved: automationCount,
      transitionsRemoved: transitionCount,
      planExitReferencesCleared: planExitCount,
      profileEntriesRemoved: removedEntries,
      profilePlanExitTargetsCleared: clearedPlanExitTargets,
      remainingColumns: listActiveSwimlanes(db).map((lane) => lane.name),
    },
  };
};
