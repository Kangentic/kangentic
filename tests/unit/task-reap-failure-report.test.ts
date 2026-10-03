/**
 * A task leftover reap that fails tells Sentry once per stage and code per launch
 * (src/main/pty/task-reap-failure-report.ts), with a fixed message and code and
 * never the failure's own text, and SessionManager reports every way a reap
 * or a Stop can fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';

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
import type { TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';

beforeEach(() => {
  reportHandledError.mockClear();
  resetTaskReapFailureReports();
});

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

  it('drops the text of any other failure: it can come from a process scan', () => {
    reportTaskReapFailure('reap', 'reap_error', 'API_TOKEN=secret in a parse error');
    const call = JSON.stringify(reportHandledError.mock.calls[0]);
    expect(call).not.toContain('secret');
  });
});

describe('SessionManager reports a failed reap and a failed Stop', () => {
  type HostStub = {
    reapTaggedProcesses: (request: unknown, timeoutMs: number) => Promise<TaggedReapResult>;
    stopReportedProcess: (request: unknown, timeoutMs: number) => Promise<string>;
  };

  function managerWithHost(host: Partial<HostStub>): SessionManager {
    const manager = new SessionManager();
    Object.assign((manager as unknown as { host: HostStub }).host, host);
    return manager;
  }

  const failed = (failureCode: TaggedReapResult['failureCode'], failureReason: string): TaggedReapResult => ({
    killedPids: [], unreadableCount: 0, failureReason, failureCode, entries: [],
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

  it.runIf(process.platform === 'win32')('reports a WSL reap that failed, which used to be swallowed without a log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = managerWithHost({ reapTaggedProcesses: async () => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] }) });
    Object.assign(manager, { getShell: async () => 'wsl -d Ubuntu' });
    setOffMainExecutor(async () => { throw new Error('the pty host is not reachable'); });
    try {
      await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    } finally {
      setOffMainExecutor(null);
    }
    expect(reportHandledError.mock.calls.map((call) => call[1])).toEqual([{ source: 'task_reap', stage: 'reap', code: 'wsl_error' }]);
    expect(warn).toHaveBeenCalledWith('[TASK-REAP] WSL reap failed (non-fatal):', expect.any(Error));
    warn.mockRestore();
  });

  it('asks the host nothing for a task with no usable directory: no scan can find anything to kill', async () => {
    const reapTaggedProcesses = vi.fn(async (): Promise<TaggedReapResult> => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] }));
    const manager = managerWithHost({ reapTaggedProcesses });
    expect(await manager.reapTaskProcesses(null, [{ id: TASK, worktreePath: null }], { stop: true })).toEqual([]);
    expect(await manager.reapTaskProcesses(os.homedir(), [{ id: TASK, worktreePath: null }], { stop: true })).toEqual([]);
    expect(reapTaggedProcesses).not.toHaveBeenCalled();
  });

  it('reports nothing for a reap that worked', async () => {
    const manager = managerWithHost({ reapTaggedProcesses: async () => ({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, entries: [] }) });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: false });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
