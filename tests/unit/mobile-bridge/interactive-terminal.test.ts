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
  getSession = vi.fn((id: string) => ({ id, taskId: 'task-1' }));
  isWritable = vi.fn(() => true);
  write = vi.fn();
  resize = vi.fn(() => ({ colsChanged: true }));
  getLastDesktopDimensions = vi.fn((): { cols: number; rows: number } | null => ({ cols: 120, rows: 30 }));
  reconsiderRestingGridAfterMobileRelease = vi.fn();
}

function fakeContext(sessionManager: FakeSessionManager): IpcContext {
  return { sessionManager } as unknown as IpcContext;
}

describe('handleInteractiveTerminal', () => {
  it('rejects when the session does not exist', () => {
    const sessionManager = new FakeSessionManager();
    sessionManager.getSession.mockReturnValue(undefined as never);
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), fakeContext(sessionManager), new SubscriptionRegistry());
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such session/i);
  });

  it('writes raw keystrokes straight through to the live session (full terminal parity)', () => {
    const sessionManager = new FakeSessionManager();
    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'npm login\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ written: true });
    expect(sessionManager.write).toHaveBeenCalledWith('sess-1', 'npm login\r');
  });

  it('rejects (never reports written:true) when the session exists but has no live PTY', () => {
    // A suspended/queued/exited session is still in the registry, so getSession
    // is truthy, but write() would silently drop the bytes - the handler must
    // surface that instead of a false written:true.
    const sessionManager = new FakeSessionManager();
    sessionManager.isWritable.mockReturnValue(false);

    const response = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', data: 'ls\r' }), fakeContext(sessionManager), new SubscriptionRegistry());

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not accepting input/i);
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

  it('release-size is answered even for a non-writable session; a resize is not', () => {
    const sessionManager = new FakeSessionManager();
    sessionManager.isWritable.mockReturnValue(false);
    const subscriptions = new SubscriptionRegistry();
    const context = fakeContext(sessionManager);

    const releaseResponse = handleInteractiveTerminal(fakeRequest({ sessionId: 'sess-1', action: 'release-size' }), context, subscriptions);
    expect(releaseResponse.ok).toBe(true);

    const resizeResponse = handleInteractiveTerminal(
      fakeRequest({ sessionId: 'sess-1', action: 'resize', dimensions: { cols: 48, rows: 26 } }),
      context,
      subscriptions,
    );
    expect(resizeResponse.ok).toBe(false);
    expect(sessionManager.resize).not.toHaveBeenCalled();
  });
});
