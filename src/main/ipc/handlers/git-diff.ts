import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { DiffService } from '../../git/diff-service';
import { DiffWatcher } from '../../git/diff-watcher';
import type { GitDiffFilesInput, GitFileContentInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

export function registerGitDiffHandlers(context: IpcContext): void {
  const watcher = new DiffWatcher();

  ipcMain.handle(IPC.GIT_DIFF_FILES, async (_, input: GitDiffFilesInput) => {
    const service = new DiffService(input.worktreePath ?? input.projectPath);
    return service.getDiffFiles(input);
  });

  ipcMain.handle(IPC.GIT_FILE_CONTENT, async (_, input: GitFileContentInput) => {
    const service = new DiffService(input.worktreePath ?? input.projectPath);
    return service.getFileContent(input);
  });

  ipcMain.on(IPC.GIT_DIFF_SUBSCRIBE, (_, worktreePath: string) => {
    watcher.subscribe(worktreePath, () => {
      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.GIT_DIFF_CHANGED);
      }
    });
  });

  ipcMain.on(IPC.GIT_DIFF_UNSUBSCRIBE, (_, worktreePath: string) => {
    watcher.unsubscribe(worktreePath);
  });
}
