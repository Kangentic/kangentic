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
import type { StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import type { HostExecRequest } from '../../src/main/pty/host/protocol';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };
const realPlatform = process.platform;

beforeEach(() => {
  reportHandledError.mockClear();
  resetTaskReapFailureReports();
});

type HostStub = {
  reapTaggedProcesses: (request: TaggedReapRequest, timeoutMs: number) => Promise<TaggedReapResult>;
  stopReportedProcess: (request: unknown, timeoutMs: number) => Promise<StopProcessResult>;
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

  it('reports a host that failed or timed out, for a reap and for a Stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({
      reapTaggedProcesses: async () => { throw new Error('pty host request timed out'); },
      stopReportedProcess: async () => { throw new Error('pty host request timed out'); },
    });
    expect(await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false })).toEqual([]);
    expect(await manager.stopReportedProcess(4242, 'start-4242')).toBe('failed');
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([
      { source: 'task_reap', stage: 'reap', code: 'host_error' },
      { source: 'task_reap', stage: 'stop', code: 'host_error' },
    ]);
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
