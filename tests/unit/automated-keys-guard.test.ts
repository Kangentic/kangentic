/**
 * The automated keystroke guard's waits (src/main/pty/automated-keys-guard.ts,
 * task #952). Automated keys wait while a permission prompt or a tool call is
 * open. A message held behind a long foreground tool call is delivered once
 * the call ends, never dropped: an earlier 10-minute bound reported it "Not
 * sent", where before the guard the CLI took it after the tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SessionManager } from '../../src/main/pty/session-manager';
import {
  AUTOMATED_KEYS_HOLD_LOG_MS,
  automatedKeysRefusal,
  forgetAutomatedKeysSession,
  resetAutomatedKeysGuardForTests,
  waitForAutomatedKeysClearance,
  waitUntilAutomatedKeysClear,
} from '../../src/main/pty/automated-keys-guard';

const SESSION_ID = 'session-guard-1';

class FakeSessionManager extends EventEmitter {
  blocker: string | null = null;
  automatedKeysBlocker(): string | null {
    return this.blocker;
  }
  /** The open call ended, as its hook event says. */
  endCall(): void {
    this.blocker = null;
    this.emit('event', SESSION_ID, { type: 'tool_end' });
  }
}

describe('the automated keys guard', () => {
  let sessionManager: FakeSessionManager;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAutomatedKeysGuardForTests();
    sessionManager = new FakeSessionManager();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const asManager = (): SessionManager => sessionManager as unknown as SessionManager;

  it('logs a refusal once per reason, not once per check', () => {
    sessionManager.blocker = 'the Bash tool call has not ended';
    expect(automatedKeysRefusal(asManager(), SESSION_ID, 'test')).toBe('the Bash tool call has not ended');
    expect(automatedKeysRefusal(asManager(), SESSION_ID, 'test')).toBe('the Bash tool call has not ended');
    expect(log).toHaveBeenCalledTimes(1);
  });

  // SessionManager calls forgetAutomatedKeysSession when a session exits, so a
  // session that reuses the id (a respawn) is told about its refusal again
  // instead of being kept quiet by a line logged for the session that died.
  describe('forgetting a session at its exit', () => {
    const OTHER_SESSION_ID = 'session-guard-2';
    const BLOCKER = 'the Bash tool call has not ended';

    it('logs the next refusal for that session again', () => {
      sessionManager.blocker = BLOCKER;
      automatedKeysRefusal(asManager(), SESSION_ID, 'test');
      automatedKeysRefusal(asManager(), SESSION_ID, 'test');
      expect(log).toHaveBeenCalledTimes(1);

      forgetAutomatedKeysSession(SESSION_ID);
      automatedKeysRefusal(asManager(), SESSION_ID, 'test');

      expect(log).toHaveBeenCalledTimes(2);
      expect(String(log.mock.calls[1][0])).toContain(`holding keys for session ${SESSION_ID.slice(0, 8)}: ${BLOCKER}`);
    });

    it('leaves another session\'s logged refusal suppressed', () => {
      sessionManager.blocker = BLOCKER;
      automatedKeysRefusal(asManager(), SESSION_ID, 'test');
      automatedKeysRefusal(asManager(), OTHER_SESSION_ID, 'test');
      expect(log).toHaveBeenCalledTimes(2);

      forgetAutomatedKeysSession(SESSION_ID);
      automatedKeysRefusal(asManager(), OTHER_SESSION_ID, 'test');

      expect(log).toHaveBeenCalledTimes(2);
    });

  });

  it('holds past the hold-log interval, says so in the log, and clears once the call ends', async () => {
    sessionManager.blocker = 'the Bash tool call has not ended';
    let settled: string | null = null;
    void waitUntilAutomatedKeysClear(asManager(), SESSION_ID, { source: 'test' }).then((result) => { settled = result; });

    await vi.advanceTimersByTimeAsync(AUTOMATED_KEYS_HOLD_LOG_MS * 2 + 1_000);
    expect(settled).toBeNull();
    const holdLines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('still holding keys'));
    expect(holdLines).toHaveLength(2);
    expect(holdLines[1]).toContain('after 20 min: the Bash tool call has not ended');

    sessionManager.endCall();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe('clear');
  });

  it('ends a hold when the session exits or the signal aborts', async () => {
    sessionManager.blocker = 'a permission prompt is open';
    const exited = waitUntilAutomatedKeysClear(asManager(), SESSION_ID, { source: 'test' });
    sessionManager.emit('exit', SESSION_ID, 0);
    await expect(exited).resolves.toBe('exited');

    const controller = new AbortController();
    const aborted = waitUntilAutomatedKeysClear(asManager(), SESSION_ID, { source: 'test', signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toBe('aborted');
  });

  it('answers clear at once for a session that can take keys', async () => {
    await expect(waitUntilAutomatedKeysClear(asManager(), SESSION_ID, { source: 'test' })).resolves.toBe('clear');
  });

  it('keeps the bounded wait for callers that want one', async () => {
    sessionManager.blocker = 'a permission prompt is open';
    const bounded = waitForAutomatedKeysClearance(asManager(), SESSION_ID, { source: 'test', timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(bounded).resolves.toBe('timeout');
  });
});
