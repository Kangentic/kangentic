/**
 * A task leftover reap that fails tells Sentry once per stage and code per launch
 * (src/main/pty/task-reap-failure-report.ts), with a fixed message and code and
 * never the failure's own text, and SessionManager reports every way a reap
 * or a Stop can fail. The WSL cases fake `process.platform` as win32 and answer
 * `wsl.exe` from a fake off-main executor, so they run on every OS. The last
 * group pins the worktree path SessionManager hands the host: the real path of a
 * link, or the stored path when it does not resolve.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message.replace(/[A-Z]:\\[^\s:;,)]+/gi, '<path>').replace(/\/(?:home|Users)\/[^\s:;,)]+/g, '<path>'),
}));
const { reportHandledError } = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import { reportTaskReapFailure, resetTaskReapFailureReports } from '../../src/main/pty/task-reap-failure-report';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { LeftoverProcessEntry, StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import { PtyHostExitedError, PtyHostTimeoutError } from '../../src/main/pty/host/pty-host-request-errors';
import type { HostExecRequest } from '../../src/main/pty/host/protocol';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };
const realPlatform = process.platform;

beforeEach(() => {
  reportHandledError.mockClear();
  resetTaskReapFailureReports();
});

type HostStub = {
  reapTaggedProcesses: (request: TaggedReapRequest, timeoutMs: number, onLateResult?: (result: TaggedReapResult) => void) => Promise<TaggedReapResult>;
  stopReportedProcess: (request: unknown, timeoutMs: number, onLateResult?: (result: StopProcessResult) => void) => Promise<StopProcessResult>;
};

function managerWithHost(host: Partial<HostStub>): SessionManager {
  const manager = new SessionManager();
  Object.assign((manager as unknown as { host: HostStub }).host, host);
  return manager;
}

describe('reportTaskReapFailure', () => {
  it('reports each stage and code once per launch, under a fixed message', () => {
    reportTaskReapFailure('reap', 'empty_scan');
    reportTaskReapFailure('reap', 'empty_scan');
    reportTaskReapFailure('reap', 'host_error');
    reportTaskReapFailure('stop', 'host_error');
    expect(reportHandledError).toHaveBeenCalledTimes(3);
    const [error, tags, contexts] = reportHandledError.mock.calls[0];
    expect((error as Error).message).toBe('Task leftover reap failed: empty_scan');
    expect(tags).toEqual({ source: 'task_reap', stage: 'reap', code: 'empty_scan' });
    expect(contexts).toEqual({});
  });

  it('carries a reader load error, paths stripped, in a context and never in the message', () => {
    reportTaskReapFailure('reap', 'reader_load', 'dlopen(/Users/dev/app/node_modules/koffi/build/koffi.node): image not found');
    const [error, tags, contexts] = reportHandledError.mock.calls[0];
    expect((error as Error).message).toBe('Task leftover reap failed: reader_load');
    expect(tags).toEqual({ source: 'task_reap', stage: 'reap', code: 'reader_load' });
    expect(contexts).toEqual({ task_reap: { loadError: 'dlopen(<path>): image not found' } });
  });

  it('strips a load error path whose profile folder holds a space', () => {
    reportTaskReapFailure(
      'reap',
      'reader_load',
      'dlopen(C:\\Users\\First Last\\AppData\\Local\\Programs\\kangentic\\resources\\app.asar.unpacked\\node_modules\\koffi\\build\\koffi.node): not a valid Win32 application',
    );
    const [, , contexts] = reportHandledError.mock.calls[0];
    expect(contexts).toEqual({ task_reap: { loadError: 'dlopen(<path>): not a valid Win32 application' } });
    expect(JSON.stringify(contexts)).not.toContain('Last');
  });

  it('carries a scan step\'s code and the failing pass as tags, under the fixed message, without splitting by pass', () => {
    reportTaskReapFailure('reap', 'window_list', null, 'second');
    reportTaskReapFailure('reap', 'window_list', null, 'first');
    reportTaskReapFailure('reap', 'process_list', null, 'first');
    expect(reportHandledError).toHaveBeenCalledTimes(2);
    const [error, tags, contexts] = reportHandledError.mock.calls[0];
    expect((error as Error).message).toBe('Task leftover reap failed: window_list');
    expect(tags).toEqual({ source: 'task_reap', stage: 'reap', code: 'window_list', pass: 'second' });
    expect(contexts).toEqual({});
    expect(reportHandledError.mock.calls[1][1]).toEqual({ source: 'task_reap', stage: 'reap', code: 'process_list', pass: 'first' });
  });

  it('drops the text of any other failure: it can come from a process scan', () => {
    reportTaskReapFailure('reap', 'reap_error', 'API_TOKEN=secret in a parse error');
    const call = JSON.stringify(reportHandledError.mock.calls[0]);
    expect(call).not.toContain('secret');
  });
});

describe('SessionManager reports a failed reap and a failed Stop', () => {
  const failed = (
    failureCode: TaggedReapResult['failureCode'],
    failureReason: string,
    failurePass: TaggedReapResult['failurePass'] = null,
  ): TaggedReapResult => ({
    killedPids: [], unreadableCount: 0, failureReason, failureCode, failurePass, entries: [],
  });

  it('reports the reap\'s code, and the load error only for a reader that would not load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({ reapTaggedProcesses: async () => failed('reader_load', 'Cannot find module koffi') });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Task leftover reap failed: reader_load' }),
      { source: 'task_reap', stage: 'reap', code: 'reader_load' },
      { task_reap: { loadError: 'Cannot find module koffi' } },
    );

    const scanFailure = managerWithHost({ reapTaggedProcesses: async () => failed('reap_error', 'parse failed near SECRET=1') });
    await scanFailure.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(reportHandledError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Task leftover reap failed: reap_error' }), expect.anything(), {});
    warn.mockRestore();
  });

  it('reports a macOS window list that failed, with the pass it failed in and never the failure\'s text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({ reapTaggedProcesses: async () => failed('window_list', 'lsappinfo list did not run', 'second') });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Task leftover reap failed: window_list' }),
      { source: 'task_reap', stage: 'reap', code: 'window_list', pass: 'second' },
      {},
    );
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toContain('lsappinfo');
    // The text stays in the local log.
    expect(warn).toHaveBeenCalledWith('[TASK-REAP] reap failed (non-fatal): lsappinfo list did not run');
    warn.mockRestore();
  });

  it('reports a connection read that failed under its own code, with its pass, and never the failure\'s text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({ reapTaggedProcesses: async () => failed('connection_list', 'GetExtendedTcpTable failed with 87', 'first') });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Task leftover reap failed: connection_list' }),
      { source: 'task_reap', stage: 'reap', code: 'connection_list', pass: 'first' },
      {},
    );
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toContain('GetExtendedTcpTable');
    warn.mockRestore();
  });

  it('reports a Stop the host ran but could not finish, with its code and pass and never its text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({
      stopReportedProcess: async () => ({ outcome: 'failed', failureCode: 'window_list', failurePass: 'second', failureReason: 'lsappinfo list did not run' }),
    });
    expect(await manager.stopReportedProcess(4242, 'start-4242')).toBe('failed');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Task leftover stop failed: window_list' }),
      { source: 'task_reap', stage: 'stop', code: 'window_list', pass: 'second' },
      {},
    );
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toContain('lsappinfo');
    expect(warn).toHaveBeenCalledWith('[TASK-REAP] stop failed (non-fatal): lsappinfo list did not run');
    warn.mockRestore();
  });

  it('gives the host 30 s to answer a reap and 30 s to answer a Stop', async () => {
    // The literal is the point: the budget is not imported, so a change to it must change this test.
    const reapBudgets: number[] = [];
    const stopBudgets: number[] = [];
    const manager = managerWithHost({
      reapTaggedProcesses: async (_request, timeoutMs) => {
        reapBudgets.push(timeoutMs);
        return EMPTY_REAP;
      },
      stopReportedProcess: async (_request, timeoutMs) => {
        stopBudgets.push(timeoutMs);
        return { outcome: 'stopped', failureCode: null, failurePass: null, failureReason: null };
      },
    });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(await manager.stopReportedProcess(4242, 'start-4242')).toBe('stopped');
    expect(reapBudgets).toEqual([30_000]);
    expect(stopBudgets).toEqual([30_000]);
  });

  it('asks the host to stop a worktree holder by its creation time, within 5 s, since the removal waits inside its project\'s git queue', async () => {
    // The literal is the point, as for the reap's budget above.
    const requests: unknown[] = [];
    const budgets: number[] = [];
    const manager = managerWithHost({
      stopReportedProcess: async (request, timeoutMs) => {
        requests.push(request);
        budgets.push(timeoutMs);
        return { outcome: 'stopped', failureCode: null, failurePass: null, failureReason: null };
      },
    });
    expect(await manager.stopProcessByCreationTime(4242, 1_792_057_142_367)).toBe('stopped');
    expect(requests).toEqual([{ pid: 4242, startKey: '', startedAtMs: 1_792_057_142_367, mainPid: process.pid }]);
    expect(budgets).toEqual([5_000]);
  });

  it('keeps a worktree holder stop that failed in the local log, since it is not a Stop the user asked for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unfinished = managerWithHost({
      stopReportedProcess: async () => ({ outcome: 'failed', failureCode: 'process_list', failurePass: 'first', failureReason: 'the snapshot failed' }),
    });
    expect(await unfinished.stopProcessByCreationTime(4242, 1)).toBe('failed');
    const timedOut = managerWithHost({ stopReportedProcess: async () => { throw new PtyHostTimeoutError('stopReportedProcess'); } });
    expect(await timedOut.stopProcessByCreationTime(4242, 1)).toBe('failed');
    expect(reportHandledError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[REAPER] worktree holder stop failed (pid=4242): the snapshot failed');
    warn.mockRestore();
  });

  it('reports nothing for a Stop that answered, a refusal or a survivor included', async () => {
    const manager = managerWithHost({
      stopReportedProcess: async () => ({ outcome: 'failed', failureCode: null, failurePass: null, failureReason: null }),
    });
    expect(await manager.stopReportedProcess(4242, 'start-4242')).toBe('failed');
    const stopped = managerWithHost({
      stopReportedProcess: async () => ({ outcome: 'stopped', failureCode: null, failurePass: null, failureReason: null }),
    });
    expect(await stopped.stopReportedProcess(4242, 'start-4242')).toBe('stopped');
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('names how the host request failed: a timeout, a lost host, or anything else, for a reap and for a Stop, once each per launch', async () => {
    // DESKTOP-1X arrived as `host_error`, which could not say which of the three it was.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejections: Error[] = [
      new PtyHostTimeoutError('reapTaggedProcesses'),
      new PtyHostExitedError(),
      // A host error reply is rebuilt as a plain Error. Its text says "timed out", and is still not read.
      new Error('pty host request timed out'),
    ];
    for (const rejection of [...rejections, ...rejections]) {
      const manager = managerWithHost({
        reapTaggedProcesses: async () => { throw rejection; },
        stopReportedProcess: async () => { throw rejection; },
      });
      expect(await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false })).toEqual([]);
      expect(await manager.stopReportedProcess(4242, 'start-4242')).toBe('failed');
    }
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([
      { source: 'task_reap', stage: 'reap', code: 'host_timeout' },
      { source: 'task_reap', stage: 'stop', code: 'host_timeout' },
      { source: 'task_reap', stage: 'reap', code: 'host_exited' },
      { source: 'task_reap', stage: 'stop', code: 'host_exited' },
      { source: 'task_reap', stage: 'reap', code: 'host_error' },
      { source: 'task_reap', stage: 'stop', code: 'host_error' },
    ]);
    expect(reportHandledError.mock.calls.map((call) => (call[0] as Error).message)).toEqual([
      'Task leftover reap failed: host_timeout',
      'Task leftover stop failed: host_timeout',
      'Task leftover reap failed: host_exited',
      'Task leftover stop failed: host_exited',
      'Task leftover reap failed: host_error',
      'Task leftover stop failed: host_error',
    ]);
    warn.mockRestore();
  });

  it('hands the caller the answer of a reap it stopped waiting for, reported and logged as an answer in time would be', async () => {
    // A timeout does not cancel the host's reap. Its kills used to land with no
    // report and no toast.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let deliverLate: ((result: TaggedReapResult) => void) | undefined;
    const manager = managerWithHost({
      reapTaggedProcesses: async (_request, _timeoutMs, onLateResult) => {
        deliverLate = onLateResult;
        throw new PtyHostTimeoutError('reapTaggedProcesses');
      },
    });
    const lateEntries: LeftoverProcessEntry[][] = [];
    const entries = await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], {
      stop: true,
      onLateEntries: (late) => { lateEntries.push(late); },
    });
    expect(entries).toEqual([]);
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([{ source: 'task_reap', stage: 'reap', code: 'host_timeout' }]);
    expect(deliverLate).toBeTypeOf('function');

    const stopped: LeftoverProcessEntry = { taskId: TASK, pid: 4242, startKey: 'start-4242', label: 'node (vite)', outcome: 'stopped', reason: null, place: 'project' };
    deliverLate!({ ...EMPTY_REAP, killedPids: [4242], unreadableCount: 2, entries: [stopped], failureCode: 'connection_list', failureReason: 'GetExtendedTcpTable failed with 87', failurePass: 'last' });

    expect(lateEntries).toEqual([[stopped]]);
    // The count of processes the scan could not read is logged for a late answer too, as for one in time.
    expect(log).toHaveBeenCalledWith('[TASK-REAP] 2 same-user process(es) had an unreadable environment and were not checked');
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([
      { source: 'task_reap', stage: 'reap', code: 'host_timeout' },
      { source: 'task_reap', stage: 'reap', code: 'connection_list', pass: 'last' },
    ]);
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toContain('GetExtendedTcpTable');
    expect(log).toHaveBeenCalledWith('[TASK-REAP] a reap that timed out finished later: killed 1 leftover process(es) for 1 task(s): 4242');

    // An answer with nothing to report reaches no caller.
    deliverLate!(EMPTY_REAP);
    expect(lateEntries).toHaveLength(1);
    warn.mockRestore();
    log.mockRestore();
  });

  it('hands the caller the outcome of a Stop it stopped waiting for, reported as an answer in time would be', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let deliverLate: ((result: StopProcessResult) => void) | undefined;
    const manager = managerWithHost({
      stopReportedProcess: async (_request, _timeoutMs, onLateResult) => {
        deliverLate = onLateResult;
        throw new PtyHostTimeoutError('stopReportedProcess');
      },
    });
    const lateOutcomes: string[] = [];
    expect(await manager.stopReportedProcess(4242, 'start-4242', (outcome) => { lateOutcomes.push(outcome); })).toBe('failed');
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([{ source: 'task_reap', stage: 'stop', code: 'host_timeout' }]);

    deliverLate!({ outcome: 'stopped', failureCode: null, failurePass: null, failureReason: null });
    deliverLate!({ outcome: 'failed', failureCode: 'window_list', failurePass: 'second', failureReason: 'lsappinfo list did not run' });

    expect(lateOutcomes).toEqual(['stopped', 'failed']);
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([
      { source: 'task_reap', stage: 'stop', code: 'host_timeout' },
      { source: 'task_reap', stage: 'stop', code: 'window_list', pass: 'second' },
    ]);
    expect(JSON.stringify(reportHandledError.mock.calls)).not.toContain('lsappinfo');
    warn.mockRestore();
  });

  // The WSL reap runs only on Windows. `process.platform` is faked as win32 and `wsl.exe`
  // is answered by a fake off-main executor, so these run on every OS, CI's Linux included.
  describe('the in-distro WSL reap', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      setOffMainExecutor(null);
    });

    it('reports a WSL reap that failed, which used to be swallowed without a log line', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = managerWithHost({ reapTaggedProcesses: async () => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] }) });
      Object.assign(manager, { getShell: async () => 'wsl -d Ubuntu' });
      setOffMainExecutor(async () => { throw new Error('the pty host is not reachable'); });
      await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
      expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([{ source: 'task_reap', stage: 'reap', code: 'wsl_error' }]);
      expect(warn).toHaveBeenCalledWith('[TASK-REAP] WSL reap failed (non-fatal):', expect.any(Error));
      warn.mockRestore();
    });

    it('hands wsl.exe its bound as the child timeout, 5 s for the running-distro listing and 10 s for the script, with WSL_UTF8 set', async () => {
      const manager = managerWithHost({ reapTaggedProcesses: async () => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] }) });
      Object.assign(manager, { getShell: async () => 'wsl -d Ubuntu' });
      const requests: HostExecRequest[] = [];
      setOffMainExecutor(async (request) => {
        requests.push(request);
        const isRunningListing = request.kind === 'execFile' && request.args.includes('--running');
        return { ok: true, stdout: isRunningListing ? 'Ubuntu\n' : '', stderr: '' };
      });
      await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });

      // With `-d Ubuntu` in the shell there is no `-l -v` lookup: the listing, then the script.
      const wslRequests = requests.filter((request): request is Extract<HostExecRequest, { kind: 'execFile' }> => request.kind === 'execFile' && request.file === 'wsl.exe');
      expect(wslRequests).toHaveLength(2);
      const [listing, script] = wslRequests;
      expect(listing.args).toEqual(['-l', '--running', '-q']);
      expect(listing.options.timeout).toBe(5_000);
      expect(listing.options.env).toMatchObject({ WSL_UTF8: '1' });
      expect(script.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-c']);
      expect(script.options.timeout).toBe(10_000);
      expect(script.options.env).toMatchObject({ WSL_UTF8: '1' });
      expect(script.options.windowsHide).toBe(true);
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  it('asks the host nothing for a task with no usable directory: no scan can find anything to kill', async () => {
    const reapTaggedProcesses = vi.fn(async (): Promise<TaggedReapResult> => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] }));
    const manager = managerWithHost({ reapTaggedProcesses });
    expect(await manager.reapTaskProcesses(null, [{ id: TASK, worktreePath: null }], { stop: true })).toEqual([]);
    expect(await manager.reapTaskProcesses(os.homedir(), [{ id: TASK, worktreePath: null }], { stop: true })).toEqual([]);
    expect(reapTaggedProcesses).not.toHaveBeenCalled();
  });

  it('reports nothing for a reap that worked', async () => {
    const manager = managerWithHost({ reapTaggedProcesses: async () => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] }) });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('SessionManager hands the host the worktree as its real path', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeTemporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(directory);
    return directory;
  }

  /** A manager whose host records each reap request. The project is a usable root, so no task is filtered out. */
  function capturingManager(): { manager: SessionManager; project: string; requests: TaggedReapRequest[] } {
    const requests: TaggedReapRequest[] = [];
    const manager = managerWithHost({
      reapTaggedProcesses: async (request) => {
        requests.push(request);
        return EMPTY_REAP;
      },
    });
    return { manager, project: makeTemporaryDirectory('kng-reap-project-'), requests };
  }

  it('sends the real path of a worktree reached through a link, never the link', async () => {
    const { manager, project, requests } = capturingManager();
    const realWorktree = makeTemporaryDirectory('kng-reap-real-');
    const linkParent = makeTemporaryDirectory('kng-reap-link-');
    const linkedWorktree = path.join(linkParent, 'worktree');
    // A junction needs no privilege on Windows; elsewhere a plain directory link.
    fs.symlinkSync(realWorktree, linkedWorktree, process.platform === 'win32' ? 'junction' : 'dir');
    const realPath = await fs.promises.realpath(realWorktree);
    // Positive control: the link resolves to the real directory and reads differently, so a
    // reap that passed the stored path through would send something else.
    expect(await fs.promises.realpath(linkedWorktree)).toBe(realPath);
    expect(linkedWorktree).not.toBe(realPath);

    await manager.reapTaskProcesses(project, [{ id: TASK, worktreePath: linkedWorktree }], { stop: false });

    expect(requests).toHaveLength(1);
    expect(requests[0].tasks).toHaveLength(1);
    const [sentTask] = requests[0].tasks;
    expect(sentTask.taskId).toBe(TASK);
    expect(sentTask.worktreePath).toBe(realPath);
    expect(sentTask.worktreePath).not.toBe(linkedWorktree);
  });

  it('sends a worktree path that does not resolve as stored, and still reaps', async () => {
    const { manager, project, requests } = capturingManager();
    const missingWorktree = path.join(project, '.kangentic', 'worktrees', 'gone');
    // Positive control: nothing is there, so the real path lookup fails.
    expect(fs.existsSync(missingWorktree)).toBe(false);

    await manager.reapTaskProcesses(project, [{ id: TASK, worktreePath: missingWorktree }], { stop: false });

    expect(requests).toHaveLength(1);
    expect(requests[0].tasks).toHaveLength(1);
    expect(requests[0].tasks[0].worktreePath).toBe(missingWorktree);
  });

  it('sends no worktree for a task that has none', async () => {
    const { manager, project, requests } = capturingManager();

    await manager.reapTaskProcesses(project, [{ id: TASK, worktreePath: null }], { stop: false });

    expect(requests).toHaveLength(1);
    expect(requests[0].tasks[0].worktreePath).toBeNull();
  });
});
