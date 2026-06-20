/**
 * Unit tests for src/main/transition-engine/terminal-submit-scheduler.ts.
 *
 * `TerminalSubmitScheduler` adds task-keyed lifecycle on top of
 * `TerminalSubmit.submitKeystrokes`. The scheduler's responsibilities:
 *
 *   1. Existing session: deliver immediately. If a burst is in flight,
 *      stash the new request as `next` so rapid drag-through transitions
 *      coalesce (only the latest survives).
 *   2. Freshly spawned (`opts.freshlySpawned: true`): wait for the CLI's
 *      first `'thinking'` activity event. 30s fallback delivers anyway
 *      if hooks never fire. `opts.timeoutMs` (default 120s) hard-caps.
 *   3. Queued: wait for `status:running`, then apply the `'thinking'` wait.
 *   4. Cancel: tears down event listeners + timers AND aborts an in-flight
 *      burst via the per-task `AbortController` plumbed through.
 *
 * The byte-pushing path (write order, sanitize, verifier polling) is
 * tested in `terminal-submit.test.ts`. These tests focus on scheduling
 * decisions and lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { TerminalSubmit } from '../../src/main/pty/terminal-submit';
import type { SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';

class MockSessionManager extends EventEmitter {
  registry = new Map<string, { status: string }>();

  getSession(id: string): { status: string } | undefined {
    return this.registry.get(id);
  }

  emitActivity(id: string, state: string): void {
    this.emit('activity', id, state);
  }

  emitSessionChanged(id: string, session: { status: string }): void {
    this.emit('session-changed', id, session);
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }
}

class MockTerminalSubmit {
  /** Each call captures the args and a controllable resolve / abort hook. */
  calls: Array<{
    sessionId: string;
    commands: string[];
    opts: SubmitKeystrokesOptions;
    resolve: () => void;
    aborted: boolean;
  }> = [];

  submitKeystrokes(
    sessionId: string,
    commands: string[],
    opts: SubmitKeystrokesOptions,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const call = { sessionId, commands, opts, resolve, aborted: false };
      this.calls.push(call);
      if (opts.signal) {
        if (opts.signal.aborted) {
          call.aborted = true;
          resolve();
          return;
        }
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          resolve();
        });
      }
    });
  }

  /** Resolve the most recent unresolved call - simulates a delivery finishing. */
  finishLatest(): void {
    const pending = this.calls.find((c) => !c.aborted);
    if (pending) pending.resolve();
  }

  // Stub other PasteEngine methods we don't exercise here.
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

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].sessionId).toBe('s1');
      expect(terminalSubmit.calls[0].commands).toEqual(['/test']);
    });

    it('delivers a chained sequence in one call', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus', '/effort high']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].commands).toEqual(['/model opus', '/effort high']);
    });

    it('forwards verifier and verifiedPrefixLength', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const verifier = vi.fn();

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus', 'auto'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      await tick();

      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(terminalSubmit.calls[0].opts.verifiedPrefixLength).toBe(1);
    });
  });

  describe('drag-burst coalescing', () => {
    it('queues a follow-up while a burst is in flight, then drains it', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);

      // Second schedule while first is still in flight - stashed as next.
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1); // not started yet

      // Resolve the first - the second drains automatically.
      terminalSubmit.finishLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(2);
      expect(terminalSubmit.calls[1].commands).toEqual(['/second']);
    });

    it('overwrites prior queued sequence with the latest (drag-through)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      // Two more arrive while first is in flight - only the latest survives.
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second-discarded']);
      scheduler.scheduleKeystrokes('task-1', 's1', ['/third']);
      await tick();

      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls).toHaveLength(2);
      expect(terminalSubmit.calls[1].commands).toEqual(['/third']);
    });
  });

  describe('freshlySpawned: wait for thinking event', () => {
    it('does not deliver until activity:thinking fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('30s fallback delivers anyway when thinking never fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();

      vi.advanceTimersByTime(30_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      // Fallback delivery must also honor freshlySpawned -> sendCtrlC=false.
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(false);
    });

    it('hard timeout (default 120s) cancels when CLI never starts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], {
        freshlySpawned: true,
        timeoutMs: 1000, // shorter for the test
      });
      await tick();

      vi.advanceTimersByTime(1500);
      await tick();
      // Even if thinking now arrives, the cancel already happened.
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    // Regression: when the scheduler hardcoded `sendCtrlC: true`, the leading
    // Ctrl+C on a freshly-spawned Claude Code session landed mid-render of the
    // initial CLI-arg prompt turn. The follow-up keystrokes then concatenated
    // onto the prompt as one user message (`<task>...</task>/test` glued
    // together). The fix derives sendCtrlC from `freshlySpawned` so the
    // documented `submitKeystrokes` contract is honored.
    it('passes sendCtrlC=false to submitKeystrokes for freshly-spawned bursts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(false);
    });

    it('keeps sendCtrlC=true for live-injection bursts (no freshlySpawned)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(true);
    });
  });

  describe('queued session: wait for running then thinking', () => {
    it('ignores activity:thinking before status:running', async () => {
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
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

  describe('cancel', () => {
    it('aborts in-flight delivery via AbortController', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].aborted).toBe(false);

      scheduler.cancel('task-1');
      await tick();

      expect(terminalSubmit.calls[0].aborted).toBe(true);
    });

    it('drops queued follow-up sequence', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second']);
      await tick();

      scheduler.cancel('task-1');
      // Resolve the first delivery - the queued second should NOT run.
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.filter((c) => !c.aborted)).toHaveLength(0);
      expect(terminalSubmit.calls.some((c) => c.commands.includes('/second'))).toBe(false);
    });

    it('removes deferred listeners (freshlySpawned was waiting)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      scheduler.cancel('task-1');
      // Even after thinking event, nothing is delivered.
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('exit event during deferred wait cancels the injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
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

      scheduler.scheduleKeystrokes('task-a', 's1', ['/a']);
      scheduler.scheduleKeystrokes('task-b', 's2', ['/b'], { freshlySpawned: true });
      await tick();

      scheduler.cancelAll();
      sessionManager.emitActivity('s1', 'thinking');
      sessionManager.emitActivity('s2', 'thinking');
      await tick();

      // task-a was delivered then aborted; task-b never delivered.
      expect(terminalSubmit.calls.find((c) => c.commands.includes('/a'))?.aborted).toBe(true);
      expect(terminalSubmit.calls.some((c) => c.commands.includes('/b'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('skips when session does not exist', () => {
      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('skips when commands array is empty', () => {
      sessionManager.registry.set('s1', { status: 'running' });
      scheduler.scheduleKeystrokes('task-1', 's1', []);
      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });
});
