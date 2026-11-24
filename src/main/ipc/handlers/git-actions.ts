import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type {
  GitActionResult,
  GitActionTarget,
  GitCommitInput,
  GitCreatePullRequestInput,
  GitDraftInput,
  GitDraftResult,
} from '../../../shared/git-work-state';
import { resolveGitTarget } from '../../git-actions/action-target';
import { commitTarget, createPullRequestForTarget, pushTarget } from '../../git-actions/git-actions';
import { draftGitText } from '../../git-actions/draft-text';
import { announceTaskWrite } from '../helpers/task-write-announce';
import type { IpcContext } from '../ipc-context';

/** The tasks an action may have written: its own, or none for a Command Terminal. */
function writtenTaskIds(target: GitActionTarget): string[] {
  return target.kind === 'task' ? [target.taskId] : [];
}

export function registerGitActionHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.GIT_COMMIT, async (event, target: GitActionTarget, input: GitCommitInput, projectId?: string | null): Promise<GitActionResult> => {
    const resolved = resolveGitTarget(context, target, projectId);
    try {
      return await commitTarget(context, resolved, input);
    } finally {
      announceTaskWrite(context, event, resolved.projectId, { change: 'task-updated', ids: writtenTaskIds(target) });
    }
  });

  ipcMain.handle(IPC.GIT_PUSH, async (event, target: GitActionTarget, projectId?: string | null): Promise<GitActionResult> => {
    const resolved = resolveGitTarget(context, target, projectId);
    try {
      return await pushTarget(context, resolved);
    } finally {
      announceTaskWrite(context, event, resolved.projectId, { change: 'task-updated', ids: writtenTaskIds(target) });
    }
  });

  ipcMain.handle(IPC.GIT_CREATE_PULL_REQUEST, async (event, target: GitActionTarget, input: GitCreatePullRequestInput, projectId?: string | null): Promise<GitActionResult> => {
    const resolved = resolveGitTarget(context, target, projectId);
    try {
      return await createPullRequestForTarget(context, resolved, input);
    } finally {
      announceTaskWrite(context, event, resolved.projectId, { change: 'task-updated', ids: writtenTaskIds(target) });
    }
  });

  // A read: it runs an agent but writes no task row.
  ipcMain.handle(IPC.GIT_DRAFT_TEXT, async (_event, target: GitActionTarget, input: GitDraftInput, projectId?: string | null): Promise<GitDraftResult> => {
    return draftGitText(context, resolveGitTarget(context, target, projectId), input);
  });
}
