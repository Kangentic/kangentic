/**
 * The Review list's wording and order (src/renderer/lib/paused-for-memory.ts):
 * the agent that waited longest first, each with how long it waited, after
 * its project's name when the paused agents span projects.
 */
import { describe, it, expect } from 'vitest';
import { formatWaited, orderPausedAgents, pausedRowDetail } from '../../src/renderer/lib/paused-for-memory';
import type { HostMemoryAgentPausedEvent } from '../../src/shared/types';

const MINUTE_MS = 60_000;

function entry(taskId: string, waitedMs: number, projectName: string | null = 'kangentic'): HostMemoryAgentPausedEvent {
  return { pausedAt: '2026-10-21T12:00:00.000Z', taskId, projectId: 'proj-1', taskTitle: taskId, projectName, waitedMs };
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
