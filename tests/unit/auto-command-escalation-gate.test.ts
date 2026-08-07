/**
 * Unit tests for the turn-completion safety gate inside
 * `TerminalSubmitScheduler.escalate()` (src/main/transition-engine/terminal-submit-scheduler.ts).
 *
 * `escalate()` restarts the session and replays the auto_command as the CLI's
 * prompt argument once keystroke delivery has exhausted its retries. Before
 * doing that it waits for `waitForTurnCompletion` and refuses to restart
 * unless the result is `'completed'` - this is what stops a restart from
 * landing mid-turn during a 529 retry backoff or a `Monitor` wait, both of
 * which the activity engine reports as idle for minutes at a time.
 *
 * Every OTHER escalation test (in `tests/unit/terminal-submit-scheduler.test.ts`
 * and `tests/unit/auto-command-escalation.test.ts`) sets activity to `'idle'`
 * before the escalation fires, so `waitForTurnCompletion` always resolves
 * `'completed'` and the `completion !== 'completed'` branch never executes.
 * Deleting the guard entirely passes the whole existing suite. This file
 * exercises the two branches nothing else reaches: `'timeout'` and
 * `'exited'`.
 *
 * New file (not an addition to `terminal-submit-scheduler.test.ts`) because
 * that file is being concurrently edited elsewhere; the harness below is a
 * trimmed copy of the mocks defined there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  TerminalSubmitScheduler,
  type InjectionReport,
} from '../../src/main/transition-engine/terminal-submit-scheduler';
import type {
  InjectionCommand,
  SubmitKeystrokesOptions,
  SubmitKeystrokesResult,
  TerminalSubmit,
} from '../../src/main/pty/terminal-submit';
import type { ActivityState } from '../../src/shared/types';

class MockSessionManager extends EventEmitter {
  registry = new Map<string, { status: string }>();
  activity: Record<string, ActivityState> = {};
  drafts = new Map<string, string>();

  getSession(id: string): { status: string } | undefined {
    return this.registry.get(id);
  }

  getActivityCache(): Record<string, ActivityState> {
    return this.activity;
  }

  getPendingDraft(id: string): string | null {
    return this.drafts.get(id) ?? null;
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }
}

class MockTerminalSubmit {
  calls: Array<{
    sessionId: string;
    commands: readonly (string | InjectionCommand)[];
    opts: SubmitKeystrokesOptions;
    resolve: (result: SubmitKeystrokesResult) => void;
    settled: boolean;
  }> = [];

  nextResult: SubmitKeystrokesResult = {
    outcome: 'unconfirmed',
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
  };

  submitKeystrokes(
    sessionId: string,
    commands: readonly (string | InjectionCommand)[],
    opts: SubmitKeystrokesOptions,
  ): Promise<SubmitKeystrokesResult> {
    return new Promise<SubmitKeystrokesResult>((resolve) => {
      const call = { sessionId, commands, opts, resolve, settled: false };
      this.calls.push(call);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          call.settled = true;
          resolve({ ...this.nextResult, outcome: 'aborted' });
        });
      }
    });
  }

  finishLatest(result?: Partial<SubmitKeystrokesResult>): void {
    const pending = this.calls.find((call) => !call.settled);
    if (!pending) return;
    pending.settled = true;
    pending.resolve({ ...this.nextResult, ...result });
  }

  submitContent = vi.fn();
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalSubmitScheduler.escalate() - turn-completion safety gate', () => {
  let sessionManager: MockSessionManager;
  let terminalSubmit: MockTerminalSubmit;
  let scheduler: TerminalSubmitScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    terminalSubmit = new MockTerminalSubmit();
    scheduler = new TerminalSubmitScheduler(
      sessionManager as never,
      terminalSubmit as unknown as TerminalSubmit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  it('never calls escalate when the turn-completion wait times out', async () => {
    // 'thinking' the whole way through - the turn never completes, so
    // waitForTurnCompletion's own hard timeout (120s default) is what
    // eventually resolves this.
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.activity.s1 = 'thinking';
    const escalate = vi.fn(async () => true);
    const reports: InjectionReport[] = [];

    scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
      escalate,
      onOutcome: (report) => reports.push(report),
    });
    await tick();
    terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
    await tick();

    vi.advanceTimersByTime(120_500);
    await tick();

    expect(escalate).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('failed');
    expect(reports[0].escalated).toBe(false);
    // Discriminate from the 'exited' branch below - both share the "not safe
    // to restart" prefix, so the interpolated completion value is the only
    // thing that proves THIS branch (not the other) actually ran.
    expect(reports[0].reason).toContain('(timeout)');
  });

  it('never calls escalate when the session exits before the turn completes', async () => {
    // Still 'thinking' (never idle) when the session dies mid-wait.
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.activity.s1 = 'thinking';
    const escalate = vi.fn(async () => true);
    const reports: InjectionReport[] = [];

    scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
      escalate,
      onOutcome: (report) => reports.push(report),
    });
    await tick();
    terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
    await tick();

    sessionManager.emitExit('s1');
    await tick();

    expect(escalate).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('failed');
    expect(reports[0].escalated).toBe(false);
    expect(reports[0].reason).toContain('(exited)');
  });

  it('positive control: calls escalate once the turn genuinely completes', async () => {
    // Deliberate mirror of the passing case already covered in
    // terminal-submit-scheduler.test.ts ('escalates a failed delivery once
    // the turn is complete'). Kept here so this file proves the gate can
    // open, not just that it can stay shut - without it, the two tests
    // above could pass vacuously against a scheduler that never calls
    // escalate under any circumstance.
    sessionManager.registry.set('s1', { status: 'running' });
    sessionManager.activity.s1 = 'idle';
    const escalate = vi.fn(async () => true);
    const reports: InjectionReport[] = [];

    scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
      escalate,
      onOutcome: (report) => reports.push(report),
    });
    await tick();
    terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
    await tick();
    // Let the turn-completion quiet window elapse.
    vi.advanceTimersByTime(1600);
    await tick();

    expect(escalate).toHaveBeenCalledWith(['/code-review']);
    expect(reports).toHaveLength(1);
    expect(reports[0].escalated).toBe(true);
  });
});
