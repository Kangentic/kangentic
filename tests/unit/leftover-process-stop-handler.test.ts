/**
 * The leftover-process list's Stop handler (src/main/ipc/handlers/leftover-processes.ts):
 * it stops only a process a report named, by the id the report minted, and once
 * the process is gone it retries the removal of that task's Done worktree. A
 * Stop the host finishes after main stopped waiting does both when it lands.
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
const { sendToRenderer } = vi.hoisted(() => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer }));

import { MAX_CHECKED_PROCESSES, leftoverReportCounts, registerLeftoverProcessHandlers } from '../../src/main/ipc/handlers/leftover-processes';
import { RETAINED_PROCESS_IDS, leftoverProcessReports } from '../../src/main/ipc/helpers/leftover-process-reports';
import { IPC } from '../../src/shared/ipc-channels';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const PROJECT_PATH = '/mock/project';
const OTHER_PROJECT_PATH = '/mock/other-project';

/** Mint one report id for a process of `taskId` in `projectPath`, the way a reap's report does. */
function reportProcess(taskId: string, projectPath: string, pid = 4242, startKey = `start-${pid}`): Promise<string> {
  return new Promise((resolve) => {
    vi.useFakeTimers();
    leftoverProcessReports.add(
      (report: LeftoverProcessReport) => resolve(report.processes[0].id),
      [{ taskId, pid, startKey, label: 'chrome', outcome: 'kept', reason: 'window', because: null, place: 'worktree' }],
      new Map([[taskId, 'Fix login']]),
      true,
      projectPath,
    );
    vi.runAllTimers();
    vi.useRealTimers();
  });
}

function reportOne(): Promise<string> {
  return reportProcess(TASK, PROJECT_PATH);
}

/** Mint `count` ids in one report, each for its own process (pid 10000 + index), the way one big reap does. */
function reportMany(count: number): Promise<string[]> {
  return new Promise((resolve) => {
    vi.useFakeTimers();
    leftoverProcessReports.add(
      (report: LeftoverProcessReport) => resolve(report.processes.map((reported) => reported.id)),
      Array.from({ length: count }, (_unused, index) => ({
        taskId: TASK, pid: 10_000 + index, startKey: `start-${10_000 + index}`, label: 'chrome', outcome: 'kept' as const, reason: 'window' as const, because: null, place: 'worktree' as const,
      })),
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
  sendToRenderer.mockClear();
});

describe('LEFTOVER_PROCESSES_STOP', () => {
  it('stops the reported process by its identity, then retries its Done worktree removal', async () => {
    const processId = await reportOne();
    const { context, stopReportedProcess, stop } = setup('stopped');
    expect(await stop(processId)).toBe('stopped');
    expect(stopReportedProcess).toHaveBeenCalledWith(4242, 'start-4242', expect.any(Function));
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

  // A Stop that ran past main's budget answers `failed`, but the host still
  // finishes it. When its real outcome arrives, the row is corrected and the
  // removal it was holding up is retried, as for a Stop that answered in time.
  describe('a Stop the host finished after main stopped waiting', () => {
    function setupLate() {
      let settleLate: ((outcome: 'stopped' | 'ended' | 'failed') => void) | undefined;
      const stopReportedProcess = vi.fn(async (_pid: number, _startKey: string, onLateOutcome?: (outcome: 'stopped' | 'ended' | 'failed') => void) => {
        settleLate = onLateOutcome;
        return 'failed' as const;
      });
      const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
      const context = { sessionManager: { stopReportedProcess }, mainWindow } as unknown as IpcContext;
      registerLeftoverProcessHandlers(context);
      const handler = handlers.get(IPC.LEFTOVER_PROCESSES_STOP)!;
      return { context, mainWindow, stop: (processId: unknown) => handler({}, processId), settleLate: (outcome: 'stopped' | 'ended' | 'failed') => settleLate?.(outcome) };
    }

    it('pushes the outcome to the row and retries the Done worktree once the process is gone', async () => {
      const processId = await reportOne();
      const { context, mainWindow, stop, settleLate } = setupLate();
      expect(await stop(processId)).toBe('failed');
      expect(retryDoneWorktreeRemoval).not.toHaveBeenCalled();
      expect(sendToRenderer).not.toHaveBeenCalled();

      settleLate('stopped');

      expect(sendToRenderer).toHaveBeenCalledWith(mainWindow, IPC.LEFTOVER_PROCESSES_STOP_SETTLED, { processId, outcome: 'stopped' });
      expect(retryDoneWorktreeRemoval).toHaveBeenCalledWith(context, PROJECT_PATH, TASK);
    });

    it('pushes a late failure too, and retries nothing: the process still holds the directory', async () => {
      const processId = await reportOne();
      const { mainWindow, stop, settleLate } = setupLate();
      await stop(processId);

      settleLate('failed');

      expect(sendToRenderer).toHaveBeenCalledWith(mainWindow, IPC.LEFTOVER_PROCESSES_STOP_SETTLED, { processId, outcome: 'failed' });
      expect(retryDoneWorktreeRemoval).not.toHaveBeenCalled();
    });
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

/**
 * The list's recheck: it names reported processes by report id, like Stop,
 * and answers only the ids whose process main's host read as ended. Unknown
 * is never ended, and an id no report minted is never asked about.
 */
describe('LEFTOVER_PROCESSES_CHECK', () => {
  function setupCheck(answers: Array<boolean | null> | Error) {
    const checkReportedProcesses = vi.fn(async (identities: Array<{ pid: number; startKey: string }>) => {
      if (answers instanceof Error) throw answers;
      return identities.map((_identity, index) => answers[index] ?? null);
    });
    const context = { sessionManager: { stopReportedProcess: vi.fn(), checkReportedProcesses } } as unknown as IpcContext;
    registerLeftoverProcessHandlers(context);
    const handler = handlers.get(IPC.LEFTOVER_PROCESSES_CHECK)!;
    return { context, checkReportedProcesses, check: (processIds: unknown) => handler({}, processIds) };
  }

  it('asks by the identity the report saw, answers the ended ids, and retries that task\'s Done worktree removal', async () => {
    const endedId = await reportOne();
    const runningId = await reportOne();
    const { context, checkReportedProcesses, check } = setupCheck([false, true]);

    expect(await check([endedId, runningId])).toEqual([endedId]);
    expect(checkReportedProcesses).toHaveBeenCalledWith([{ pid: 4242, startKey: 'start-4242' }, { pid: 4242, startKey: 'start-4242' }]);
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledTimes(1);
    expect(retryDoneWorktreeRemoval).toHaveBeenCalledWith(context, PROJECT_PATH, TASK);
  });

  it('reads unknown as still running, and retries nothing for it', async () => {
    const processId = await reportOne();
    const { check } = setupCheck([null]);

    expect(await check([processId])).toEqual([]);
    expect(retryDoneWorktreeRemoval).not.toHaveBeenCalled();
  });

  it('never asks about an id no report minted, a raw pid, or a value that is not a list', async () => {
    const { checkReportedProcesses, check } = setupCheck([false]);

    expect(await check(['4242', 'made-up', 4242])).toEqual([]);
    expect(await check('4242')).toEqual([]);
    expect(await check(undefined)).toEqual([]);
    expect(checkReportedProcesses).not.toHaveBeenCalled();
  });

  it('asks once per id however many times the renderer names it', async () => {
    const processId = await reportOne();
    const { checkReportedProcesses, check } = setupCheck([false]);

    expect(await check([processId, processId])).toEqual([processId]);
    expect(checkReportedProcesses).toHaveBeenCalledWith([{ pid: 4242, startKey: 'start-4242' }]);
  });

  // An ended process may have been what held its task's Done worktree, so the
  // removal is retried. A task with several ended processes needs ONE retry:
  // the removal is a whole-worktree operation, and every extra call repeats it.
  // Still, a task is told apart by its project as well as its id.
  it('retries a task\'s Done worktree removal once however many of its processes ended, and once more for each other task or project', async () => {
    const firstOfTask = await reportProcess(TASK, PROJECT_PATH, 4242);
    const secondOfTask = await reportProcess(TASK, PROJECT_PATH, 4243);
    const otherTask = await reportProcess(OTHER_TASK, PROJECT_PATH, 4244);
    const sameTaskIdInOtherProject = await reportProcess(TASK, OTHER_PROJECT_PATH, 4245);
    const { context, checkReportedProcesses, check } = setupCheck([false, false, false, false]);

    // Every ended id is answered: the dedupe is for the retry, never for the answer.
    expect(await check([firstOfTask, secondOfTask, otherTask, sameTaskIdInOtherProject]))
      .toEqual([firstOfTask, secondOfTask, otherTask, sameTaskIdInOtherProject]);
    // Positive control: all four processes were asked about, so the retries below are the dedupe's doing.
    expect(checkReportedProcesses.mock.calls[0][0]).toHaveLength(4);
    expect(retryDoneWorktreeRemoval.mock.calls).toEqual([
      [context, PROJECT_PATH, TASK],
      [context, PROJECT_PATH, OTHER_TASK],
      [context, OTHER_PROJECT_PATH, TASK],
    ]);
  });

  it('keeps the retry dedupe to one recheck: a later recheck that finds the process ended retries again', async () => {
    const processId = await reportOne();
    const { check } = setupCheck([false]);

    await check([processId]);
    await check([processId]);

    expect(retryDoneWorktreeRemoval).toHaveBeenCalledTimes(2);
  });

  // A recheck names at most as many ids as main keeps identities for, so an
  // oversized list from the renderer costs main no more than a full one. Real
  // minting cannot yield MAX_CHECKED_PROCESSES + 1 valid ids (main forgets the
  // oldest past RETAINED_PROCESS_IDS), so the boundary is read by putting one
  // unminted id in front: the last valid id then sits at position MAX + 1.
  describe('a list longer than the cap', () => {
    it('sets the cap to the number of ids main retains, so no valid id can lie past it', () => {
      expect(MAX_CHECKED_PROCESSES).toBe(RETAINED_PROCESS_IDS);
    });

    it('asks about every id of a list exactly as long as the cap', async () => {
      const mintedIds = await reportMany(MAX_CHECKED_PROCESSES);
      expect(mintedIds).toHaveLength(MAX_CHECKED_PROCESSES);
      const { checkReportedProcesses, check } = setupCheck([]);

      await check(mintedIds);

      expect(checkReportedProcesses).toHaveBeenCalledTimes(1);
      expect(checkReportedProcesses.mock.calls[0][0]).toHaveLength(MAX_CHECKED_PROCESSES);
    });

    it('never asks about an id past the cap, however it got there', async () => {
      const mintedIds = await reportMany(MAX_CHECKED_PROCESSES);
      const overflowingIds = ['not-minted', ...mintedIds];
      expect(overflowingIds).toHaveLength(MAX_CHECKED_PROCESSES + 1);
      const { checkReportedProcesses, check } = setupCheck([]);

      await check(overflowingIds);

      // The cap cut the list at MAX positions: the unminted id, then the first MAX - 1 minted ones.
      expect(checkReportedProcesses).toHaveBeenCalledTimes(1);
      const askedIdentities = checkReportedProcesses.mock.calls[0][0];
      expect(askedIdentities).toHaveLength(MAX_CHECKED_PROCESSES - 1);
      expect(askedIdentities[0]).toEqual({ pid: 10_000, startKey: 'start-10000' });
      const lastMintedPid = 10_000 + MAX_CHECKED_PROCESSES - 1;
      expect(askedIdentities.map((identity) => identity.pid)).not.toContain(lastMintedPid);
      expect(askedIdentities.at(-1)).toEqual({ pid: lastMintedPid - 1, startKey: `start-${lastMintedPid - 1}` });
    });
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
