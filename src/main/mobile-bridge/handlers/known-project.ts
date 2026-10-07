import type { IpcContext } from '../../ipc/ipc-context';

/**
 * The project a phone's request names, or null when the desktop does not know
 * it. `read-board`, `read-diff`, `move-task`, `start-session` and
 * `pause-session` resolve the project they name here, before any repository
 * read.
 *
 * `resolveProjectContext` is not enough on its own for a phone: it returns any
 * non-empty id as given, and `getProjectDb` then creates and migrates a
 * database file named after it. A phone that still shows a project deleted on
 * the desktop recreated that project's empty database with one tap, and an id
 * carrying a path segment reached a file outside the projects directory.
 *
 * Never falls back to the desktop's current project: a phone always names the
 * project it means.
 */
export function resolveKnownProject(
  context: IpcContext,
  projectId: string,
): { projectId: string; projectPath: string } | null {
  if (!projectId) return null;
  const project = context.projectRepo.getById(projectId);
  return project ? { projectId: project.id, projectPath: project.path } : null;
}
