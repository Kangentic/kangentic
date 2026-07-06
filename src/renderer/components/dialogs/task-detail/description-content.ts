import type { Task } from '../../../../shared/types';

/**
 * Whether a task has anything worth showing in the description view / peek:
 * a description, at least one saved attachment, a non-zero priority, or a
 * label. Single source of truth shared by the affordance gate
 * (`canShowDescription` in TaskDetailWindow) and the render guard
 * (`descriptionBar` in TaskDetailBody), so the toggle and the strip can never
 * drift apart.
 */
export function taskHasDescriptionContent(task: Task, savedAttachmentCount: number): boolean {
  return !!(
    task.description
    || savedAttachmentCount > 0
    || (task.priority ?? 0) > 0
    || (task.labels ?? []).length > 0
  );
}
