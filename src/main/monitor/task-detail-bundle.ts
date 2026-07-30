/**
 * The cross-project read behind a task detail hosted OUTSIDE its own board.
 *
 * The task-detail surface needs a handful of project-scoped values (the task
 * itself, the project's columns, its custom shortcuts, and four config values).
 * On the board those come from stores that hold the OPEN project. The Agent
 * Monitor hosts the same surface for a task in a project whose board is not
 * open, so it fetches them here instead.
 *
 * ONE channel rather than project-stamping five read channels, deliberately.
 * `.claude/rules/project-scoped-ipc.md` draws the line at mutations: those carry
 * an explicit interaction-time projectId because a misrouted WRITE corrupts the
 * wrong project, while a misrouted read shows stale data for a frame. Stamping
 * `task:list`, `swimlane:list`, `boardConfig:getShortcuts` and both config reads
 * would move five channels across that line to serve one caller. A single
 * purpose-built bundle keeps the rule's split intact and is one round trip
 * instead of five.
 *
 * Everything here reads an already-warm handle: `getProjectRepos` sits on the
 * never-evicting per-project DB cache, and both config managers already expose
 * `*ForPath` reads for exactly this "not the active project" case.
 */
import type { IpcContext } from '../ipc/ipc-context';
import type { TaskDetailBundle } from '../../shared/types';
import { getProjectRepos } from '../ipc/helpers/project-repos';

/**
 * Assemble everything a host needs to render the task detail for `taskId` in
 * `projectId`. Returns null when the project or task is gone (a race with a
 * delete), so the caller can close the window rather than render a husk.
 */
export function buildTaskDetailBundle(
  context: IpcContext,
  projectId: string,
  taskId: string,
): TaskDetailBundle | null {
  const project = context.projectRepo.getById(projectId);
  if (!project) return null;

  const repos = getProjectRepos(context, projectId);
  const task = repos.tasks.getById(taskId);
  if (!task) return null;

  // The effective config for THIS project (global config plus that project's
  // own overrides), not the open one.
  const effectiveConfig = context.configManager.getEffectiveConfig(project.path);
  // `defaultBaseBranch` is team-shared through kangentic.json, so it overlays the
  // effective config exactly the way the CONFIG_GET handler does it.
  const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranchForPath(project.path);

  return {
    task,
    projectId,
    projectName: project.name,
    projectPath: project.path,
    defaultAgent: project.default_agent ?? null,
    swimlanes: repos.swimlanes.list(),
    shortcuts: context.boardConfigManager.getShortcutsForPath(project.path),
    config: {
      labelColors: effectiveConfig.backlog?.labelColors ?? {},
      defaultBaseBranch: boardDefaultBranch || effectiveConfig.git.defaultBaseBranch,
      worktreesEnabled: effectiveConfig.git.worktreesEnabled,
      browserEnabled: effectiveConfig.browser?.enabled !== false,
    },
  };
}
