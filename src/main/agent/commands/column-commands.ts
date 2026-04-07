import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { resolveColumn } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';
import type { SwimlaneUpdateInput, PermissionMode } from '../../../shared/types';

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
      const targetResolution = resolveColumn(db, String(params.planExitTargetColumn));
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
      error: 'No fields to update. Provide at least one of: name, color, icon, autoSpawn, autoCommand, agentOverride, permissionMode, handoffContext, planExitTargetColumn.',
    };
  }

  const swimlaneRepo = new SwimlaneRepository(db);
  const updated = swimlaneRepo.update(updates);

  context.onSwimlaneUpdated(updated);

  return {
    success: true,
    message: `Updated ${changedFields.join(', ')} for column "${updated.name}".`,
    data: {
      id: updated.id,
      name: updated.name,
      color: updated.color,
      icon: updated.icon,
      role: updated.role,
      autoSpawn: updated.auto_spawn,
      autoCommand: updated.auto_command,
      agentOverride: updated.agent_override,
      permissionMode: updated.permission_mode,
      handoffContext: updated.handoff_context,
      planExitTargetId: updated.plan_exit_target_id,
    },
  };
};
