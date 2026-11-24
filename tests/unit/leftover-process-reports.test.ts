/**
 * The leftover-process report collector (src/main/ipc/helpers/leftover-process-reports.ts):
 * one report per burst of reaps, so a bulk delete is one toast, and a Stop that
 * can only name a process a report minted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeftoverProcessReports, REPORT_MAX_WAIT_MS, REPORT_QUIET_MS, RETAINED_PROCESS_IDS } from '../../src/main/ipc/helpers/leftover-process-reports';
import type { LeftoverProcessEntry } from '../../src/main/pty/process-tag/tagged-reap';
import type { LeftoverProcessReport } from '../../src/shared/types';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';

function entry(pid: number, taskId = TASK, overrides: Partial<LeftoverProcessEntry> = {}): LeftoverProcessEntry {
  return { taskId, pid, startKey: `start-${pid}`, label: `node (app-${pid})`, outcome: 'stopped', reason: null, place: 'worktree', ...overrides };
}

const TITLES = new Map([[TASK, 'Fix login'], [OTHER_TASK, 'Update deps']]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LeftoverProcessReports', () => {
  it('sends one report for a burst of reaps, once they go quiet', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS - 1);
    reports.add((report) => sent.push(report), [entry(3001, OTHER_TASK)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].stoppingEnabled).toBe(true);
    expect(sent[0].processes.map((process) => [process.pid, process.taskTitle])).toEqual([[2001, 'Fix login'], [3001, 'Update deps']]);
  });

  it('stamps the report with when it was sent, in UTC, for the toast\'s age', () => {
    vi.setSystemTime(new Date('2026-10-06T19:59:10.000Z'));
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS);
    expect(sent[0].reportedAt).toBe(new Date(Date.parse('2026-10-06T19:59:10.000Z') + REPORT_QUIET_MS).toISOString());
    expect(sent[0].reportedAt).toMatch(/Z$/);
  });

  it('holds the report while another reap is still running, so two tasks reset together are one toast', () => {
    // The shape a preview measured: the host runs the second request in its
    // next batch, so its result lands a second after the first's.
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    const releaseFirst = reports.beginReap();
    const releaseSecond = reports.beginReap();
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    releaseFirst();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    reports.add((report) => sent.push(report), [entry(3001, OTHER_TASK)], TITLES, true);
    releaseSecond();
    releaseSecond();
    vi.advanceTimersByTime(REPORT_QUIET_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].processes.map((process) => process.pid)).toEqual([2001, 3001]);
  });

  it('holds the report while a reap runs, and sends it once that reap is released', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    const releaseRunningReap = reports.beginReap();
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS * 2);
    expect(sent).toEqual([]);
    releaseRunningReap();
    vi.advanceTimersByTime(REPORT_QUIET_MS);
    expect(sent).toHaveLength(1);
  });

  it('sends by the longest wait even while reaps keep arriving', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    for (let elapsed = 0; elapsed < REPORT_MAX_WAIT_MS; elapsed += REPORT_QUIET_MS / 2) {
      reports.add((report) => sent.push(report), [entry(2000 + elapsed)], TITLES, true);
      vi.advanceTimersByTime(REPORT_QUIET_MS / 2);
    }
    expect(sent).toHaveLength(1);
  });

  it('sends by the longest wait even while a reap never finishes, and holds the next burst until that reap is released', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    // Never released: a hung reap must not keep the user from hearing what the others found.
    const releaseHungReap = reports.beginReap();
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);

    // The quiet window ends many times over while the reap is held, and sends nothing.
    vi.advanceTimersByTime(REPORT_MAX_WAIT_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].processes.map((process) => process.pid)).toEqual([2001]);

    // The reap is still running, so the next burst waits for its release as before.
    reports.add((report) => sent.push(report), [entry(3001, OTHER_TASK)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS * 2);
    expect(sent).toHaveLength(1);

    releaseHungReap();
    // Exactly one quiet window, not runAllTimers: that would also fire the second
    // burst's longest wait and hide a release that did not re-arm the quiet timer.
    vi.advanceTimersByTime(REPORT_QUIET_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].processes.map((process) => process.pid)).toEqual([3001]);
  });

  it('sends nothing for a reap that reported nothing', () => {
    const reports = new LeftoverProcessReports();
    const send = vi.fn();
    reports.add(send, [], TITLES, true);
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a stopping-off report apart from a stopping-on one', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    reports.add((report) => sent.push(report), [entry(2002, TASK, { outcome: 'kept' })], TITLES, false);
    vi.runAllTimers();
    // Exactly two reports, each holding only its own reap: no merged report and
    // no duplicate. Sorted by the flag because the send order is not the contract.
    expect(sent).toHaveLength(2);
    const sentByFlag = [...sent].sort((first, second) => Number(first.stoppingEnabled) - Number(second.stoppingEnabled));
    expect(sentByFlag.map((report) => ({
      stoppingEnabled: report.stoppingEnabled,
      processes: report.processes.map((reported) => [reported.pid, reported.outcome]),
    }))).toEqual([
      { stoppingEnabled: false, processes: [[2002, 'kept']] },
      { stoppingEnabled: true, processes: [[2001, 'stopped']] },
    ]);
  });

  it('carries no start key to the renderer, and resolves a minted id back to its identity', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.runAllTimers();
    const [reported] = sent[0].processes;
    expect(reported).not.toHaveProperty('startKey');
    expect(reports.resolve(reported.id)).toEqual({ pid: 2001, startKey: 'start-2001', taskId: TASK, projectPath: null, place: 'worktree', outcome: 'stopped' });
    expect(reports.resolve('2001')).toBeNull();
    expect(reports.resolve('made-up')).toBeNull();
  });

  it('names what was left working in one task\'s worktree, once each, and nothing else', () => {
    const reports = new LeftoverProcessReports();
    const add = (entries: LeftoverProcessEntry[], projectPath: string) => reports.add(vi.fn(), entries, TITLES, true, projectPath);
    add([
      entry(2001, TASK, { outcome: 'kept', reason: 'window' }),
      entry(2002, TASK, { outcome: 'failed' }),
      entry(2003),
      entry(2004, TASK, { outcome: 'kept', place: 'project' }),
      entry(2005, 'another-task', { outcome: 'kept' }),
    ], '/mock/project');
    add([entry(2006, TASK, { outcome: 'kept' })], '/mock/other-project');
    // A later reap reports the same window again.
    add([entry(2001, TASK, { outcome: 'kept', reason: 'window' })], '/mock/project');

    expect(reports.leftInWorktree('/mock/project', TASK)).toEqual([
      { pid: 2001, startKey: 'start-2001' },
      { pid: 2002, startKey: 'start-2002' },
    ]);
    expect(reports.leftInWorktree('/mock/unknown', TASK)).toEqual([]);
  });

  // What a startup sweep kept was reported when its task ended, and is not reported again.
  it('remembers what was left in a worktree without reporting it', () => {
    const reports = new LeftoverProcessReports();
    const listener = vi.fn();
    reports.setReportListener(listener);

    reports.rememberLeft([
      entry(2001, TASK, { outcome: 'kept', reason: 'window' }),
      entry(2002, TASK, { outcome: 'kept', place: 'project' }),
      // A stopped process no longer holds the folder, so it is not remembered.
      entry(2003, TASK, { outcome: 'stopped' }),
    ], '/mock/project');
    vi.runAllTimers();

    expect(reports.leftInWorktree('/mock/project', TASK)).toEqual([{ pid: 2001, startKey: 'start-2001' }]);
    expect(listener).not.toHaveBeenCalled();
  });

  // A user loses the Stop button on a reported process if a long startup sweep pushes it out.
  it('keeps remembered processes out of the ids the Stop button can reach', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(1, TASK, { outcome: 'kept' })], TITLES, true, '/mock/project');
    vi.runAllTimers();
    const reportedId = sent[0].processes[0].id;

    const remembered = Array.from({ length: RETAINED_PROCESS_IDS + 1 }, (_unused, index) => entry(10_000 + index, TASK, { outcome: 'kept' }));
    reports.rememberLeft(remembered, '/mock/project');

    expect(reports.resolve(reportedId)).not.toBeNull();
  });

  it('bounds what it remembers, dropping the oldest first', () => {
    const reports = new LeftoverProcessReports();
    const remembered = Array.from({ length: RETAINED_PROCESS_IDS + 1 }, (_unused, index) => entry(10_000 + index, TASK, { outcome: 'kept' }));
    reports.rememberLeft(remembered, '/mock/project');

    const left = reports.leftInWorktree('/mock/project', TASK);
    expect(left).toHaveLength(RETAINED_PROCESS_IDS);
    expect(left).not.toContainEqual({ pid: 10_000, startKey: 'start-10000' });
    expect(left).toContainEqual({ pid: 10_000 + RETAINED_PROCESS_IDS, startKey: `start-${10_000 + RETAINED_PROCESS_IDS}` });
  });

  it('keeps only the newest ids the Stop button can reach, dropping the oldest first', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    const firstPid = 10_000;
    const entries = Array.from({ length: RETAINED_PROCESS_IDS + 1 }, (_unused, index) => entry(firstPid + index));
    reports.add((report) => sent.push(report), entries, TITLES, true);
    vi.runAllTimers();

    // The report itself is not trimmed: every process is told to the renderer.
    const ids = sent[0].processes.map((process) => process.id);
    expect(ids).toHaveLength(RETAINED_PROCESS_IDS + 1);

    // One over the cap evicts exactly one id, the first minted.
    expect(reports.resolve(ids[0])).toBeNull();
    // The second-oldest is the boundary: still reachable at exactly the cap.
    expect(reports.resolve(ids[1])).toEqual({ pid: firstPid + 1, startKey: `start-${firstPid + 1}`, taskId: TASK, projectPath: null, place: 'worktree', outcome: 'stopped' });
    // The newest is retained with its full identity.
    expect(reports.resolve(ids[RETAINED_PROCESS_IDS])).toEqual({
      pid: firstPid + RETAINED_PROCESS_IDS,
      startKey: `start-${firstPid + RETAINED_PROCESS_IDS}`,
      taskId: TASK,
      projectPath: null,
      place: 'worktree',
      outcome: 'stopped',
    });
  });

  it('carries a kept process\'s reason to the renderer unchanged, including outside', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [
      entry(2001, TASK, { outcome: 'kept', reason: 'outside' }),
      entry(2002, TASK, { outcome: 'kept', reason: 'shared' }),
      entry(2003, TASK, { outcome: 'kept', reason: 'window' }),
      entry(2004, TASK, { outcome: 'kept', reason: 'multiplexer' }),
      entry(2005),
    ], TITLES, false);
    vi.runAllTimers();
    expect(sent[0].processes.map((reported) => [reported.pid, reported.outcome, reported.reason])).toEqual([
      [2001, 'kept', 'outside'],
      [2002, 'kept', 'shared'],
      [2003, 'kept', 'window'],
      [2004, 'kept', 'multiplexer'],
      [2005, 'stopped', null],
    ]);
  });

  it('falls back to a generic title for a task it was not told about', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001, '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b')], TITLES, true);
    vi.runAllTimers();
    expect(sent[0].processes[0].taskTitle).toBe('Task');
  });

  it('hands each sent report to its listener once, and a throwing listener changes nothing', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    const heard: LeftoverProcessReport[] = [];
    reports.setReportListener((report) => heard.push(report));
    reports.add((report) => sent.push(report), [entry(2001), entry(2002)], TITLES, true);
    vi.runAllTimers();
    expect(heard).toEqual(sent);
    reports.setReportListener(() => { throw new Error('analytics down'); });
    reports.add((report) => sent.push(report), [entry(2003)], TITLES, true);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('never throws from its timer when the send fails', () => {
    const reports = new LeftoverProcessReports();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reports.add(() => { throw new Error('window gone'); }, [entry(2001)], TITLES, true);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
