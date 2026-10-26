import type { HostMemoryAgentPausedEvent, Session } from '../../shared/types';
import { isLiveSessionStatus } from '../../shared/session-liveness';

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

/**
 * What became of a paused agent after its pause, keyed by task id: it came
 * back (seen running again), or it is gone (its task lost its last session
 * row: moved to To Do, or deleted). A task paused again drops its outcome.
 */
export type PausedAgentOutcome = 'came-back' | 'gone';

/**
 * Whether a paused agent is running now, by any route: its task has a live
 * session that started after the pause.
 *
 * The start time keeps the paused session itself out. The pause push and the
 * replica's update for the suspended session arrive separately, so the
 * replica can still list the paused session as running when the push lands.
 * A resume spawns a new session with a fresh `startedAt`, and main stamps
 * `pausedAt` on the same clock. Compared as ISO strings.
 */
export function isPausedAgentRunning(entry: HostMemoryAgentPausedEvent, sessions: readonly Session[]): boolean {
  return sessions.some((session) => session.taskId === entry.taskId
    && isLiveSessionStatus(session.status)
    && session.startedAt > entry.pausedAt);
}

/**
 * The outcomes one change to the session replica adds for the agents with
 * none yet. Running now is not enough on its own: an agent that came back and
 * was then stopped, or exited, must not count as paused again, so the store
 * keeps what this notes. Both outcomes are edges. A row that leaves the
 * replica marks its task gone only when the task has no row left, and a
 * replica that is still empty marks nothing. Returns `outcomes` itself when
 * nothing is new.
 */
export function notePausedOutcomes(
  entries: readonly HostMemoryAgentPausedEvent[],
  outcomes: Readonly<Record<string, PausedAgentOutcome>>,
  sessions: readonly Session[],
  previousSessions: readonly Session[],
): Readonly<Record<string, PausedAgentOutcome>> {
  const hasRow = (rows: readonly Session[], taskId: string): boolean => rows.some((session) => session.taskId === taskId);
  let noted: Record<string, PausedAgentOutcome> | null = null;
  for (const entry of entries) {
    if (outcomes[entry.taskId] !== undefined) continue;
    let outcome: PausedAgentOutcome;
    if (isPausedAgentRunning(entry, sessions)) outcome = 'came-back';
    else if (hasRow(previousSessions, entry.taskId) && !hasRow(sessions, entry.taskId)) outcome = 'gone';
    else continue;
    noted ??= { ...outcomes };
    noted[entry.taskId] = outcome;
  }
  return noted ?? outcomes;
}

/** How many of the paused agents are still paused: what the paused toast counts. */
export function countStillPaused(
  entries: readonly HostMemoryAgentPausedEvent[],
  sessions: readonly Session[],
  outcomes: Readonly<Record<string, PausedAgentOutcome>>,
): number {
  return entries.filter((entry) => outcomes[entry.taskId] === undefined && !isPausedAgentRunning(entry, sessions)).length;
}
