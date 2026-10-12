import type { NodeChange } from '@xyflow/react';
import type { AppConfig, WorkflowViewTask } from '../../../shared/types';

/**
 * How tall each card on the Workflows canvas is, for the layout.
 *
 * A canvas card is as tall as its content, as a board card is (the user's call,
 * 2026-10-07: one fixed height per density left a planned card, which has only
 * a title and a description, half empty). React Flow measures every card, and
 * the layout stacks each column from those heights, so a card that grows (its
 * task starts and gains the agent's message and context bar, a PR links,
 * labels land) re-spaces its column instead of running into the card below.
 *
 * Until React Flow has measured a card the layout uses an estimate for its
 * state. Nobody sees it: React Flow does not draw a node it has not measured,
 * and the measurement lays the column out again before the first frame that
 * shows the card.
 */

const ESTIMATED_CARD_HEIGHT: Record<AppConfig['cardDensity'], number> = {
  compact: 88,
  default: 150,
  comfortable: 168,
};
/** The strip over the Done column's compact card. */
const ESTIMATED_DONE_CARD_HEIGHT = 100;

/** A card's height before React Flow has measured it. */
export function estimatedCardHeight(task: Pick<WorkflowViewTask, 'place'>, density: AppConfig['cardDensity']): number {
  return task.place === 'done' ? ESTIMATED_DONE_CARD_HEIGHT : ESTIMATED_CARD_HEIGHT[density];
}

export const NO_MEASURED_HEIGHTS: ReadonlyMap<string, number> = new Map();

/**
 * The measured heights after a batch of React Flow node changes. Returns the
 * same map unless a card's whole-pixel height changed, so the layout never runs
 * again for a drag (position changes) or a sub-pixel measurement.
 */
export function withMeasuredHeights(
  current: ReadonlyMap<string, number>,
  changes: readonly NodeChange[],
): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null;
  for (const change of changes) {
    if (change.type !== 'dimensions' || !change.dimensions) continue;
    const height = Math.round(change.dimensions.height);
    if (height <= 0 || (next ?? current).get(change.id) === height) continue;
    next ??= new Map(current);
    next.set(change.id, height);
  }
  return next ?? current;
}
