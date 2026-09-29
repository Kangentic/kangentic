/**
 * Which colour modes THIS index can actually express.
 *
 * The surface's standing rule: a control that can only ever do nothing is not
 * rendered. It already prunes dead facet rows and duplicate Detail chips; colour
 * modes fall to it for two different reasons.
 *
 * A METRIC mode dies when nothing records the metric. Cost and duration are
 * captured per session, so a conversation indexed before that was true carries
 * neither, and an index made entirely of those would offer a mode that paints
 * every node the same.
 *
 * A CATEGORY mode dies more subtly: it can have every value present and still
 * say nothing, because colour reads as a PATTERN and a pattern needs a visible
 * minority. Measured on the real 648-conversation corpus the status split is
 * 642 done and 6 active - both values present, and a map that is
 * uniformly green with six amber specks in it. Six of 648 is not something the
 * eye finds; it is something the outcome FILTER finds, in one click, which is
 * why that row stays while this mode goes.
 */

import type { MemoryGraphNode } from '../../../shared/types';
import type { MemoryGraphColorMode } from './MemoryGraphCanvas';

/**
 * Share of conversations the second-most-common outcome must hold.
 *
 * Below this, colour cannot carry the distinction: at 5% of a 648-conversation
 * index that is 32 nodes, which reads as a sprinkle across the map, where the
 * measured 6 reads as nothing at all. The number is a legibility floor rather
 * than a statistical one - it is asking whether a reader would SEE a second
 * colour, not whether the difference is real.
 */
export const MIN_MINORITY_OUTCOME_SHARE = 0.05;

/**
 * Modes always worth offering: every conversation has a region and a last
 * activity, so neither can be empty on an index that has a map at all.
 */
const ALWAYS_AVAILABLE: ReadonlyArray<MemoryGraphColorMode> = ['cluster', 'recency'];

export function availableColorModes(
  nodes: ReadonlyArray<MemoryGraphNode>,
): MemoryGraphColorMode[] {
  const available: MemoryGraphColorMode[] = [...ALWAYS_AVAILABLE];

  if (nodes.length > 0) {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.outcome === null) continue;
      counts.set(node.outcome, (counts.get(node.outcome) ?? 0) + 1);
    }
    const ranked = [...counts.values()].sort((first, second) => second - first);
    const minority = ranked[1] ?? 0;
    if (minority / nodes.length >= MIN_MINORITY_OUTCOME_SHARE) available.push('outcome');
  }

  // Length is derived from the chunks themselves, so it exists wherever the map
  // does - it needs no availability check, only a place in the order.
  available.push('size');
  if (nodes.some((node) => node.durationMs !== null)) available.push('duration');
  if (nodes.some((node) => node.costUsd !== null)) available.push('cost');

  return available;
}
