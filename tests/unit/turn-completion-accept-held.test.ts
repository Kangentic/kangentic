/**
 * `waitForTurnCompletion` with `acceptHeld` (src/main/transition-engine/turn-completion.ts):
 * a session still `thinking` only because background work its ended turn left
 * holds it counts as complete once quiet, for a caller that asked. Any other
 * caller keeps waiting for idle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForTurnCompletion } from '../../src/main/transition-engine/turn-completion';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ActivityState } from '../../src/shared/types';

const SESSION_ID = 'session-held-1';
const QUIET_MS = 1000;
const TIMEOUT_MS = 30_000;

class FakeSessionManager extends EventEmitter {
  activity: Record<string, ActivityState> = {};
  held = false;

  getActivityCache(): Record<string, ActivityState> {
    return this.activity;
  }

  isTurnHeldByBackgroundWork(): boolean {
    return this.held;
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

describe('waitForTurnCompletion acceptHeld', () => {
  let sessionManager: FakeSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
    sessionManager.activity[SESSION_ID] = 'thinking';
    sessionManager.held = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  function wait(options: { acceptHeld?: boolean } = {}): Promise<string> {
    return waitForTurnCompletion(sessionManager as unknown as SessionManager, SESSION_ID, {
      quietMs: QUIET_MS,
      timeoutMs: TIMEOUT_MS,
      ...options,
    });
  }

  it('completes a held thinking turn once quiet when acceptHeld is true', async () => {
    const promise = wait({ acceptHeld: true });
    vi.advanceTimersByTime(QUIET_MS + 100);
    await flush();
    await expect(promise).resolves.toBe('completed');
  });

  it('does not complete a held thinking turn without acceptHeld, and times out', async () => {
    let result: string | null = null;
    const promise = wait().then((value) => {
      result = value;
      return value;
    });
    vi.advanceTimersByTime(TIMEOUT_MS - 1000);
    await flush();
    expect(result).toBeNull();
    vi.advanceTimersByTime(2000);
    await flush();
    await expect(promise).resolves.toBe('timeout');
  });

  it('does not complete when acceptHeld is true but the turn is not held', async () => {
    sessionManager.held = false;
    const promise = wait({ acceptHeld: true });
    vi.advanceTimersByTime(TIMEOUT_MS + 1000);
    await flush();
    await expect(promise).resolves.toBe('timeout');
  });

  it('still waits for output silence before a held turn completes', async () => {
    let result: string | null = null;
    const promise = wait({ acceptHeld: true }).then((value) => {
      result = value;
      return value;
    });
    vi.advanceTimersByTime(600);
    sessionManager.emit('output-seen', SESSION_ID);
    vi.advanceTimersByTime(600);
    await flush();
    expect(result).toBeNull();
    vi.advanceTimersByTime(600);
    await flush();
    await expect(promise).resolves.toBe('completed');
  });
});
