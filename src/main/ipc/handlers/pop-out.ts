import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { popOutWindowManager } from '../../pop-out/pop-out-window-manager';
import type { PopOutKind, PopOutParams } from '../../../shared/pop-out';
import type { IpcContext } from '../ipc-context';

export function registerPopOutHandlers(_context: IpcContext): void {
  ipcMain.handle(IPC.POPOUT_OPEN, (_event, kind: PopOutKind, params: PopOutParams) => {
    popOutWindowManager.open(kind, params);
  });
  ipcMain.handle(IPC.POPOUT_CLOSE, (_event, kind: PopOutKind, params: PopOutParams) => {
    popOutWindowManager.close(kind, params);
  });
  ipcMain.handle(IPC.POPOUT_FOCUS, (_event, kind: PopOutKind, params: PopOutParams) => {
    popOutWindowManager.focus(kind, params);
  });
  ipcMain.handle(IPC.POPOUT_IS_OPEN, (_event, kind: PopOutKind, params: PopOutParams) => {
    return popOutWindowManager.has(kind, params);
  });
  ipcMain.handle(IPC.POPOUT_LIST_OPEN, () => {
    return popOutWindowManager.listOpenKeys();
  });
}
