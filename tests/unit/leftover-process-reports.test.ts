/**
 * The leftover-process report collector (src/main/ipc/helpers/leftover-process-reports.ts):
 * one report per burst of reaps, so a bulk delete is one toast, and a Stop that
 * can only name a process a report minted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeftoverProcessReports, REPORT_MAX_WAIT_MS, REPORT_QUIET_MS } from '../../src/main/ipc/helpers/leftover-process-reports';
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

  it('a reap that reported nothing does not hold a report forever', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    const releaseEmpty = reports.beginReap();
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.advanceTimersByTime(REPORT_QUIET_MS * 2);
    expect(sent).toEqual([]);
    releaseEmpty();
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
    expect(sent.map((report) => [report.stoppingEnabled, report.processes.length])).toEqual(expect.arrayContaining([[true, 1], [false, 1]]));
  });

  it('carries no start key to the renderer, and resolves a minted id back to its identity', () => {
    const reports = new LeftoverProcessReports();
    const sent: LeftoverProcessReport[] = [];
    reports.add((report) => sent.push(report), [entry(2001)], TITLES, true);
    vi.runAllTimers();
    const [reported] = sent[0].processes;
    expect(reported).not.toHaveProperty('startKey');
    expect(reports.resolve(reported.id)).toEqual({ pid: 2001, startKey: 'start-2001', taskId: TASK, projectPath: null });
    expect(reports.resolve('2001')).toBeNull();
    expect(reports.resolve('made-up')).toBeNull();
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
