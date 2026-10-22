/**
 * What the leftover-process toast and list say (src/renderer/lib/leftover-processes.ts),
 * pinned to the approved design: the toast gives counts and stays only while
 * something is still running or could not be stopped, leads with that, and
 * shows how long ago it came; the list names each process and why it kept
 * running, under how long ago the report came.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { __setLocaleForTests } from '../../src/renderer/lib/datetime';
import {
  LEFTOVER_RECHECK_FAST_MS,
  LEFTOVER_RECHECK_SLOW_MS,
  describeLeftoverReport,
  groupByTask,
  recheckDelayMs,
  reportAgeOf,
  reportHasSettled,
  reportTitleOf,
  rowDetailOf,
  rowStateOf,
  rowsToRecheck,
  sectionsOf,
  splitProcessLabel,
} from '../../src/renderer/lib/leftover-processes';
import type { LeftoverProcess, LeftoverProcessReport } from '../../src/shared/types';

let nextId = 0;

function leftoverProcess(overrides: Partial<LeftoverProcess> = {}): LeftoverProcess {
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

const REPORTED_AT = '2026-10-06T19:59:13.000Z';

function report(processes: LeftoverProcess[], stoppingEnabled = true): LeftoverProcessReport {
  return { id: 'report-1', stoppingEnabled, processes, reportedAt: REPORTED_AT };
}

describe('describeLeftoverReport', () => {
  it('A: all stopped, closes on its own, with no age', () => {
    expect(describeLeftoverReport(report([leftoverProcess(), leftoverProcess({ label: 'python3 (http.server)' })]))).toEqual({
      title: 'Leftover processes stopped',
      message: 'Stopped 2 leftover processes from "Fix login".',
      variant: 'info',
      sticky: false,
    });
  });

  it('B: some still running, stays, and leads with what is still running; what stopped is in the list', () => {
    expect(describeLeftoverReport(report([
      leftoverProcess(),
      leftoverProcess({ outcome: 'kept', reason: 'window', label: 'chrome' }),
      leftoverProcess({ outcome: 'kept', reason: 'multiplexer', label: 'tmux' }),
    ]))).toEqual({
      title: 'Processes still running',
      message: '2 processes from "Fix login" are still running.',
      variant: 'info',
      sticky: true,
      since: REPORTED_AT,
    });
  });

  it('C: one could not be stopped, a warning that stays, with anything still running after it', () => {
    expect(describeLeftoverReport(report([leftoverProcess({ outcome: 'failed' })]))).toEqual({
      title: 'Couldn\'t stop processes',
      message: 'Couldn\'t stop 1 process from "Fix login".',
      variant: 'warning',
      sticky: true,
      since: REPORTED_AT,
    });
    expect(describeLeftoverReport(report([leftoverProcess(), leftoverProcess({ outcome: 'failed' })]))?.message)
      .toBe('Couldn\'t stop 1 process from "Fix login".');
    expect(describeLeftoverReport(report([
      leftoverProcess({ outcome: 'failed' }),
      leftoverProcess({ outcome: 'kept', reason: 'shared', label: 'adb' }),
    ]))?.message).toBe('Couldn\'t stop 1 process from "Fix login", and 1 more is still running.');
    expect(describeLeftoverReport(report([
      leftoverProcess({ outcome: 'failed' }),
      leftoverProcess({ outcome: 'failed' }),
      leftoverProcess({ outcome: 'kept' }),
      leftoverProcess({ outcome: 'kept' }),
    ]))?.message).toBe('Couldn\'t stop 2 processes from "Fix login", and 2 more are still running.');
  });

  it('D: several tasks, one toast', () => {
    expect(describeLeftoverReport(report([
      leftoverProcess(),
      leftoverProcess({ taskId: 'task-b', taskTitle: 'Update deps' }),
      leftoverProcess({ taskId: 'task-c', taskTitle: 'Add search' }),
      leftoverProcess({ taskId: 'task-c', taskTitle: 'Add search', outcome: 'kept', reason: 'window', label: 'Code' }),
    ]))).toEqual({
      title: 'Processes still running',
      message: '1 process from 3 tasks is still running.',
      variant: 'info',
      sticky: true,
      since: REPORTED_AT,
    });
  });

  it('E: stopping turned off, closes on its own', () => {
    expect(describeLeftoverReport(report([
      leftoverProcess({ outcome: 'kept' }),
      leftoverProcess({ outcome: 'kept' }),
      leftoverProcess({ outcome: 'kept', reason: 'window' }),
    ], false))).toEqual({
      title: 'Leftover processes',
      message: '"Fix login" left 3 processes running.',
      variant: 'info',
      sticky: false,
    });
  });

  it('a task that left only a window says so, and stays', () => {
    expect(describeLeftoverReport(report([leftoverProcess({ outcome: 'kept', reason: 'window' })]))).toEqual({
      title: 'Processes still running',
      message: '1 process from "Fix login" is still running.',
      variant: 'info',
      sticky: true,
      since: REPORTED_AT,
    });
  });

  it('nothing left running: no toast', () => {
    expect(describeLeftoverReport(report([]))).toBeNull();
  });
});

describe('reportAgeOf', () => {
  const reportedMs = Date.parse(REPORTED_AT);
  // The age is the user's locale's wording; pin one so every machine reads the same.
  beforeAll(() => __setLocaleForTests('en-US'));
  afterAll(() => __setLocaleForTests(undefined));

  it('says how long ago the report came, in whole units rounded down, and "just now" under a minute', () => {
    expect(reportAgeOf(report([]), reportedMs + 12_000)).toBe('just now');
    expect(reportAgeOf(report([]), reportedMs + 60_000)).toBe('1 minute ago');
    // The incident: the toast was still up 37 minutes later.
    expect(reportAgeOf(report([]), reportedMs + 37 * 60_000 + 50_000)).toBe('37 minutes ago');
    expect(reportAgeOf(report([]), reportedMs + 2 * 60 * 60_000 + 59 * 60_000)).toBe('2 hours ago');
  });

  it('is empty for a report with no readable time', () => {
    expect(reportAgeOf({ ...report([]), reportedAt: 'not a time' }, reportedMs)).toBe('');
  });
});

describe('the list', () => {
  it('splits a label so the script can be muted', () => {
    expect(splitProcessLabel('node (vite)')).toEqual({ program: 'node', script: 'vite' });
    expect(splitProcessLabel('python3 (http.server)')).toEqual({ program: 'python3', script: 'http.server' });
    expect(splitProcessLabel('Google Chrome')).toEqual({ program: 'Google Chrome', script: null });
  });

  it('puts what is still running first and keeps a row in the section it opened in', () => {
    const stopped = leftoverProcess();
    const windowRow = leftoverProcess({ outcome: 'kept', reason: 'window' });
    const failed = leftoverProcess({ outcome: 'failed' });
    expect(sectionsOf(report([stopped, windowRow, failed]))).toEqual({ stillRunning: [windowRow, failed], stopped: [stopped] });
  });

  it('reads each row state from the report, then from the user\'s Stop', () => {
    expect(rowStateOf(leftoverProcess(), undefined)).toBe('stopped');
    expect(rowStateOf(leftoverProcess({ outcome: 'failed' }), undefined)).toBe('failed');
    expect(rowStateOf(leftoverProcess({ outcome: 'kept' }), undefined)).toBe('running');
    expect(rowStateOf(leftoverProcess({ outcome: 'kept' }), 'stopping')).toBe('stopping');
    expect(rowStateOf(leftoverProcess({ outcome: 'kept' }), 'ended')).toBe('ended');
  });

  it('says why each process kept running, or where it ran', () => {
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'window' }), 'running').text).toBe('Has an open window.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'multiplexer' }), 'running').text).toBe('A tmux server. Stopping it ends all your tmux sessions.');
    // Shared covers a supervisor running the user's work and a server another task is connected to.
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'shared' }), 'running').text).toBe('Other work uses it too. Stopping it can break that work.');
    expect(rowDetailOf(leftoverProcess(), 'stopped').text).toBe('Ran in the worktree.');
    expect(rowDetailOf(leftoverProcess({ place: 'project' }), 'stopped').text).toBe('Ran in the project folder.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept' }), 'running').text).toBe('Runs in the worktree.');
    // A kept row the user stopped drops its reason and its warning, and reads
    // like any stopped row.
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'window' }), 'stopped').text).toBe('Ran in the worktree.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'multiplexer', place: 'project' }), 'stopped').text).toBe('Ran in the project folder.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'shared' }), 'stopped').text).toBe('Ran in the worktree.');
    // While the stop is in flight the process still runs, so the reason stays.
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', reason: 'window' }), 'stopping').text).toBe('Has an open window.');
    // The tense follows the row's state, not the report's outcome: a kept row
    // with no reason that the user then stopped reads as past tense.
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept' }), 'stopped').text).toBe('Ran in the worktree.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept', place: 'project' }), 'stopped').text).toBe('Ran in the project folder.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'kept' }), 'ended').text).toBe('No longer running.');
    expect(rowDetailOf(leftoverProcess({ outcome: 'failed' }), 'failed')).toEqual({ text: 'Couldn\'t stop it. Try again, or close it yourself.', failure: true });
  });

  it('groups rows by task for a report that spans several', () => {
    const first = leftoverProcess();
    const second = leftoverProcess({ taskId: 'task-b', taskTitle: 'Update deps' });
    const third = leftoverProcess();
    expect(groupByTask([first, second, third]).map((group) => [group.taskTitle, group.processes.length])).toEqual([['Fix login', 2], ['Update deps', 1]]);
  });

  it('titles the list by its task, or by how many tasks', () => {
    expect(reportTitleOf(report([leftoverProcess()]))).toBe('Processes from "Fix login"');
    expect(reportTitleOf(report([leftoverProcess(), leftoverProcess({ taskId: 'task-b' })]))).toBe('Processes from 2 tasks');
  });
});

describe('the recheck: what it asks about, how often, and when a toast has gone stale', () => {
  it('settles a report once every row it kept or failed to stop has stopped or ended', () => {
    const kept = leftoverProcess({ outcome: 'kept', reason: 'shared', label: 'cmd' });
    const failed = leftoverProcess({ outcome: 'failed' });
    const stopped = leftoverProcess();
    const subject = report([stopped, kept, failed]);

    expect(reportHasSettled(subject, {})).toBe(false);
    expect(reportHasSettled(subject, { [kept.id]: 'ended' })).toBe(false);
    // A Stop still in flight is not settled: the toast waits for its answer.
    expect(reportHasSettled(subject, { [kept.id]: 'ended', [failed.id]: 'stopping' })).toBe(false);
    expect(reportHasSettled(subject, { [kept.id]: 'ended', [failed.id]: 'stopped' })).toBe(true);
  });

  it('never settles a report that only ever named stopped processes: its toast closes on its own', () => {
    expect(reportHasSettled(report([leftoverProcess(), leftoverProcess()]), {})).toBe(false);
  });

  it('asks about the rows that claim a live process, in reports on screen through a toast or the open list', () => {
    const toastRow = leftoverProcess({ outcome: 'kept', reason: 'window' });
    const toastStopped = leftoverProcess();
    const openRow = leftoverProcess({ outcome: 'failed' });
    const hiddenRow = leftoverProcess({ outcome: 'kept', reason: 'shared' });
    const endedRow = leftoverProcess({ outcome: 'kept', reason: 'shared' });
    const input = {
      reports: {
        'report-toast': { id: 'report-toast', stoppingEnabled: true, processes: [toastRow, toastStopped, endedRow], reportedAt: '2026-10-06T19:59:00.000Z' },
        'report-open': { id: 'report-open', stoppingEnabled: true, processes: [openRow], reportedAt: '2026-10-06T19:58:00.000Z' },
        'report-hidden': { id: 'report-hidden', stoppingEnabled: true, processes: [hiddenRow], reportedAt: '2026-10-06T20:00:00.000Z' },
      },
      reportToasts: { 'report-toast': 'toast-1', 'report-hidden': 'toast-closed' },
      openReportId: 'report-open',
      stopStates: { [endedRow.id]: 'ended' as const },
      visibleToastIds: new Set(['toast-1']),
    };

    expect(rowsToRecheck(input)).toEqual({ processIds: [toastRow.id, openRow.id], youngestReportedAt: '2026-10-06T19:59:00.000Z' });
    // Nothing on screen, nothing asked.
    expect(rowsToRecheck({ ...input, openReportId: null, visibleToastIds: new Set() })).toEqual({ processIds: [], youngestReportedAt: null });
  });

  it('rechecks every few seconds while a report is new, and slower once it is a minute old', () => {
    const reportedAt = Date.parse(REPORTED_AT);
    expect(recheckDelayMs(REPORTED_AT, reportedAt + 10_000)).toBe(LEFTOVER_RECHECK_FAST_MS);
    expect(recheckDelayMs(REPORTED_AT, reportedAt + 61_000)).toBe(LEFTOVER_RECHECK_SLOW_MS);
    expect(recheckDelayMs('not a time', reportedAt)).toBe(LEFTOVER_RECHECK_SLOW_MS);
  });
});
