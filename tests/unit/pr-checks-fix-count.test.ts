import { describe, it, expect } from 'vitest';
import { taskHasCheckablePr, prFixCount } from '../../src/renderer/hooks/usePrChecks';
import type { PRChecks, Task } from '../../src/shared/types';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    pr_number: 12,
    pr_url: 'https://github.com/o/r/pull/12',
    pr_state: 'open',
    pr_merge_readiness: null,
    ...overrides,
  } as Task;
}

function makeChecks(statuses: string[]): PRChecks {
  return {
    checksPageUrl: 'https://github.com/o/r/pull/12/checks',
    checks: statuses.map((status, index) => ({
      id: String(index),
      name: `check ${index}`,
      group: null,
      url: null,
      status,
      hasLog: false,
    })),
  } as unknown as PRChecks;
}

describe('taskHasCheckablePr', () => {
  it('is true for an open or draft PR with a url and a number', () => {
    expect(taskHasCheckablePr(makeTask({ pr_state: 'open' }))).toBe(true);
    expect(taskHasCheckablePr(makeTask({ pr_state: 'draft' }))).toBe(true);
  });

  it('is false for a merged, closed or unstated PR', () => {
    expect(taskHasCheckablePr(makeTask({ pr_state: 'merged' }))).toBe(false);
    expect(taskHasCheckablePr(makeTask({ pr_state: 'closed' }))).toBe(false);
    expect(taskHasCheckablePr(makeTask({ pr_state: null }))).toBe(false);
  });

  it('is false with no url, no number, or no task', () => {
    expect(taskHasCheckablePr(makeTask({ pr_url: null }))).toBe(false);
    expect(taskHasCheckablePr(makeTask({ pr_number: null }))).toBe(false);
    expect(taskHasCheckablePr(null)).toBe(false);
    expect(taskHasCheckablePr(undefined)).toBe(false);
  });
});

describe('prFixCount', () => {
  it('counts each failed check and ignores passed, pending and skipped', () => {
    const checks = makeChecks(['failed', 'failed', 'passed', 'pending', 'skipped']);
    expect(prFixCount(makeTask({}), checks)).toBe(2);
  });

  it('adds one for a conflict', () => {
    const task = makeTask({ pr_merge_readiness: 'conflicting' });
    expect(prFixCount(task, makeChecks(['failed', 'passed']))).toBe(2);
    expect(prFixCount(task, null)).toBe(1);
  });

  it('is 0 when nothing is failed or in conflict', () => {
    expect(prFixCount(makeTask({ pr_merge_readiness: 'running' }), makeChecks(['passed', 'pending', 'skipped']))).toBe(0);
    expect(prFixCount(makeTask({}), null)).toBe(0);
  });

  it('is 0 for a merged PR whose readiness is a stale conflicting, even with failed checks', () => {
    const merged = makeTask({ pr_state: 'merged', pr_merge_readiness: 'conflicting' });
    expect(prFixCount(merged, makeChecks(['failed']))).toBe(0);
    expect(prFixCount(merged, null)).toBe(0);
  });
});
