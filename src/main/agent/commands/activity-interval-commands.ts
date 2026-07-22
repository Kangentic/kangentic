import { TaskRepository } from '../../db/repositories/task-repository';
import { ActivityIntervalStore, type SessionActivityInterval } from '../../activity-engine/activity-interval-store';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

/** A still-open interval, with its elapsed time computed at read time (the
 *  row itself carries no live clock - `durationMs`/`endedMs` stay null until
 *  the recorder closes it). */
interface OpenIntervalSummary {
  sessionId: string;
  disposition: SessionActivityInterval['disposition'];
  state: SessionActivityInterval['state'];
  startedMs: number;
  startedAt: string;
  liveElapsedMs: number;
}

/**
 * Read-only MCP surface over `session_activity_intervals` (see
 * activity-interval-store.ts / activity-interval-recorder.ts). Accepts
 * either `sessionId` (one session) or `taskId` (every session the task has
 * ever accumulated - a resume creates a new session row, so a task's full
 * wait history can span several). Returns the raw rows plus a totals rollup
 * so a caller doesn't have to sum `durationMs` by `disposition` itself, and
 * separately reports any still-OPEN interval's live elapsed time (a row with
 * `durationMs: null` is mid-span - its wait time is not yet a durable total).
 */
export const handleGetActivityIntervals: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const database = context.getProjectDb();
  const sessionId = params.sessionId as string | undefined;
  const taskId = params.taskId as string | undefined;

  if (!sessionId && !taskId) {
    return { success: false, error: 'Provide either taskId or sessionId' };
  }

  const store = new ActivityIntervalStore(database);
  let intervals: SessionActivityInterval[];
  let resolvedTaskId: string | null = null;

  if (sessionId) {
    intervals = store.getForSession(sessionId);
  } else {
    const taskRepository = new TaskRepository(database);
    const task = resolveTask(taskRepository, taskId as string);
    if (!task) return { success: false, error: `Task "${taskId}" not found` };
    resolvedTaskId = task.id;
    intervals = store.getForTask(task.id);
  }

  const now = Date.now();
  const totals = { activeMs: 0, idleMs: 0 };
  const openIntervals: OpenIntervalSummary[] = [];
  for (const interval of intervals) {
    if (interval.durationMs !== null) {
      totals[interval.disposition === 'active' ? 'activeMs' : 'idleMs'] += interval.durationMs;
    } else {
      openIntervals.push({
        sessionId: interval.sessionId,
        disposition: interval.disposition,
        state: interval.state,
        startedMs: interval.startedMs,
        startedAt: interval.startedAt,
        liveElapsedMs: now - interval.startedMs,
      });
    }
  }

  const scopeLabel = resolvedTaskId ? `task ${resolvedTaskId}` : `session ${sessionId}`;
  return {
    success: true,
    message: `${intervals.length} interval(s) for ${scopeLabel} (${totals.activeMs}ms active, ${totals.idleMs}ms idle, ${openIntervals.length} open)`,
    data: { intervals, totals, openIntervals },
  };
};
