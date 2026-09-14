import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { AutomationRepository } from '../../db/repositories/automation-repository';
import { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { getProjectDb } from '../../db/database';
import type { IpcContext } from '../ipc-context';

export function getProjectRepos(context: IpcContext, projectId?: string | null): {
  tasks: TaskRepository;
  swimlanes: SwimlaneRepository;
  automations: AutomationRepository;
  automationRuns: AutomationRunRepository;
  attachments: AttachmentRepository;
} {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  if (!resolvedProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(resolvedProjectId);
  return {
    tasks: new TaskRepository(db),
    swimlanes: new SwimlaneRepository(db),
    automations: new AutomationRepository(db),
    automationRuns: new AutomationRunRepository(db),
    attachments: new AttachmentRepository(db),
  };
}

/**
 * Resolve the (projectId, projectPath) pair a task-scoped handler should
 * operate on. Prefers the explicit `projectId` the renderer stamps at
 * interaction time, so a project switch between the user's action and the
 * handler running cannot reroute the mutation to the wrong project's DB; falls
 * back to the ambient current project for main-process internal callers that
 * omit it (engine, auto-move, MCP commands). The path is taken from the live
 * context when it matches the current project, else looked up from the project
 * repo. See .claude/rules/project-scoped-ipc.md.
 */
export function resolveProjectContext(
  context: IpcContext,
  projectId?: string | null,
): { projectId: string | null; projectPath: string | null } {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  if (!resolvedProjectId) return { projectId: null, projectPath: null };
  const resolvedProjectPath = resolvedProjectId === context.currentProjectId
    ? context.currentProjectPath
    : context.projectRepo.getById(resolvedProjectId)?.path ?? null;
  return { projectId: resolvedProjectId, projectPath: resolvedProjectPath };
}
