/**
 * `isLiftableIdlePause` (src/main/ipc/helpers/idle-pause-lift.ts): whether the
 * owner's own gesture may end a pause the idle timeout made. The cases here are
 * the workflow read and the record shape. The recovery hold and the task-move
 * wiring are pinned in session-leftover-reap-wiring.test.ts.
 *
 * The real chokepoint reporter runs; only its sink (`reportHandledError`) is
 * mocked, so a report that stopped happening fails the unreadable-workflow case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

const mockReportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mockReportHandledError,
}));

const mockWorkflowOfTask = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/workflows/workflow-home', () => ({
  workflowOfTask: mockWorkflowOfTask,
}));

import { isLiftableIdlePause, idlePauseLiftReporter } from '../../src/main/ipc/helpers/idle-pause-lift';

const PROJECT_ID = 'project-001';
const TASK = { id: 'task-idle-lift-001', title: 'Idle task' } as Task;
const IDLE_PAUSE = { status: 'suspended', suspended_by: 'auto', launch_failed_at: null } as const;

describe('isLiftableIdlePause', () => {
  beforeEach(() => {
    mockReportHandledError.mockReset();
    mockWorkflowOfTask.mockReset();
    idlePauseLiftReporter.reset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('is liftable when the task is in no workflow', () => {
    mockWorkflowOfTask.mockReturnValue(null);

    expect(isLiftableIdlePause(TASK, PROJECT_ID, IDLE_PAUSE)).toBe(true);
  });

  it('is liftable when the workflow is readable and not paused', () => {
    mockWorkflowOfTask.mockReturnValue({ id: 'workflow-1', state: 'running' });

    expect(isLiftableIdlePause(TASK, PROJECT_ID, IDLE_PAUSE)).toBe(true);
  });

  it('is held by a paused workflow', () => {
    mockWorkflowOfTask.mockReturnValue({ id: 'workflow-1', state: 'paused' });

    expect(isLiftableIdlePause(TASK, PROJECT_ID, IDLE_PAUSE)).toBe(false);
  });

  it('is held, and the failure reported once, when the workflow cannot be read', () => {
    mockWorkflowOfTask.mockImplementation(() => { throw new TypeError('workflow store unreadable'); });

    expect(isLiftableIdlePause(TASK, PROJECT_ID, IDLE_PAUSE)).toBe(false);
    // The same failure on the next ask is latched: one report per run, not one per move.
    expect(isLiftableIdlePause(TASK, PROJECT_ID, IDLE_PAUSE)).toBe(false);

    expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    const [reportedError, reportedTags] = mockReportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(reportedError.message).toBe('Handled idle_pause_lift failure: TypeError');
    expect(reportedTags).toMatchObject({ source: 'idle_pause_lift', error_name: 'TypeError' });
    // The error's own text never leaves.
    expect(JSON.stringify(mockReportHandledError.mock.calls[0])).not.toContain('workflow store unreadable');
  });

  it.each([
    ['the user\'s Pause', { ...IDLE_PAUSE, suspended_by: 'user' }],
    ['an earlier version\'s low-memory pause', { ...IDLE_PAUSE, suspended_by: 'low_memory' }],
    ['a system suspend', { ...IDLE_PAUSE, suspended_by: 'system' }],
    ['a running record', { ...IDLE_PAUSE, status: 'running' }],
    ['no record', null],
    ['an idle pause whose start never reached an agent', { ...IDLE_PAUSE, launch_failed_at: '2026-11-19T00:00:00.000Z' }],
  ])('is held for %s without reading the workflow', (_label, record) => {
    expect(isLiftableIdlePause(TASK, PROJECT_ID, record as never)).toBe(false);

    expect(mockWorkflowOfTask).not.toHaveBeenCalled();
    expect(mockReportHandledError).not.toHaveBeenCalled();
  });
});
