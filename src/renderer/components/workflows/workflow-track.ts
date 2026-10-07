import type { WorkflowBoardEnds, WorkflowRouteStep, WorkflowTaskPlace } from '../../../shared/types';

/**
 * One stop of a task's journey: To Do, a column on its route, or Done. A stop
 * the task has left is `done`, the one it is at `current`, one still to come
 * `ahead`.
 */
export interface TrackStop {
  swimlaneId: string;
  name: string;
  color: string | null;
  icon: string | null;
  /** The board's To Do or Done column, the journey's two ends; null for a route column. */
  end: 'todo' | 'done' | null;
  state: 'done' | 'current' | 'ahead';
}

/**
 * The stops a card's track draws, in board order (sign-off R2 and T2,
 * 2026-10-07): To Do, each column on the route (skipped ones are not drawn),
 * Done. A task's track keeps one length its whole life; only where it is moves
 * along it. A board with no To Do or no Done column draws that end not at all.
 */
export function trackStops(
  steps: readonly WorkflowRouteStep[],
  ends: WorkflowBoardEnds | null,
  place: WorkflowTaskPlace,
): TrackStop[] {
  const stops: TrackStop[] = [];
  if (ends?.todo) {
    stops.push({ ...ends.todo, end: 'todo', state: place === 'planned' || place === 'todo' ? 'current' : 'done' });
  }
  for (const step of steps) {
    if (step.state === 'skipped') continue;
    stops.push({ swimlaneId: step.swimlaneId, name: step.name, color: step.color, icon: step.icon, end: null, state: step.state });
  }
  if (ends?.done) stops.push({ ...ends.done, end: 'done', state: place === 'done' ? 'current' : 'ahead' });
  return stops;
}
