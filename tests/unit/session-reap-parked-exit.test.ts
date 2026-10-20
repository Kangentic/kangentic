/**
 * A task reap waits for a PTY of its task that kill() parked and that has not
 * exited yet (src/main/pty/session-manager.ts, reapTaskProcesses). Until that
 * PTY exits, the pty host holds it and protects it and everything under it, so
 * a Done move made right after a young session was stopped would otherwise
 * leave the agent's children running. The wait is bounded.
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

import { SessionManager } from '../../src/main/pty/session-manager';
import { KILL_GRACE_MS, type DeferredKillRegistry } from '../../src/main/pty/lifecycle/deferred-kill';
import type { PtyHandle } from '../../src/main/pty/host/pty-host-client';
import { AGENT_EXIT_REQUEST_TIMEOUT_MS, type AgentExitWaitResult } from '../../src/main/pty/host/exited-root-wait';
import type { TaggedReapResult } from '../../src/main/pty/process-tag/tagged-reap';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const EMPTY: TaggedReapResult = { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] };

function setup() {
  const manager = new SessionManager();
  const order: string[] = [];
  const reapTaggedProcesses = vi.fn(async () => {
    order.push('host-reap');
    return EMPTY;
  });
  Object.assign((manager as unknown as { host: { reapTaggedProcesses: unknown } }).host, { reapTaggedProcesses });
  const deferredKills = (manager as unknown as { deferredKills: DeferredKillRegistry }).deferredKills;
  const park = (sessionId: string) => deferredKills.schedule({
    sessionId,
    taskId: TASK,
    ptyRef: { pid: 4242, kill: vi.fn(), write: vi.fn() } as unknown as PtyHandle,
    pid: 4242,
  });
  return { manager, order, reapTaggedProcesses, park };
}

const PARKED_GIVE_UP_WARNING = '[TASK-REAP] a parked PTY did not exit';

/** The console.warn calls that carry the give-up warning, whatever else the reap logs. */
function giveUpWarnings(warnSpy: { mock: { calls: unknown[][] } }): unknown[][] {
  return warnSpy.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].includes(PARKED_GIVE_UP_WARNING));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Wall-clock wait that works under fake timers: `setImmediate` and `Date` stay real. */
async function realDelay(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

describe('reapTaskProcesses waits for a parked PTY of its task', () => {
  it('scans only after the parked PTY has exited, and logs no give-up warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { manager, order, park } = setup();
    park('sess-parked');
    const reaping = manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    order.push('exit');
    manager.emit('exit', 'sess-parked', 0, true);
    await reaping;
    expect(order).toEqual(['exit', 'host-reap']);
    expect(giveUpWarnings(warnSpy)).toHaveLength(0);
  });

  it('does not wait when nothing of the task is parked', async () => {
    const { manager, reapTaggedProcesses } = setup();
    const startedAt = Date.now();
    await manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(KILL_GRACE_MS);
  });

  it('gives up at its bound when the exit never arrives, warns once, and reaps anyway', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager, reapTaggedProcesses, park } = setup();
    park('sess-stuck');
    const reaping = manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    // Real time for the directory lookup's real I/O, so a reap that did not
    // wait would have reached the host by now.
    await realDelay(150);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1500 - 1);
    await realDelay(50);
    expect(reapTaggedProcesses).not.toHaveBeenCalled();
    expect(giveUpWarnings(warnSpy)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await reaping;
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
    expect(giveUpWarnings(warnSpy)).toHaveLength(1);
  });
});

describe('reapTaskProcesses waits for the agent a killed shell left running', () => {
  // A PTY's exit is its shell's. The agent the shell started is still in its own
  // exit (SessionEnd hooks, transcript, boot record) when the reap would scan,
  // and tagged and in the task's directory it would be killed as a leftover.
  // So the reap first asks the host to `awaitAgentExit` for its tasks, and the
  // host answers once that agent is gone or its bound runs out.
  //
  // Red-green: dropping the `await` before awaitAgentExitOf in reapTaskProcesses
  // lets the reap reach the host while the gate below is shut (first case);
  // passing `tasks` instead of `validTasks` sends the non-UUID id too; dropping
  // the call, or making it after the host reap, fails the first case; letting
  // the rejection escape awaitAgentExitOf fails the rejection case.

  const OTHER_TASK = 'not-a-task-uuid';

  /** A host `awaitAgentExit` the test answers by hand, so a reap that did not wait for it is visible. */
  function gatedAgentExit(manager: SessionManager) {
    const pendingAnswers: Array<(result: AgentExitWaitResult) => void> = [];
    const awaitAgentExit = vi.fn((_taskIds: string[], _timeoutMs: number) => new Promise<AgentExitWaitResult>((resolve) => { pendingAnswers.push(resolve); }));
    Object.assign((manager as unknown as { host: { awaitAgentExit: unknown } }).host, { awaitAgentExit });
    return {
      awaitAgentExit,
      /** Resolves the host's answer once the reap has asked for it. */
      answer: async (result: AgentExitWaitResult) => {
        await vi.waitFor(() => { expect(pendingAnswers.length).toBeGreaterThan(0); });
        pendingAnswers[pendingAnswers.length - 1](result);
      },
    };
  }

  it('asks the host to wait for the valid tasks\' agents, with the request timeout, and reaps only after it answers', async () => {
    const { manager, reapTaggedProcesses } = setup();
    const gate = gatedAgentExit(manager);

    const reaping = manager.reapTaskProcesses(
      os.tmpdir(),
      [{ id: TASK, worktreePath: null }, { id: OTHER_TASK, worktreePath: null }],
      { stop: true },
    );
    await vi.waitFor(() => { expect(gate.awaitAgentExit).toHaveBeenCalledTimes(1); });
    // A task id that is not a UUID never reaches the ask.
    expect(gate.awaitAgentExit).toHaveBeenCalledWith([TASK], AGENT_EXIT_REQUEST_TIMEOUT_MS);

    // A fixed wait, on purpose: the absence of a host call cannot be polled. A
    // reap that did not wait reaches the host after one directory lookup, a few
    // milliseconds. A slow machine can only make broken wiring pass this check,
    // never make working wiring fail it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reapTaggedProcesses).not.toHaveBeenCalled();

    await gate.answer({ found: ['claude'], stillRunning: [], waitedMs: 120 });
    await reaping;
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
  });

  it('still reaps, and says what was still running, when the host answers that the agent outlived its bound', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { manager, reapTaggedProcesses } = setup();
    const gate = gatedAgentExit(manager);

    const reaping = manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true });
    await gate.answer({ found: ['claude'], stillRunning: ['claude'], waitedMs: 8000 });
    await reaping;

    // What outlived the bound is the reap's, as before.
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].startsWith('[TASK-REAP]') && call[0].includes('claude'))).toBe(true);
  });

  it('still reaps when the host fails to answer, and warns without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { manager, reapTaggedProcesses } = setup();
    const awaitAgentExit = vi.fn(async (_taskIds: string[], _timeoutMs: number): Promise<AgentExitWaitResult> => {
      throw new Error('pty host request timed out');
    });
    Object.assign((manager as unknown as { host: { awaitAgentExit: unknown } }).host, { awaitAgentExit });

    await expect(manager.reapTaskProcesses(os.tmpdir(), [{ id: TASK, worktreePath: null }], { stop: true })).resolves.toEqual([]);

    expect(awaitAgentExit).toHaveBeenCalledTimes(1);
    expect(reapTaggedProcesses).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[TASK-REAP] agent exit wait failed'), 'pty host request timed out');
  });

  it('asks the host nothing when none of the task ids is a UUID', async () => {
    const { manager, reapTaggedProcesses } = setup();
    const gate = gatedAgentExit(manager);

    expect(await manager.reapTaskProcesses(os.tmpdir(), [{ id: OTHER_TASK, worktreePath: null }], { stop: true })).toEqual([]);

    expect(gate.awaitAgentExit).not.toHaveBeenCalled();
    expect(reapTaggedProcesses).not.toHaveBeenCalled();
  });
});
