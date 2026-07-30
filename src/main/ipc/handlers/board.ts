import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectRepos } from '../helpers';
import { applyProfileToLane, findTaskProfile } from '../../transition-engine/column-strategy';
import { pruneDeletedColumnFromProfiles } from '../../config/board-config/prune-profile-references';
import { propagateStrategyToLiveSessions, propagateBoardProfileChange } from './strategy-propagation';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';
import type { BoardProfile, ShortcutConfig } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/** Trigger write-back if kangentic.json exists. */
function triggerWriteBack(context: IpcContext): void {
  try {
    context.boardConfigManager.writeBack();
  } catch {
    // Non-fatal: write-back failure should never block UI operations
  }
}

export function registerBoardHandlers(context: IpcContext): void {
  // === Attachments ===
  ipcMain.handle(IPC.ATTACHMENT_LIST, (_, taskId: string) => {
    const { attachments } = getProjectRepos(context);
    return attachments.list(taskId);
  });

  ipcMain.handle(IPC.ATTACHMENT_ADD, (_, input: { task_id: string; filename: string; data: string; media_type: string }) => {
    if (!context.currentProjectPath) throw new Error('No project open');
    const maxSize = 10 * 1024 * 1024; // 10MB
    const dataSize = Buffer.byteLength(input.data, 'base64');
    if (dataSize > maxSize) throw new Error(`Attachment exceeds 10MB limit (${(dataSize / 1024 / 1024).toFixed(1)}MB)`);
    const { attachments } = getProjectRepos(context);
    return attachments.add(context.currentProjectPath, input.task_id, input.filename, input.data, input.media_type);
  });

  ipcMain.handle(IPC.ATTACHMENT_REMOVE, (_, id: string) => {
    const { attachments } = getProjectRepos(context);
    attachments.remove(id);
  });

  ipcMain.handle(IPC.ATTACHMENT_GET_DATA_URL, (_, id: string) => {
    const { attachments } = getProjectRepos(context);
    return attachments.getDataUrl(id);
  });

  ipcMain.handle(IPC.ATTACHMENT_OPEN, (_, id: string) => {
    const { attachments } = getProjectRepos(context);
    const attachment = attachments.getById(id);
    if (!attachment) throw new Error(`Attachment ${id} not found`);
    // Copy to temp dir with original filename to avoid long-path issues on Windows
    // and ensure the OS opens it with the correct default app
    const tempDir = path.join(os.tmpdir(), 'kangentic-attachments');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, attachment.id + '_' + attachment.filename);
    fs.copyFileSync(attachment.file_path, tempPath);
    return shell.openPath(tempPath);
  });

  // === Swimlanes ===
  ipcMain.handle(IPC.SWIMLANE_LIST, () => {
    const { swimlanes } = getProjectRepos(context);
    return swimlanes.list();
  });

  ipcMain.handle(IPC.SWIMLANE_CREATE, (_, input) => {
    const { swimlanes } = getProjectRepos(context);
    const result = swimlanes.create(input);
    triggerWriteBack(context);
    return result;
  });

  ipcMain.handle(IPC.SWIMLANE_UPDATE, (_, input) => {
    const { swimlanes, tasks } = getProjectRepos(context);
    const before = swimlanes.getById(input.id);
    const result = swimlanes.update(input);
    triggerWriteBack(context);

    // When a column's model/effort overrides change, propagate the new
    // settings to any tasks already living in that column with an active
    // PTY session. Suspended/queued sessions don't need a hand: the
    // prepare-spawn path reads `swimlane.model_override`/`effort_override`
    // directly when they resume, so they pick up the new flags
    // automatically. Without this propagation, in-flight sessions would
    // keep the prior model/effort until the user moved them out and back.
    //
    // Per-task injection is delegated to prepareInjectionPlan so the
    // slash syntax + verifier wiring lives on each adapter, not here. The
    // delta source is each session's recorded `applied_model`/`applied_effort`
    // (its true running value), so editing a column from e.g. Default to xhigh
    // propagates to a session running at the default, but re-saving a column at
    // a value the session already has injects nothing.
    //
    // The before/after are folded PER TASK so a task riding a Board Profile is
    // judged on its own rung: editing this column's model must not push that
    // model into a task whose profile pins a different one here. The shared
    // helper owns the gate and the inject-vs-restart decision, so a profile edit
    // (below) behaves identically.
    const boardProfiles = context.boardConfigManager.getBoardProfiles();
    const laneList = swimlanes.list();
    propagateStrategyToLiveSessions(
      context,
      'SWIMLANE_UPDATE',
      tasks.list(result.id).map((task) => {
        const profile = findTaskProfile({ profiles: boardProfiles, profileId: task.profile_id, taskId: task.id });
        return {
          task,
          before: applyProfileToLane(before, profile, laneList),
          after: applyProfileToLane(result, profile, laneList),
          sourceName: result.name,
        };
      }),
    );

    return result;
  });

  ipcMain.handle(IPC.SWIMLANE_DELETE, (_, id) => {
    const { swimlanes } = getProjectRepos(context);
    // Snapshot before the delete: pruning profiles needs the name, which is gone
    // from the DB once the row is.
    const swimlaneToDelete = swimlanes.getById(id);
    swimlanes.delete(id);
    // Board Profiles live in kangentic.json with no FK, so nothing else clears a
    // delta keyed to this column or a planExitTarget naming it. Must run BEFORE
    // the write-back, which carries `profiles` across from the on-disk file.
    if (swimlaneToDelete) {
      pruneDeletedColumnFromProfiles(
        {
          getBoardProfiles: () => context.boardConfigManager.getBoardProfiles(),
          setBoardProfiles: (profiles) => context.boardConfigManager.setBoardProfiles(profiles),
        },
        { columnId: swimlaneToDelete.id, columnName: swimlaneToDelete.name },
      );
    }
    triggerWriteBack(context);
  });

  ipcMain.handle(IPC.SWIMLANE_REORDER, (_, ids) => {
    const { swimlanes } = getProjectRepos(context);
    swimlanes.reorder(ids);
    triggerWriteBack(context);
  });

  // === Actions ===
  ipcMain.handle(IPC.ACTION_LIST, () => {
    const { actions } = getProjectRepos(context);
    return actions.list();
  });

  ipcMain.handle(IPC.ACTION_CREATE, (_, input) => {
    const { actions } = getProjectRepos(context);
    const result = actions.create(input);
    triggerWriteBack(context);
    return result;
  });

  ipcMain.handle(IPC.ACTION_UPDATE, (_, input) => {
    const { actions } = getProjectRepos(context);
    const result = actions.update(input);
    triggerWriteBack(context);
    return result;
  });

  ipcMain.handle(IPC.ACTION_DELETE, (_, id) => {
    const { actions } = getProjectRepos(context);
    actions.delete(id);
    triggerWriteBack(context);
  });

  // === Transitions ===
  ipcMain.handle(IPC.TRANSITION_LIST, () => {
    const { actions } = getProjectRepos(context);
    return actions.listTransitions();
  });

  ipcMain.handle(IPC.TRANSITION_SET, (_, fromId, toId, actionIds) => {
    const { actions } = getProjectRepos(context);
    actions.setTransitions(fromId, toId, actionIds);
    triggerWriteBack(context);
  });

  ipcMain.handle(IPC.TRANSITION_GET_FOR, (_, fromId, toId) => {
    const { actions } = getProjectRepos(context);
    return actions.getTransitionsFor(fromId, toId);
  });

  // === Board Config ===
  ipcMain.handle(IPC.BOARD_CONFIG_EXISTS, () => {
    return context.boardConfigManager.exists();
  });

  ipcMain.handle(IPC.BOARD_CONFIG_EXPORT, () => {
    context.boardConfigManager.exportFromDb();
  });

  ipcMain.handle(IPC.BOARD_CONFIG_APPLY, (_, projectId: string) => {
    const project = context.projectRepo.getById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    // Reconcile is keyed to an explicit projectId (the kangentic.json file
    // watcher fires it for whichever project changed, not necessarily the
    // focused one), so tag the [BOARD_CONFIG] reconcile warnings with that
    // project regardless of which board the user is looking at.
    return runWithProjectLogContext(project.name, () => {
      const result = context.boardConfigManager.applyFileChange(projectId, project.path);
      return result.warnings;
    });
  });

  ipcMain.handle(IPC.BOARD_CONFIG_GET_BOARD_PROFILES, () => {
    return context.boardConfigManager.getBoardProfiles();
  });

  ipcMain.handle(IPC.BOARD_CONFIG_SET_BOARD_PROFILES, (_, profiles: BoardProfile[]) => {
    // Snapshot BEFORE the write: retuning a profile has to reach the live
    // sessions of the tasks riding it, exactly as editing a column reaches the
    // sessions in that column. Without this a task on an edited profile kept its
    // old model until the user moved it out and back - the settings-edit path
    // silently applied to one authoring surface and not the other.
    const previousProfiles = context.boardConfigManager.getBoardProfiles();
    context.boardConfigManager.setBoardProfiles(profiles);
    propagateBoardProfileChange(context, previousProfiles, profiles);
  });

  ipcMain.handle(IPC.BOARD_CONFIG_GET_SHORTCUTS, () => {
    return context.boardConfigManager.getShortcuts();
  });

  ipcMain.handle(IPC.BOARD_CONFIG_SET_SHORTCUTS, (_, actions: ShortcutConfig[], target: 'team' | 'local') => {
    context.boardConfigManager.setShortcuts(actions, target);
  });

  ipcMain.handle(IPC.BOARD_CONFIG_SET_DEFAULT_BASE_BRANCH, (_, branch: string) => {
    context.boardConfigManager.setDefaultBaseBranch(branch);
  });
}
