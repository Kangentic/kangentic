/**
 * The Review list's wording and order (src/renderer/lib/paused-for-memory.ts):
 * the agent that waited longest first, each with how long it waited, after
 * its project's name when the paused agents span projects. And the one test
 * the toast and the rows share for an agent that is running again, and the
 * outcomes noted as the session replica changes (came back, or gone).
 */
import { describe, it, expect } from 'vitest';
import {
  countStillPaused,
  formatWaited,
  isPausedAgentRunning,
  notePausedOutcomes,
  orderPausedAgents,
  pausedRowDetail,
  type PausedAgentOutcome,
} from '../../src/renderer/lib/paused-for-memory';
import type { HostMemoryAgentPausedEvent, Session, SessionStatus } from '../../src/shared/types';

const MINUTE_MS = 60_000;
const PAUSED_AT = '2026-10-21T12:00:00.000Z';
const BEFORE_PAUSE = '2026-10-21T11:30:00.000Z';
const AFTER_PAUSE = '2026-10-21T12:05:00.000Z';

function entry(taskId: string, waitedMs: number, projectName: string | null = 'kangentic'): HostMemoryAgentPausedEvent {
  return { pausedAt: PAUSED_AT, taskId, projectId: 'proj-1', taskTitle: taskId, projectName, waitedMs };
}

function session(taskId: string, status: SessionStatus, startedAt: string): Session {
  return {
    id: `sess-${taskId}-${status}-${startedAt}`,
    taskId,
    projectId: 'proj-1',
    pid: 4242,
    status,
    shell: 'bash',
    cwd: '/mock/paused-for-memory',
    startedAt,
    exitCode: null,
    resuming: true,
    agentSessionId: null,
  };
}

describe('formatWaited', () => {
  it('reads minutes, hours and days, singular and plural', () => {
    expect(formatWaited(1 * MINUTE_MS)).toBe('waited 1 minute');
    expect(formatWaited(52 * MINUTE_MS)).toBe('waited 52 minutes');
    expect(formatWaited(60 * MINUTE_MS)).toBe('waited 1 hour');
    expect(formatWaited(3 * 60 * MINUTE_MS + 20 * MINUTE_MS)).toBe('waited 3 hours');
    expect(formatWaited(2 * 24 * 60 * MINUTE_MS)).toBe('waited 2 days');
  });

  it('never says 0 minutes', () => {
    expect(formatWaited(10_000)).toBe('waited 1 minute');
  });
});

describe('pausedRowDetail', () => {
  it('puts the project first when the list spans projects', () => {
    expect(pausedRowDetail(entry('a', 52 * MINUTE_MS), true)).toBe('kangentic, waited 52 minutes');
  });

  it('is the wait alone, capitalized, within one project', () => {
    expect(pausedRowDetail(entry('a', 52 * MINUTE_MS), false)).toBe('Waited 52 minutes');
  });

  it('falls back to the wait alone when the project name is unknown', () => {
    expect(pausedRowDetail(entry('a', 52 * MINUTE_MS, null), true)).toBe('Waited 52 minutes');
  });
});

describe('orderPausedAgents', () => {
  it('lists the longest wait first and leaves the input alone', () => {
    const input = [entry('short', 18 * MINUTE_MS), entry('longest', 180 * MINUTE_MS), entry('middle', 52 * MINUTE_MS)];
    expect(orderPausedAgents(input).map((row) => row.taskId)).toEqual(['longest', 'middle', 'short']);
    expect(input.map((row) => row.taskId)).toEqual(['short', 'longest', 'middle']);
  });
});

describe('isPausedAgentRunning', () => {
  it('is true for a live session of the task that started after the pause, running or queued', () => {
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-1', 'running', AFTER_PAUSE)])).toBe(true);
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-1', 'queued', AFTER_PAUSE)])).toBe(true);
  });

  it('is false for the paused session itself, still listed as running when the push lands', () => {
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-1', 'running', BEFORE_PAUSE)])).toBe(false);
  });

  it('is false for a session that is not live, however late it started', () => {
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-1', 'suspended', AFTER_PAUSE)])).toBe(false);
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-1', 'exited', AFTER_PAUSE)])).toBe(false);
  });

  it('is false for another task\'s session', () => {
    expect(isPausedAgentRunning(entry('task-1', MINUTE_MS), [session('task-2', 'running', AFTER_PAUSE)])).toBe(false);
  });
});

describe('countStillPaused', () => {
  it('counts the entries whose agent is not running again', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS), entry('task-3', MINUTE_MS)];
    const sessions = [
      session('task-1', 'running', AFTER_PAUSE),
      session('task-2', 'running', BEFORE_PAUSE),
      session('task-3', 'suspended', AFTER_PAUSE),
    ];
    expect(countStillPaused(entries, sessions, {})).toBe(2);
    expect(countStillPaused(entries, [], {})).toBe(3);
  });

  it('leaves out an entry with an outcome even when its agent is not running now', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS), entry('task-3', MINUTE_MS)];
    // An agent that came back and stopped, and one whose task lost its session row.
    const outcomes: Record<string, PausedAgentOutcome> = { 'task-1': 'came-back', 'task-2': 'gone' };
    const sessions = [session('task-1', 'suspended', AFTER_PAUSE)];

    expect(countStillPaused(entries, sessions, outcomes)).toBe(1);
    expect(countStillPaused(entries, [], outcomes)).toBe(1);
    expect(countStillPaused(entries.slice(0, 2), [], outcomes)).toBe(0);
  });
});

describe('notePausedOutcomes', () => {
  it('notes came-back for a live session started after the pause, and nothing for the paused session itself', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS)];
    // task-1 resumed after the pause; task-2 is the paused session, still listed as running.
    const sessions = [session('task-1', 'running', AFTER_PAUSE), session('task-2', 'running', BEFORE_PAUSE)];

    expect(notePausedOutcomes(entries, {}, sessions, sessions)).toEqual({ 'task-1': 'came-back' });
  });

  it('notes gone when the last session row of a task leaves the replica', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS)];
    const previousSessions = [session('task-1', 'suspended', BEFORE_PAUSE), session('task-2', 'suspended', BEFORE_PAUSE)];
    // task-1 moved to To Do or was deleted; task-2 keeps its row.
    const sessions = [session('task-2', 'suspended', BEFORE_PAUSE)];

    expect(notePausedOutcomes(entries, {}, sessions, previousSessions)).toEqual({ 'task-1': 'gone' });
  });

  it('does not note gone when a row is replaced by another row for the same task', () => {
    const entries = [entry('task-1', MINUTE_MS)];
    const previousSessions = [session('task-1', 'suspended', BEFORE_PAUSE)];
    // A restart's placeholder: suspended, so it is neither running again nor a departure.
    const sessions = [session('task-1', 'suspended', AFTER_PAUSE)];
    const outcomes = {};

    expect(notePausedOutcomes(entries, outcomes, sessions, previousSessions)).toBe(outcomes);
  });

  it('does not note gone when the previous replica had no row for the task either', () => {
    const entries = [entry('task-1', MINUTE_MS)];
    const outcomes = {};

    // A replica still loading: empty before and after, or loaded with other tasks' rows only.
    expect(notePausedOutcomes(entries, outcomes, [], [])).toBe(outcomes);
    expect(notePausedOutcomes(entries, outcomes, [session('task-2', 'running', AFTER_PAUSE)], [])).toBe(outcomes);
  });

  it('returns the same object when nothing is new', () => {
    const entries = [entry('task-1', MINUTE_MS)];
    const sessions = [session('task-1', 'suspended', BEFORE_PAUSE)];
    const outcomes: Record<string, PausedAgentOutcome> = {};

    expect(notePausedOutcomes(entries, outcomes, sessions, sessions)).toBe(outcomes);
    expect(notePausedOutcomes([], outcomes, sessions, sessions)).toBe(outcomes);
  });

  it('never overwrites an outcome already recorded', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS)];
    const outcomes: Record<string, PausedAgentOutcome> = { 'task-1': 'gone', 'task-2': 'came-back' };
    // task-1 is running again after being gone; task-2's last row leaves after it came back.
    const previousSessions = [session('task-2', 'suspended', AFTER_PAUSE)];
    const sessions = [session('task-1', 'running', AFTER_PAUSE)];

    const noted = notePausedOutcomes(entries, outcomes, sessions, previousSessions);

    expect(noted).toBe(outcomes);
    expect(noted).toEqual({ 'task-1': 'gone', 'task-2': 'came-back' });
  });

  it('adds to a copy and leaves the outcomes it was given untouched', () => {
    const entries = [entry('task-1', MINUTE_MS), entry('task-2', MINUTE_MS)];
    const outcomes: Record<string, PausedAgentOutcome> = { 'task-2': 'gone' };
    const sessions = [session('task-1', 'running', AFTER_PAUSE)];

    const noted = notePausedOutcomes(entries, outcomes, sessions, sessions);

    expect(noted).not.toBe(outcomes);
    expect(noted).toEqual({ 'task-1': 'came-back', 'task-2': 'gone' });
    expect(outcomes).toEqual({ 'task-2': 'gone' });
  });
});
