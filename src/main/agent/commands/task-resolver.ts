import type { TaskRepository } from '../../db/repositories/task-repository';
import type { Task } from '../../../shared/types';

/**
 * Resolve a task by either numeric display_id (with or without its `#`) or
 * UUID string. Tries display_id first if the input is a positive integer, then
 * falls back to UUID.
 */
export function resolveTask(taskRepository: TaskRepository, taskId: string): Task | undefined {
  const asNumber = Number(taskId.trim().replace(/^#/, ''));
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const byDisplayId = taskRepository.getByDisplayId(asNumber);
    if (byDisplayId) return byDisplayId;
  }
  return taskRepository.getById(taskId);
}
