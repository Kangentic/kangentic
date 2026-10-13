/**
 * What SessionManager does with the pty host's answers about leftover processes
 * (src/main/pty/session-manager.ts):
 *
 * - `checkReportedProcesses`, the leftover list's recheck: one answer per
 *   identity asked, `null` wherever the host could not tell, and never a throw.
 * - `listProcesses`, the host's process table: `[]` when the host cannot answer.
 * - The reap's per-entry log line: every process a reap left running or could
 *   not stop is logged from the report alone, so a kept process can be
 *   explained from the log, and a stopped one is not logged.
 *
 * The host is a stub assigned over the manager's own, as the other reap tests do.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (message: string) => message }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { HostProcessInfo } from '../../src/main/pty/host/protocol';
import type { LeftoverProcessEntry, TaggedReapRequest, TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY_REAP: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };

type Identity = { pid: number; startKey: string };

interface HostStub {
  checkReportedProcesses: (identities: Identity[], timeoutMs: number) => Promise<Array<boolean | null>>;
  listProcesses: () => Promise<HostProcessInfo[]>;
  reapTaggedProcesses: (request: TaggedReapRequest, timeoutMs: number, onLateResult?: (result: TaggedReapResult) => void) => Promise<TaggedReapResult>;
}

function managerWithHost(host: Partial<HostStub>): SessionManager {
  const manager = new SessionManager();
  Object.assign((manager as unknown as { host: HostStub }).host, host);
  return manager;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionManager.checkReportedProcesses', () => {
  const identities: Identity[] = [
    { pid: 5000, startKey: 'start-5000' },
    { pid: 5001, startKey: 'start-5001' },
    { pid: 5002, startKey: 'start-5002' },
  ];

  it('answers [] for no identities, without asking the host', async () => {
    const checkReportedProcesses = vi.fn(async (): Promise<Array<boolean | null>> => []);
    const manager = managerWithHost({ checkReportedProcesses });

    expect(await manager.checkReportedProcesses([])).toEqual([]);
    expect(checkReportedProcesses).not.toHaveBeenCalled();
  });

  it('hands the host the identities as given and gives back its answers in order', async () => {
    const checkReportedProcesses = vi.fn(async (): Promise<Array<boolean | null>> => [true, false, null]);
    const manager = managerWithHost({ checkReportedProcesses });

    expect(await manager.checkReportedProcesses(identities)).toEqual([true, false, null]);
    expect(checkReportedProcesses).toHaveBeenCalledTimes(1);
    expect(checkReportedProcesses.mock.calls[0]).toEqual([identities, expect.any(Number)]);
  });

  it('gives the host 5 s to answer', async () => {
    // The literal is the point: the budget is not imported, so a change to it must change this test.
    const budgets: number[] = [];
    const manager = managerWithHost({
      checkReportedProcesses: async (_identities, timeoutMs) => {
        budgets.push(timeoutMs);
        return [false, false, false];
      },
    });

    await manager.checkReportedProcesses(identities);

    expect(budgets).toEqual([5_000]);
  });

  it('answers null for every identity when the host rejects, and does not throw', async () => {
    const manager = managerWithHost({
      checkReportedProcesses: async () => { throw new Error('pty host request timed out'); },
    });

    expect(await manager.checkReportedProcesses(identities)).toEqual([null, null, null]);
  });

  it('pads an answer shorter than the question with null, keeping a false it did give', async () => {
    // `false` is the answer that changes a row, so it must survive as `false`, not read as missing.
    const manager = managerWithHost({ checkReportedProcesses: async () => [false] });

    expect(await manager.checkReportedProcesses(identities)).toEqual([false, null, null]);
  });
});

describe('SessionManager.listProcesses', () => {
  it('gives back the host\'s process table', async () => {
    const table: HostProcessInfo[] = [{ pid: 1, ppid: 0, comm: 'init' }, { pid: 4242, ppid: 1, comm: 'node' }];
    const manager = managerWithHost({ listProcesses: async () => table });

    expect(await manager.listProcesses()).toEqual(table);
  });

  it('answers [] when the host rejects, and does not throw', async () => {
    const manager = managerWithHost({ listProcesses: async () => { throw new Error('the pty host is not reachable'); } });

    expect(await manager.listProcesses()).toEqual([]);
  });
});

describe('the reap\'s per-entry log lines', () => {
  const entry = (overrides: Partial<LeftoverProcessEntry>): LeftoverProcessEntry => ({
    taskId: TASK,
    pid: 5000,
    startKey: 'start-5000',
    label: 'node (vite)',
    outcome: 'kept',
    reason: null,
    because: null,
    place: 'worktree',
    ...overrides,
  });

  const stoppedEntry = entry({ pid: 5000, outcome: 'stopped' });
  const failedEntry = entry({ pid: 5001, outcome: 'failed' });
  const stoppingOffEntry = entry({ pid: 5002, label: 'chrome', outcome: 'kept', reason: null, place: 'project' });
  const keptWindowEntry = entry({
    pid: 5003,
    label: 'chrome',
    outcome: 'kept',
    reason: 'window',
    because: { basis: 'role', evidencePid: null, evidenceLabel: null },
  });

  /** The `[TASK-REAP]` lines logged so far, whole, in order. */
  function reapLines(logSpy: { mock: { calls: unknown[][] } }): string[] {
    return logSpy.mock.calls
      .map((callArguments) => String(callArguments[0]))
      .filter((line) => line.startsWith('[TASK-REAP]'));
  }

  it('logs one line for each process the reap left running or could not stop, and none for a stopped one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manager = managerWithHost({
      reapTaggedProcesses: async () => ({ ...EMPTY_REAP, entries: [stoppedEntry, failedEntry, stoppingOffEntry, keptWindowEntry] }),
    });

    const entries = await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });

    // Positive control: the reap handed every entry back, the stopped one too, so a missing line is the log's doing.
    expect(entries).toHaveLength(4);
    expect(reapLines(logSpy)).toEqual([
      '[TASK-REAP] could not stop node (vite) (pid 5001) of task 7a1f2c3d in the worktree',
      '[TASK-REAP] left chrome (pid 5002) of task 7a1f2c3d in the project running: stopping is off',
      '[TASK-REAP] kept chrome (pid 5003) of task 7a1f2c3d in the worktree: window',
    ]);
  });

  it('logs nothing for a reap that only stopped processes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manager = managerWithHost({
      reapTaggedProcesses: async () => ({ ...EMPTY_REAP, entries: [stoppedEntry] }),
    });

    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });

    expect(reapLines(logSpy)).toEqual([]);
  });

  it('logs the same lines for the entries of a reap that answered after main stopped waiting', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let deliverLate: ((result: TaggedReapResult) => void) | undefined;
    const manager = managerWithHost({
      reapTaggedProcesses: async (_request, _timeoutMs, onLateResult) => {
        deliverLate = onLateResult;
        throw new Error('pty host request timed out');
      },
    });
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    expect(reapLines(logSpy)).toEqual([]);

    deliverLate!({ ...EMPTY_REAP, entries: [stoppedEntry, failedEntry, keptWindowEntry] });

    expect(reapLines(logSpy)).toEqual([
      '[TASK-REAP] could not stop node (vite) (pid 5001) of task 7a1f2c3d in the worktree',
      '[TASK-REAP] kept chrome (pid 5003) of task 7a1f2c3d in the worktree: window',
    ]);
  });
});
