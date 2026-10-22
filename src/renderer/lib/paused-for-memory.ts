import type { HostMemoryAgentPausedEvent } from '../../shared/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "waited 52 minutes", "waited 3 hours": how long an agent had waited on the user when it was paused. */
export function formatWaited(waitedMs: number): string {
  const [amount, unit] = waitedMs >= DAY_MS
    ? [Math.floor(waitedMs / DAY_MS), 'day']
    : waitedMs >= HOUR_MS
      ? [Math.floor(waitedMs / HOUR_MS), 'hour']
      : [Math.max(1, Math.floor(waitedMs / MINUTE_MS)), 'minute'];
  return `waited ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/** A row's second line: the wait, after the project name when the list spans projects. */
export function pausedRowDetail(entry: HostMemoryAgentPausedEvent, showProject: boolean): string {
  const waited = formatWaited(entry.waitedMs);
  if (showProject && entry.projectName) return `${entry.projectName}, ${waited}`;
  return `${waited.charAt(0).toUpperCase()}${waited.slice(1)}`;
}

/** The Review list's rows, the longest wait first. */
export function orderPausedAgents(entries: readonly HostMemoryAgentPausedEvent[]): HostMemoryAgentPausedEvent[] {
  return [...entries].sort((first, second) => second.waitedMs - first.waitedMs);
}
