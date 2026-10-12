import type { Task } from '../../../shared/types';

/**
 * Removes a deleted task's links in its workflow's home database, where a
 * workflow keeps its links. Set once by the workflow engine at startup
 * (`registerWorkflowEngine`), so `TaskRepository.delete` (every delete's one
 * path) reaches another project's database without opening it itself.
 *
 * A module of its own, holding only the callback, so a test that mocks the
 * task repository whole does not also have to mock this.
 */
let homeLinkRemover: ((task: Task) => void) | null = null;

export function setHomeLinkRemover(remover: ((task: Task) => void) | null): void {
  homeLinkRemover = remover;
}

/** Remove a deleted workflow task's links in its home database. A no-op before the engine registers. */
export function removeLinksInWorkflowHome(task: Task): void {
  homeLinkRemover?.(task);
}
