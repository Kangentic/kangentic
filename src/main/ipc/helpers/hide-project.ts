import { gitFetchScheduler } from '../../git/git-fetch-scheduler';
import { prRefreshScheduler } from '../../pr/pr-refresh-scheduler';
import { retrievalService } from '../../retrieval/retrieval-service';
import { endWorkflowAgentsOfProject } from '../../workflows/workflow-agent';
import { pauseWorkflowsOfProject } from '../../workflows/workflow-hidden-project';
import { forgetCommandTerminalRestore } from '../handlers/command-terminal-restore';
import { pauseTaskSession } from '../handlers/session-pause';
import type { IpcContext } from '../ipc-context';
import type { Project } from '../../../shared/types';
import { clearConversationExpired } from './pending-conversation-expired';
import { closeProjectTaskWindows } from './task-windows';

/**
 * What removing an SSH host does to the running app for each of its projects (#913), in two steps either side of
 * the host being marked removed. Unlike `cleanupProject`, nothing here deletes: the project comes back when the
 * same address is added again.
 */

/**
 * Stop everything of a project while it is still visible. Its workflows pause first, so their Pause reaches every
 * member, on this board and on others. Every task is then asked, not only those with a running session: a queued
 * session would start after the host is gone, and a start still in flight holds its task's lock, so asking waits
 * for it and stops what it started.
 *
 * Recorded as the system's, which is not a held pause: the recovery that starts a task after a restart starts it
 * when the address is added again. A workflow's members stay paused until its Resume.
 */
export async function suspendProjectForHiding(context: IpcContext, project: Project, listTaskIds: () => Array<{ id: string }>): Promise<void> {
  await pauseWorkflowsOfProject(context, project.id);
  const sessions = context.sessionManager.listSessions().filter((session) => session.projectId === project.id);
  const taskIds = new Set(listTaskIds().map((task) => task.id));
  for (const session of sessions) if (!session.transient) taskIds.add(session.taskId);
  await Promise.all([...taskIds].map((taskId) => pauseTaskSession(context, taskId, { projectId: project.id, suspendedBy: 'system' }).catch((error: unknown) => {
    console.warn(`[remote] could not suspend task ${taskId.slice(0, 8)} of ${project.name}:`, error);
  })));
  // A Command Terminal and a workflow's own agent run in the project's folder on the host. Ending the terminal
  // tells the window and keeps it in Earlier conversations. It leaves a workflow's agent to the line after.
  for (const session of sessions) if (session.transient) context.sessionManager.endCommandTerminal(session.id);
  await endWorkflowAgentsOfProject(context, project.id);
}

/**
 * Take a project that is now hidden out of the running app: what would otherwise go on working for a project
 * nobody can see, and the current project if it was this one. Runs after the host is marked removed, because
 * clearing the current project earlier would fail every ambient read while the board is still on screen. The
 * schedulers each do nothing unless this project owns them.
 */
export function takeHiddenProjectOutOfApp(context: IpcContext, project: Project): void {
  prRefreshScheduler.stop(project.id);
  gitFetchScheduler.stop(project.id);
  retrievalService.stop(project.id);
  // Its toasts would name tasks of a board that cannot be opened.
  clearConversationExpired(project.id);
  closeProjectTaskWindows(project.id);
  if (context.currentProjectId === project.id) {
    context.boardConfigManager.detach();
    context.currentProjectId = null;
    context.currentProjectPath = null;
    retrievalService.reconcileEmbedWorker(context);
  }
  // It is activated again when it is shown.
  context.recoveredProjects.delete(project.id);
  context.snapshottedProjects.delete(project.id);
  forgetCommandTerminalRestore(context, project.id);
}
