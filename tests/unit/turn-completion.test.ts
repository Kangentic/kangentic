/**
 * Unit tests for src/main/transition-engine/turn-completion.ts.
 *
 * This is the single predicate behind both deferred auto_command delivery and
 * escalation, so getting it wrong either fires a command into the middle of a
 * live turn or kills a session that was still working.
 *
 * The cases that matter are the SUSTAINED false idles already catalogued on the
 * board: an API 529 retry backoff and a `Monitor` wait both report idle for
 * minutes while the CLI keeps painting. A stability window expires inside both,
 * which is why the predicate requires PTY silence as a second, independent
 * signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForTurnCompletion } from '../../src/main/transition-engine/turn-completion';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ActivityState } from '../../src/shared/types';

const SESSION = 'sess-1';

class MockSessionManager extends EventEmitter {
  activity: Record<string, ActivityState> = {};

  getActivityCache(): Record<string, ActivityState> {
    return this.activity;
  }

  setActivity(sessionId: string, state: ActivityState): void {
    this.activity[sessionId] = state;
    this.emit('activity', sessionId, state);
  }

  emitOutput(sessionId: string): void {
    this.emit('data-tap', sessionId, 'bytes');
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('waitForTurnCompletion', () => {
  let sessionManager: MockSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  function wait(options = {}): Promise<string> {
    return waitForTurnCompletion(sessionManager as unknown as SessionManager, SESSION, {
      quietMs: 1000,
      timeoutMs: 30_000,
      ...options,
    });
  }

  it('completes when the session is already idle and quiet', async () => {
    sessionManager.activity[SESSION] = 'idle';
    const promise = wait();

    vi.advanceTimersByTime(1100);
    await tick();

    await expect(promise).resolves.toBe('completed');
  });

  it('does not complete while the agent is thinking', async () => {
    sessionManager.activity[SESSION] = 'thinking';
    let settled = false;
    const promise = wait().then((result) => {
      settled = true;
      return result;
    });

    vi.advanceTimersByTime(10_000);
    await tick();
    expect(settled).toBe(false);

    sessionManager.setActivity(SESSION, 'idle');
    vi.advanceTimersByTime(1100);
    await tick();
    await expect(promise).resolves.toBe('completed');
  });

  it('does not complete while output keeps arriving, even though activity says idle', async () => {
    // The 529-backoff and Monitor-wait shape: idle for minutes, but the CLI is
    // still repainting a spinner or a retry footer. Output PRESENT holds
    // delivery; output absent is never taken as proof of anything on its own.
    sessionManager.activity[SESSION] = 'idle';
    let settled = false;
    const promise = wait().then((result) => {
      settled = true;
      return result;
    });

    for (let index = 0; index < 20; index++) {
      vi.advanceTimersByTime(400);
      sessionManager.emitOutput(SESSION);
      await tick();
    }
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1100);
    await tick();
    await expect(promise).resolves.toBe('completed');
  });

  it('never completes on a pending permission prompt', async () => {
    // Injecting here would answer the prompt with the command text.
    sessionManager.activity[SESSION] = 'permission';
    let settled = false;
    const promise = wait({ timeoutMs: 5000 }).then((result) => {
      settled = true;
      return result;
    });

    vi.advanceTimersByTime(3000);
    await tick();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(3000);
    await tick();
    await expect(promise).resolves.toBe('timeout');
  });

  it('reports exited when the session dies', async () => {
    sessionManager.activity[SESSION] = 'thinking';
    const promise = wait();

    sessionManager.emit('exit', SESSION);
    await tick();

    await expect(promise).resolves.toBe('exited');
  });

  it('reports timeout when the turn never ends', async () => {
    sessionManager.activity[SESSION] = 'thinking';
    const promise = wait({ timeoutMs: 2000 });

    vi.advanceTimersByTime(2500);
    await tick();

    await expect(promise).resolves.toBe('timeout');
  });

  it('ignores other sessions', async () => {
    sessionManager.activity[SESSION] = 'idle';
    const promise = wait();

    // Another session repainting must not hold this one back.
    for (let index = 0; index < 5; index++) {
      vi.advanceTimersByTime(300);
      sessionManager.emitOutput('other-session');
      await tick();
    }
    vi.advanceTimersByTime(1100);
    await tick();

    await expect(promise).resolves.toBe('completed');
  });

  it('resolves aborted when the caller cancels', async () => {
    sessionManager.activity[SESSION] = 'thinking';
    const controller = new AbortController();
    const promise = wait({ signal: controller.signal });

    controller.abort();
    await tick();

    await expect(promise).resolves.toBe('aborted');
  });

  it('survives a throwing activity listener without unwinding into the engine', async () => {
    // A throw here would unwind back through the engine's commitTransition and
    // leave its stale-thinking watchdog unarmed.
    sessionManager.activity[SESSION] = 'thinking';
    const promise = wait();
    sessionManager.on('activity', () => {
      throw new Error('unrelated listener blew up');
    });

    expect(() => sessionManager.setActivity(SESSION, 'idle')).toThrow();
    vi.advanceTimersByTime(1100);
    await tick();

    await expect(promise).resolves.toBe('completed');
  });
});
