import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { getProjectDb } from '../../db/database';
import type { IpcContext } from '../ipc-context';

export function getProjectRepos(context: IpcContext, projectId?: string | null): { tasks: TaskRepository; swimlanes: SwimlaneRepository; actions: ActionRepository; attachments: AttachmentRepository } {
  const resolvedProjectId = projectId ?? context.currentProjectId;
  if (!resolvedProjectId) throw new Error('No project is currently open');
  const db = getProjectDb(resolvedProjectId);
  return {
    tasks: new TaskRepository(db),
    swimlanes: new SwimlaneRepository(db),
    actions: new ActionRepository(db),
    attachments: new AttachmentRepository(db),
  };
}
