/**
 * The one way Kangentic itself puts an artifact on a task (#1056): a link an
 * agent published, or one found in its messages or its terminal. A person's
 * edit and an agent's MCP call write through `TaskRepository.update`'s
 * `artifactChanges` instead, and announce themselves the way any other task
 * edit does.
 *
 * Mirrors PR linking (`pr/pr-linking.ts`): resolve the task from a task id or
 * a live session, write, and tell the board on the quiet channel. Detection is
 * the app keeping a task's links current on its own, so it never raises "Task
 * updated by agent".
 */

import { IPC } from '../../shared/ipc-channels';
import type { Task, TaskArtifactInput, TaskArtifactSource } from '../../shared/types';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import type { IpcContext } from '../ipc/ipc-context';
import { sendToRenderer } from '../ipc/send-to-renderer';
import { reportUnrecognisedArtifactDomains } from './artifact-domain-report';

export interface LinkArtifactsOptions {
  /** The task, by id. */
  taskId?: string;
  /** Or the session that produced the links. A Command Terminal has no task, so its links go nowhere. */
  sessionId?: string;
  /** Defaults to the session's project, else the open one. */
  projectId?: string | null;
  artifacts: readonly TaskArtifactInput[];
  /** `agent` for an agent's own publish, `detected` for a link read out of text. */
  source: TaskArtifactSource;
}

/** Add `artifacts` to the task and tell the board. Returns the task when something was added or named, else null. */
export function linkArtifacts(context: IpcContext, options: LinkArtifactsOptions): Task | null {
  if (options.artifacts.length === 0) return null;

  const session = options.sessionId ? context.sessionManager.getSession(options.sessionId) : undefined;
  if (session?.transient) return null;

  const projectId = options.projectId
    ?? (options.sessionId ? context.sessionManager.getSessionProjectId(options.sessionId) : null)
    ?? context.currentProjectId;
  if (!projectId) return null;

  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, projectId);
  } catch {
    // The project's database closed (a project switch, shutdown).
    return null;
  }
  const { tasks } = repos;

  const taskId = options.taskId
    ?? (options.sessionId ? context.sessionManager.getSessionTaskId(options.sessionId) : undefined)
    ?? (options.sessionId ? tasks.getBySessionId(options.sessionId)?.id : undefined);
  if (!taskId) return null;

  const result = tasks.applyArtifactChanges(taskId, { add: [...options.artifacts], source: options.source });
  if (!result?.changed) return null;

  reportUnrecognisedArtifactDomains(result.added.map((artifact) => artifact.url), options.source);
  announceArtifactsChanged(context, projectId, taskId);
  return tasks.getById(taskId) ?? null;
}

/**
 * Tell the board a task's artifacts changed, without a toast. The renderer
 * reloads its tasks on this channel exactly as it does for a PR link the app
 * resolved on its own; the monitor and a paired phone hear the board event.
 */
export function announceArtifactsChanged(context: IpcContext, projectId: string, taskId: string): void {
  sendToRenderer(context.mainWindow, IPC.TASK_PR_LINK_CHANGED, projectId);
  context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [taskId] });
}
