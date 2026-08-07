/**
 * Unit tests for src/main/transition-engine/terminal-submit-scheduler.ts.
 *
 * `TerminalSubmitScheduler` adds task-keyed lifecycle on top of
 * `TerminalSubmit.submitKeystrokes`. Its responsibilities:
 *
 *   1. Existing session, immediate mode: deliver now. If a burst is in flight,
 *      the new request QUEUES behind it - nothing is dropped.
 *   2. Existing session, deferred mode: hold until the agent's current turn
 *      genuinely completes, then deliver.
 *   3. Freshly spawned / queued: wait for the CLI's first `'thinking'` event,
 *      with a 30s fallback and a hard timeout.
 *   4. Cancel: tears down listeners and timers AND aborts an in-flight burst.
 *   5. Report a definite outcome for every scheduled burst, escalating a
 *      confirmed failure to a restart-with-prompt.
 *
 * The byte-pushing path (write order, prompt-state policy, verification) is
 * tested in `terminal-submit.test.ts`. These tests focus on scheduling
 * decisions, lifecycle, and reporting.
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

/** Build a plain unverifiable command, the common case in these tests. */
function plain(text: string): InjectionCommand {
  return { text, verify: 'none' };
}

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

  emitActivity(id: string, state: ActivityState): void {
    this.activity[id] = state;
    this.emit('activity', id, state);
  }

  emitSessionChanged(id: string, session: { status: string }): void {
    this.emit('session-changed', id, session);
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }

  emitOutput(id: string): void {
    this.emit('data-tap', id, 'x');
  }
}

class MockTerminalSubmit {
  /** Each call captures the args and a controllable resolve / abort hook. */
  calls: Array<{
    sessionId: string;
    commands: readonly (string | InjectionCommand)[];
    opts: SubmitKeystrokesOptions;
    resolve: (result: SubmitKeystrokesResult) => void;
    aborted: boolean;
    /** Tracked so `finishLatest` advances instead of re-resolving call 0. */
    settled: boolean;
  }> = [];

  /** Result handed to the next resolved call. */
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
      const call = { sessionId, commands, opts, resolve, aborted: false, settled: false };
      this.calls.push(call);
      if (opts.signal) {
        if (opts.signal.aborted) {
          call.aborted = true;
          call.settled = true;
          resolve({ ...this.nextResult, outcome: 'aborted' });
          return;
        }
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          call.settled = true;
          resolve({ ...this.nextResult, outcome: 'aborted' });
        });
      }
    });
  }

  /** Resolve the oldest still-pending call - simulates a delivery finishing. */
  finishLatest(result?: Partial<SubmitKeystrokesResult>): void {
    const pending = this.calls.find((call) => !call.settled);
    if (!pending) return;
    pending.settled = true;
    pending.resolve({ ...this.nextResult, ...result });
  }

  /** Text of the commands a call received, for readable assertions. */
  static texts(call: { commands: readonly (string | InjectionCommand)[] }): string[] {
    return call.commands.map((entry) => (typeof entry === 'string' ? entry : entry.text));
  }

  submitContent = vi.fn();
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalSubmitScheduler', () => {
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

  describe('existing session (immediate delivery)', () => {
    it('delivers a single command immediately', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].sessionId).toBe('s1');
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/test']);
    });

    it('delivers a chained sequence in one call', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/model opus'), plain('/effort high')]);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/model opus', '/effort high']);
    });

    it('forwards the verifier and the session draft', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.drafts.set('s1', 'instead can we');
      const verifier = vi.fn();

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort high', verify: 'command-match' },
        { text: '/code-review', verify: 'submitted' },
      ], { verifier });
      await tick();

      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(terminalSubmit.calls[0].opts.pendingDraft).toBe('instead can we');
    });

    it('flags an interrupted turn when the agent is thinking', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();

      expect(terminalSubmit.calls[0].opts.interruptingTurn).toBe(true);
    });
  });

  describe('drag-burst queueing', () => {
    it('queues a follow-up while a burst is in flight, then drains it', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1); // not started yet

      terminalSubmit.finishLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(2);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[1])).toEqual(['/second']);
    });

    it('delivers EVERY burst of a drag-through, dropping none', async () => {
      // Regression: the scheduler used to keep a single overwritable `next`
      // slot, so dragging a task through two auto_command columns in quick
      // succession silently discarded the middle command with no record
      // anywhere. A queue is the whole point.
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/third')]);
      await tick();

      terminalSubmit.finishLatest();
      await tick();
      terminalSubmit.finishLatest();
      await tick();
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.map((call) => MockTerminalSubmit.texts(call)[0])).toEqual([
        '/first',
        '/second',
        '/third',
      ]);
    });

    it('delivers a queued burst against ITS OWN session id', async () => {
      // The old stash dropped sessionId and the drain recursed with the
      // original closure's id, which would misdeliver to a dead session the
      // moment a respawn stopped taking the fresh-spawn branch.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.registry.set('s2', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's2', [plain('/second')]);
      await tick();

      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls[1].sessionId).toBe('s2');
    });
  });

  describe('freshlySpawned: wait for thinking event', () => {
    it('does not deliver until activity:thinking fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('30s fallback delivers anyway when thinking never fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      vi.advanceTimersByTime(30_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBe(true);
    });

    it('hard timeout cancels and reports a failure when the CLI never starts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        freshlySpawned: true,
        timeoutMs: 1000,
        onOutcome: (report) => reports.push(report),
      });
      await tick();

      vi.advanceTimersByTime(1500);
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
      // The old code cancelled with only a console.warn, so the user saw a task
      // that had quietly not run its command.
      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('failed');
      expect(reports[0].reason).toContain('never became ready');
    });

    it('forwards freshlySpawned so the byte layer can skip the clear', async () => {
      // Regression: the scheduler used to hardcode a leading Ctrl+C, which on a
      // freshly-spawned Claude Code session landed mid-render of the initial
      // prompt turn and glued the next keystrokes onto it. The clear decision
      // now lives in submitKeystrokes; the scheduler only reports the context.
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBe(true);
    });
  });

  describe('queued session: wait for running then thinking', () => {
    it('ignores activity:thinking before status:running', async () => {
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitSessionChanged('s1', { status: 'running' });
      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });
  });

  describe('deferred mode', () => {
    it('holds delivery while the agent is thinking', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();
      vi.advanceTimersByTime(10_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('delivers once the turn completes and the PTY goes quiet', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();

      sessionManager.emitActivity('s1', 'idle');
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('does NOT deliver while output keeps arriving, even though activity says idle', async () => {
      // The sustained false-idle cases: an API retry backoff and a `Monitor`
      // wait both read as idle for minutes while the CLI keeps painting. A
      // stability window alone expires inside both; requiring PTY silence as a
      // second, independent signal is what actually holds delivery.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();

      for (let index = 0; index < 10; index++) {
        vi.advanceTimersByTime(500);
        sessionManager.emitOutput('s1');
        await tick();
      }

      expect(terminalSubmit.calls).toHaveLength(0);

      // Once the repainting stops, delivery proceeds.
      vi.advanceTimersByTime(1600);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('never delivers into a pending permission prompt', async () => {
      // Injecting here would answer the prompt with the command text.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'permission';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();
      vi.advanceTimersByTime(10_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });

  describe('outcome reporting and escalation', () => {
    it('reports a confirmed delivery', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'confirmed' });
      await tick();

      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('confirmed');
      expect(reports[0].escalated).toBe(false);
    });

    it('escalates a failed delivery once the turn is complete', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const reports: InjectionReport[] = [];
      const escalate = vi.fn(async () => true);

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
      // NOT 'confirmed': the restart was issued, but no verifier saw the
      // command land. Claiming confirmation here would be the same silent
      // success this rebuild exists to remove.
      expect(reports[0].outcome).not.toBe('confirmed');
    });

    it('escalates ONLY the user auto_command, never the settings prefix', async () => {
      // A settings write joined into an argv prompt stops being a slash
      // invocation and becomes literal text the agent reads as message content.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const escalate = vi.fn(async () => true);

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort xhigh', verify: 'command-match' },
        { text: '/code-review', verify: 'submitted' },
      ], { escalate });
      await tick();
      terminalSubmit.finishLatest({
        outcome: 'failed',
        unconfirmedCommands: ['/effort xhigh', '/code-review'],
      });
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(escalate).toHaveBeenCalledWith(['/code-review']);
    });

    it('does not restart the session for a failed settings write alone', async () => {
      // `--resume` preserves already-applied settings and a model change has its
      // own restart path, so respawning here would be churn for nothing.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const escalate = vi.fn(async () => true);
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort xhigh', verify: 'command-match' },
      ], { escalate, onOutcome: (report) => reports.push(report) });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/effort xhigh'] });
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(escalate).not.toHaveBeenCalled();
      expect(reports[0].outcome).toBe('failed');
    });

    it('reports failed without escalating when no handler is supplied', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
      await tick();

      expect(reports[0].outcome).toBe('failed');
      expect(reports[0].escalated).toBe(false);
    });

    it('reports a failure when the session is gone', () => {
      const reports: InjectionReport[] = [];
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        onOutcome: (report) => reports.push(report),
      });

      expect(terminalSubmit.calls).toHaveLength(0);
      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('failed');
    });
  });

  describe('cancel', () => {
    it('aborts in-flight delivery via AbortController', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();
      expect(terminalSubmit.calls[0].aborted).toBe(false);

      scheduler.cancel('task-1');
      await tick();

      expect(terminalSubmit.calls[0].aborted).toBe(true);
    });

    it('drops queued follow-up sequences', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      await tick();

      scheduler.cancel('task-1');
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.some((call) => MockTerminalSubmit.texts(call).includes('/second'))).toBe(false);
    });

    it('removes deferred listeners (freshlySpawned was waiting)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      scheduler.cancel('task-1');
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('exit event during deferred wait cancels the injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      sessionManager.emitExit('s1');
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });

  describe('cancelAll', () => {
    it('aborts every pending and in-flight injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.registry.set('s2', { status: 'running' });

      scheduler.scheduleKeystrokes('task-a', 's1', [plain('/a')]);
      scheduler.scheduleKeystrokes('task-b', 's2', [plain('/b')], { freshlySpawned: true });
      await tick();

      scheduler.cancelAll();
      sessionManager.emitActivity('s1', 'thinking');
      sessionManager.emitActivity('s2', 'thinking');
      await tick();

      expect(terminalSubmit.calls.find((call) => MockTerminalSubmit.texts(call).includes('/a'))?.aborted).toBe(true);
      expect(terminalSubmit.calls.some((call) => MockTerminalSubmit.texts(call).includes('/b'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('skips when commands array is empty', () => {
      sessionManager.registry.set('s1', { status: 'running' });
      scheduler.scheduleKeystrokes('task-1', 's1', []);
      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });
});
