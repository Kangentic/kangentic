/**
 * What the leftover-process toast and list say (src/renderer/lib/leftover-processes.ts),
 * pinned to the approved design: the toast gives counts and stays only while
 * something is still running or could not be stopped; the list names each
 * process and why it kept running.
 */

import { describe, it, expect } from 'vitest';
import {
  describeLeftoverReport,
  groupByTask,
  reportTitleOf,
  rowDetailOf,
  rowStateOf,
  sectionsOf,
  splitProcessLabel,
} from '../../src/renderer/lib/leftover-processes';
import type { LeftoverProcess, LeftoverProcessReport } from '../../src/shared/types';

let nextId = 0;

function process(overrides: Partial<LeftoverProcess> = {}): LeftoverProcess {
  nextId += 1;
  return {
    id: `process-${nextId}`,
    taskId: 'task-a',
    taskTitle: 'Fix login',
    pid: 40000 + nextId,
    label: 'node (vite)',
    outcome: 'stopped',
    reason: null,
    place: 'worktree',
    ...overrides,
  };
}

function report(processes: LeftoverProcess[], stoppingEnabled = true): LeftoverProcessReport {
  return { id: 'report-1', stoppingEnabled, processes };
}

describe('describeLeftoverReport', () => {
  it('A: all stopped, closes on its own', () => {
    expect(describeLeftoverReport(report([process(), process({ label: 'python3 (http.server)' })]))).toEqual({
      message: 'Stopped 2 leftover processes from "Fix login".', variant: 'info', sticky: false,
    });
  });

  it('B: some still running, stays', () => {
    expect(describeLeftoverReport(report([
      process(),
      process({ outcome: 'kept', reason: 'window', label: 'chrome' }),
      process({ outcome: 'kept', reason: 'multiplexer', label: 'tmux' }),
    ]))).toEqual({ message: 'Stopped 1 leftover process from "Fix login". 2 still running.', variant: 'info', sticky: true });
  });

  it('C: one could not be stopped, a warning that stays', () => {
    expect(describeLeftoverReport(report([process({ outcome: 'failed' })]))).toEqual({
      message: 'Couldn\'t stop 1 process from "Fix login".', variant: 'warning', sticky: true,
    });
    expect(describeLeftoverReport(report([process(), process({ outcome: 'failed' })]))?.message)
      .toBe('Stopped 1 leftover process from "Fix login". Couldn\'t stop 1.');
  });

  it('D: several tasks, one toast', () => {
    expect(describeLeftoverReport(report([
      process(),
      process({ taskId: 'task-b', taskTitle: 'Update deps' }),
      process({ taskId: 'task-c', taskTitle: 'Add search' }),
      process({ taskId: 'task-c', taskTitle: 'Add search', outcome: 'kept', reason: 'window', label: 'Code' }),
    ]))).toEqual({ message: 'Stopped 3 leftover processes from 3 tasks. 1 still running.', variant: 'info', sticky: true });
  });

  it('E: stopping turned off, closes on its own', () => {
    expect(describeLeftoverReport(report([
      process({ outcome: 'kept' }),
      process({ outcome: 'kept' }),
      process({ outcome: 'kept', reason: 'window' }),
    ], false))).toEqual({ message: '"Fix login" left 3 processes running.', variant: 'info', sticky: false });
  });

  it('a task that left only a window says so, and stays', () => {
    expect(describeLeftoverReport(report([process({ outcome: 'kept', reason: 'window' })]))).toEqual({
      message: '"Fix login" left 1 process running.', variant: 'info', sticky: true,
    });
  });

  it('nothing left running: no toast', () => {
    expect(describeLeftoverReport(report([]))).toBeNull();
  });
});

describe('the list', () => {
  it('splits a label so the script can be muted', () => {
    expect(splitProcessLabel('node (vite)')).toEqual({ program: 'node', script: 'vite' });
    expect(splitProcessLabel('python3 (http.server)')).toEqual({ program: 'python3', script: 'http.server' });
    expect(splitProcessLabel('Google Chrome')).toEqual({ program: 'Google Chrome', script: null });
  });

  it('puts what is still running first and keeps a row in the section it opened in', () => {
    const stopped = process();
    const window = process({ outcome: 'kept', reason: 'window' });
    const failed = process({ outcome: 'failed' });
    expect(sectionsOf(report([stopped, window, failed]))).toEqual({ stillRunning: [window, failed], stopped: [stopped] });
  });

  it('reads each row state from the report, then from the user\'s Stop', () => {
    expect(rowStateOf(process(), undefined)).toBe('stopped');
    expect(rowStateOf(process({ outcome: 'failed' }), undefined)).toBe('failed');
    expect(rowStateOf(process({ outcome: 'kept' }), undefined)).toBe('running');
    expect(rowStateOf(process({ outcome: 'kept' }), 'stopping')).toBe('stopping');
    expect(rowStateOf(process({ outcome: 'kept' }), 'ended')).toBe('ended');
  });

  it('says why each process kept running, or where it ran', () => {
    expect(rowDetailOf(process({ outcome: 'kept', reason: 'window' }), 'running').text).toBe('Has an open window.');
    expect(rowDetailOf(process({ outcome: 'kept', reason: 'multiplexer' }), 'running').text).toBe('A tmux server. Stopping it ends all your tmux sessions.');
    expect(rowDetailOf(process({ outcome: 'kept', reason: 'shared' }), 'running').text).toBe('Also runs work you started. Stopping it stops that too.');
    expect(rowDetailOf(process(), 'stopped').text).toBe('Ran in the worktree.');
    expect(rowDetailOf(process({ place: 'project' }), 'stopped').text).toBe('Ran in the project folder.');
    expect(rowDetailOf(process({ outcome: 'kept' }), 'running').text).toBe('Runs in the worktree.');
    expect(rowDetailOf(process({ outcome: 'kept', reason: 'window' }), 'stopped').text).toBe('Has an open window.');
    expect(rowDetailOf(process({ outcome: 'kept' }), 'ended').text).toBe('No longer running.');
    expect(rowDetailOf(process({ outcome: 'failed' }), 'failed')).toEqual({ text: 'Couldn\'t stop it. Try again, or close it yourself.', failure: true });
  });

  it('groups rows by task for a report that spans several', () => {
    const first = process();
    const second = process({ taskId: 'task-b', taskTitle: 'Update deps' });
    const third = process();
    expect(groupByTask([first, second, third]).map((group) => [group.taskTitle, group.processes.length])).toEqual([['Fix login', 2], ['Update deps', 1]]);
  });

  it('titles the list by its task, or by how many tasks', () => {
    expect(reportTitleOf(report([process()]))).toBe('Processes from "Fix login"');
    expect(reportTitleOf(report([process(), process({ taskId: 'task-b' })]))).toBe('Processes from 2 tasks');
  });
});
