import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectRepos } from '../helpers';
import type { IpcContext } from '../ipc-context';

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

  // === Swimlanes ===
  ipcMain.handle(IPC.SWIMLANE_LIST, () => {
    const { swimlanes } = getProjectRepos(context);
    return swimlanes.list();
  });

  ipcMain.handle(IPC.SWIMLANE_CREATE, (_, input) => {
    const { swimlanes } = getProjectRepos(context);
    return swimlanes.create(input);
  });

  ipcMain.handle(IPC.SWIMLANE_UPDATE, (_, input) => {
    const { swimlanes } = getProjectRepos(context);
    return swimlanes.update(input);
  });

  ipcMain.handle(IPC.SWIMLANE_DELETE, (_, id) => {
    const { swimlanes } = getProjectRepos(context);
    swimlanes.delete(id);
  });

  ipcMain.handle(IPC.SWIMLANE_REORDER, (_, ids) => {
    const { swimlanes } = getProjectRepos(context);
    swimlanes.reorder(ids);
  });

  // === Actions ===
  ipcMain.handle(IPC.ACTION_LIST, () => {
    const { actions } = getProjectRepos(context);
    return actions.list();
  });

  ipcMain.handle(IPC.ACTION_CREATE, (_, input) => {
    const { actions } = getProjectRepos(context);
    return actions.create(input);
  });

  ipcMain.handle(IPC.ACTION_UPDATE, (_, input) => {
    const { actions } = getProjectRepos(context);
    return actions.update(input);
  });

  ipcMain.handle(IPC.ACTION_DELETE, (_, id) => {
    const { actions } = getProjectRepos(context);
    actions.delete(id);
  });

  // === Transitions ===
  ipcMain.handle(IPC.TRANSITION_LIST, () => {
    const { actions } = getProjectRepos(context);
    return actions.listTransitions();
  });

  ipcMain.handle(IPC.TRANSITION_SET, (_, fromId, toId, actionIds) => {
    const { actions } = getProjectRepos(context);
    actions.setTransitions(fromId, toId, actionIds);
  });

  ipcMain.handle(IPC.TRANSITION_GET_FOR, (_, fromId, toId) => {
    const { actions } = getProjectRepos(context);
    return actions.getTransitionsFor(fromId, toId);
  });
}
