import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleInteractiveTerminal } from '../../../src/main/mobile-bridge/handlers/interactive-terminal';
import { sizeGuardKeyFor } from '../../../src/main/mobile-bridge/handlers/terminal-size-guard';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'interactive-terminal', payload };
}

class FakeSessionManager extends EventEmitter {
  getSession = vi.fn((id: string): { id: string; taskId: string; status: string } => ({ id, taskId: 'task-1', status: 'running' }));
  isWritable = vi.fn(() => true);
  write = vi.fn();
  resize = vi.fn(() => ({ colsChanged: true }));
  getLastDesktopDimensions = vi.fn((): { cols: number; rows: number } | null => ({ cols: 120, rows: 30 }));
  reconsiderRestingGridAfterMobileRelease = vi.fn();
  getActivityStatsSnapshot = vi.fn((): { permissionPending: boolean; permissionAwaitedToolId: string | null } | null => null);
}

function fakeContext(sessionManager: FakeSessionManager): IpcContext {
  return { sessionManager } as unknown as IpcContext;
}

describe('handleInteractiveTerminal', () => {
  it('rejects with the unknown-session code when the session does not exist', () => {
    const sessionManager = new FakeSessionManager();
    sessionManager.getSession.mockReturnValue(undefined as never);
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), fakeContext(sessionManager), new SubscriptionRegistry());
    expect(response).toMatchObject({ ok: false, code: 'unknown-session', error: 'No such session: sess-1' });
  });

  it('writes raw keystrokes straight through to the live session (full terminal parity)', () => {
    const sessionManager = new FakeSessionManager();
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'npm login\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ written: true });
    expect(sessionManager.write).toHaveBeenCalledWith('sess-1', 'npm login\r', 'user');
  });

  // Task #952: a stray "1" reached an agent's input. A write while a prompt
  // reads open is logged by its length, never its text, which can be a password.
  it('logs a write made while a permission prompt reads open, by length only, and still writes it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const sessionManager = new FakeSessionManager();
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'toolu_abc' });
      handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'hunter2\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

      expect(sessionManager.write).toHaveBeenCalledWith('sess-1', 'hunter2\r', 'user');
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('typed 8 byte(s)') && line.includes('toolu_abc'))).toBe(true);
      expect(lines.some((line) => line.includes('hunter2'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('rejects (never reports written:true) when the session exists but has no live PTY', () => {
    // A suspended/queued/exited session is still in the registry, so getSession
    // is truthy, but write() would silently drop the bytes - the handler must
    // surface that instead of a false written:true.
    const sessionManager = new FakeSessionManager();
    sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended' });
    sessionManager.isWritable.mockReturnValue(false);

    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

    expect(response).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(response.error).toMatch(/not accepting input/i);
    expect(sessionManager.write).not.toHaveBeenCalled();
  });

  it('refuses a queued session without the unknown-session code, since its PTY is still coming', () => {
    const sessionManager = new FakeSessionManager();
    sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'queued' });
    sessionManager.isWritable.mockReturnValue(false);

    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not accepting input/i);
    expect(response.code).toBeUndefined();
    expect(sessionManager.write).not.toHaveBeenCalled();
  });

  it('resize calls sessionManager.resize with mobile origin and arms the restore guard', () => {
    const sessionManager = new FakeSessionManager();
    const subscriptions = new SubscriptionRegistry();

    const response = handleInteractiveTerminal(
      fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }),
      fakeContext(sessionManager),
      subscriptions,
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ resized: true, colsChanged: true });
    expect(sessionManager.resize).toHaveBeenCalledWith('sess-1', 48, 26, 'mobile');
    expect(subscriptions.has(sizeGuardKeyFor('sess-1'))).toBe(true);
  });

  it('a repeat resize keeps the existing guard armed and does NOT restore mid-hold', () => {
    const sessionManager = new FakeSessionManager();
    const subscriptions = new SubscriptionRegistry();
    const context = fakeContext(sessionManager);

    handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }), context, subscriptions);
    handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 44, rows: 24 } }), context, subscriptions);

    // Only the two mobile resizes: no desktop-origin restore fired between them
    // (SubscriptionRegistry.set runs a replaced teardown, which the arm guard
    // must avoid by keeping the first guard).
    expect(sessionManager.resize).toHaveBeenCalledTimes(2);
    expect(sessionManager.resize).toHaveBeenNthCalledWith(1, 'sess-1', 48, 26, 'mobile');
    expect(sessionManager.resize).toHaveBeenNthCalledWith(2, 'sess-1', 44, 24, 'mobile');
  });

  it('release-size restores the last desktop dimensions', () => {
    const sessionManager = new FakeSessionManager();
    const subscriptions = new SubscriptionRegistry();
    const context = fakeContext(sessionManager);

    handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }), context, subscriptions);
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'release-size' }), context, subscriptions);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ released: true });
    expect(sessionManager.resize).toHaveBeenLastCalledWith('sess-1', 120, 30, 'desktop');
    expect(subscriptions.has(sizeGuardKeyFor('sess-1'))).toBe(false);
    // The release also asks the park decision to re-run: an unheld session
    // should return to the resting grid so the next phone visit finds park
    // dims (its cue to request a fit-to-phone grid).
    expect(sessionManager.reconsiderRestingGridAfterMobileRelease).toHaveBeenCalledWith('sess-1');
  });

  it('device disconnect (registry dispose) restores the last desktop dimensions', () => {
    const sessionManager = new FakeSessionManager();
    const subscriptions = new SubscriptionRegistry();

    handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }), fakeContext(sessionManager), subscriptions);
    subscriptions.dispose();

    expect(sessionManager.resize).toHaveBeenLastCalledWith('sess-1', 120, 30, 'desktop');
  });

  it('session exit disarms the guard without restoring into the dead session', () => {
    const sessionManager = new FakeSessionManager();
    const subscriptions = new SubscriptionRegistry();

    handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }), fakeContext(sessionManager), subscriptions);
    sessionManager.emit('exit', 'sess-1', 0, false);

    expect(subscriptions.has(sizeGuardKeyFor('sess-1'))).toBe(false);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    // Only the original mobile resize: no desktop-origin restore into a dead session.
    expect(sessionManager.resize).toHaveBeenCalledTimes(1);
    // And no re-park request either - there is nothing left to park.
    expect(sessionManager.reconsiderRestingGridAfterMobileRelease).not.toHaveBeenCalled();
  });

  it('release-size is answered even for a suspended session; a resize is refused with the unknown-session code', () => {
    // The phone contract: leaving a suspended session's terminal view gives the
    // grid back without a refusal, while a resize there reads as the session gone.
    const sessionManager = new FakeSessionManager();
    sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended' });
    sessionManager.isWritable.mockReturnValue(false);
    const subscriptions = new SubscriptionRegistry();
    const context = fakeContext(sessionManager);

    const releaseResponse = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'release-size' }), context, subscriptions);
    expect(releaseResponse.ok).toBe(true);
    expect(releaseResponse.code).toBeUndefined();

    const resizeResponse = handleInteractiveTerminal(
      fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }),
      context,
      subscriptions,
    );
    expect(resizeResponse).toMatchObject({ ok: false, code: 'unknown-session' });
    expect(sessionManager.resize).not.toHaveBeenCalled();
  });
});
