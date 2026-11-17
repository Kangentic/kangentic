import { DEFAULT_PRIORITY_CONFIG } from './types';

/** A project's priority scale, bottom entry (index 0) first. */
export type PriorityScale = ReadonlyArray<{ label: string; color: string }>;

/** A stored priority scale as every reader takes it: an absent or empty one reads as the seeded scale. */
export function priorityScaleFrom(priorities: PriorityScale | undefined): PriorityScale {
  return priorities && priorities.length > 0 ? priorities : DEFAULT_PRIORITY_CONFIG;
}

/**
 * The index of the level whose stored name matches `name`, ignoring case, or 0
 * (the bottom level) when there is no name or no level carries it. A board
 * import uses it to land a provider's "High" on the project's own "High" while a
 * project that renamed its levels imports at the bottom rather than at a guess.
 * `name` arrives over IPC, so anything but a string also imports at the bottom.
 *
 * Two names no stock scale carries still land: "Highest" on the top level and
 * "Lowest" on the lowest level above the bottom (Jira's defaults include both).
 * A level the scale names wins over either, and a one-level scale never yields
 * a level it lacks.
 */
export function priorityIndexForName(name: unknown, scale: ReadonlyArray<{ label: string }>): number {
  if (typeof name !== 'string') return 0;
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0 || scale.length === 0) return 0;
  const index = scale.findIndex((entry) => entry.label.trim().toLowerCase() === wanted);
  if (index !== -1) return index;
  if (wanted === 'highest') return scale.length - 1;
  if (wanted === 'lowest') return scale.length > 1 ? 1 : 0;
  return 0;
}
