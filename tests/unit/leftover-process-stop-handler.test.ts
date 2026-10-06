/**
 * The leftover-process list's Stop handler (src/main/ipc/handlers/leftover-processes.ts):
 * it stops only a process a report named, by the id the report minted, and once
 * the process is gone it retries the removal of that task's Done worktree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { LeftoverProcessReport } from '../../src/shared/types';

const { handlers, retryDoneWorktreeRemoval } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  retryDoneWorktreeRemoval: vi.fn(async () => true),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); } },
}));
vi.mock('../../src/main/ipc/helpers/task-cleanup', () => ({ retryDoneWorktreeRemoval }));
const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent }));

import { leftoverReportCounts, registerLeftoverProcessHandlers } from '../../src/main/ipc/handlers/leftover-processes';
import { leftoverProcessReports } from '../../src/main/ipc/helpers/leftover-process-reports';
import { IPC } from '../../src/shared/ipc-channels';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const PROJECT_PATH = '/mock/project';
const OTHER_PROJECT_PATH = '/mock/other-project';

function reportOne(): Promise<string> {
  return new Promise((resolve) => {
    vi.useFakeTimers();
    leftoverProcessReports.add(
      (report: LeftoverProcessReport) => resolve(report.processes[0].id),
      [{ taskId: TASK, pid: 4242, startKey: 'start-4242', label: 'chrome', outcome: 'kept', reason: 'window', place: 'worktree' }],
      new Map([[TASK, 'Fix login']]),
      true,
      PROJECT_PATH,
    );
    vi.runAllTimers();
    vi.useRealTimers();
  });
}

function setup(outcome: 'stopped' | 'ended' | 'failed', ambient: { currentProjectPath?: string | null } = {}) {
  const stopReportedProcess = vi.fn(async () => outcome);
  const context = { sessionManager: { stopReportedProcess }, ...ambient } as unknown as IpcContext;
  registerLeftoverProcessHandlers(context);
  const handler = handlers.get(IPC.LEFTOVER_PROCESSES_STOP)!;
  return { context, stopReportedProcess, stop: (processId: unknown) => handler({}, processId) };
}

beforeEach(() => {
  handlers.clear();
  retryDoneWorktreeRemoval.mockClear();
});

describe('LEFTOVER_PROCESSES_STOP', () => {
  it('stops the reported process by its identity, then retries its Done worktree removal', async () => {
    const processId = await reportOne();
    const { context, stopReportedProcess, stop } = setup('stopped');
    expect(await stop(processId)).toBe('stopped');
    expect(stopReportedProcess).toHaveBeenCalledWith(4242, 'start-4242');
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledWith(context, PROJECT_PATH, TASK);
  });

  it('retries in the project the report was minted for, not the one open when Stop is pressed', async () => {
    // The report was minted for PROJECT_PATH. By the time the user presses Stop
    // another project is open, so the ambient current path is a different one.
    // The task belongs to the first project: asking the open one to remove its
    // worktree would look the task up in the wrong database and do nothing.
    const processId = await reportOne();
    const { context, stop } = setup('stopped', { currentProjectPath: OTHER_PROJECT_PATH });
    expect(await stop(processId)).toBe('stopped');
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledTimes(1);
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledWith(context, PROJECT_PATH, TASK);
    expect(retryDoneWorktreeRemoval).not.toHaveBeenCalledWith(expect.anything(), OTHER_PROJECT_PATH, expect.anything());
  });

  it('retries too when the process had already ended, since the worktree may be free now', async () => {
    const processId = await reportOne();
    const { stop } = setup('ended');
    expect(await stop(processId)).toBe('ended');
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledTimes(1);
  });

  it('does not retry the removal when the stop failed: the process still holds the directory', async () => {
    const processId = await reportOne();
    const { stop } = setup('failed');
    expect(await stop(processId)).toBe('failed');
    expect(retryDoneWorktreeRemoval).not.toHaveBeenCalled();
  });

  it('counts each report it sends for analytics, counts only', async () => {
    trackEvent.mockClear();
    setup('stopped');
    await reportOne();
    expect(trackEvent).toHaveBeenCalledWith('leftover_processes', { stopped: 0, kept: 1, failed: 0, stoppingEnabled: true });
    expect(JSON.stringify(trackEvent.mock.calls)).not.toMatch(/chrome|4242|Fix login/);
  });

  it('never stops anything for an id no report minted, a raw pid included', async () => {
    const { stopReportedProcess, stop } = setup('stopped');
    expect(await stop('4242')).toBe('ended');
    expect(await stop(4242)).toBe('ended');
    expect(await stop('made-up')).toBe('ended');
    expect(stopReportedProcess).not.toHaveBeenCalled();
    expect(retryDoneWorktreeRemoval).not.toHaveBeenCalled();
  });
});

describe('leftoverReportCounts', () => {
  it('counts stopped, kept and failed processes', () => {
    const process = (outcome: 'stopped' | 'kept' | 'failed') => ({
      id: outcome, taskId: TASK, taskTitle: 'Fix login', pid: 1, label: 'node', outcome, reason: null, place: 'worktree' as const,
    });
    expect(leftoverReportCounts({ id: 'report', stoppingEnabled: false, processes: [process('stopped'), process('stopped'), process('kept'), process('failed')], reportedAt: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ stopped: 2, kept: 1, failed: 1, stoppingEnabled: false });
  });
});
