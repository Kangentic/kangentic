/**
 * `awaitQueuedSessionStart` (src/main/automations/turn-end/agent-message-delivery.ts):
 * waits for a session the concurrency cap queued to leave the queue, so a typed
 * opening is written only once the agent has a PTY. True only when it started
 * running; every other end (exit, a non-running status, an abort) is false, and
 * the listeners always come off so a queue that lasts hours leaks nothing.
 *
 * Runs the real function against a real EventEmitter standing in for the
 * session manager.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { awaitQueuedSessionStart } from '../../src/main/automations/turn-end/agent-message-delivery';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const SESSION_ID = 'session-queued-1';
const OTHER_SESSION_ID = 'session-other-2';

function makeContext(): { context: IpcContext; sessionManager: EventEmitter } {
  const sessionManager = new EventEmitter();
  return { context: { sessionManager } as unknown as IpcContext, sessionManager };
}

/** Settles to a value, or 'pending' when the promise has not settled after the microtasks drain. */
async function settledValue(promise: Promise<boolean>): Promise<boolean | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20))]);
}

describe('awaitQueuedSessionStart', () => {
  it('resolves true when the session changes to running', async () => {
    const { context, sessionManager } = makeContext();
    const waiting = awaitQueuedSessionStart(context, SESSION_ID);

    sessionManager.emit('session-changed', SESSION_ID, { status: 'running' });

    expect(await waiting).toBe(true);
  });

  it.each(['exited', 'suspended', 'error'])('resolves false when the session changes to %s instead', async (status) => {
    const { context, sessionManager } = makeContext();
    const waiting = awaitQueuedSessionStart(context, SESSION_ID);

    sessionManager.emit('session-changed', SESSION_ID, { status });

    expect(await waiting).toBe(false);
  });

  it('resolves false when the session exits while queued', async () => {
    const { context, sessionManager } = makeContext();
    const waiting = awaitQueuedSessionStart(context, SESSION_ID);

    sessionManager.emit('exit', SESSION_ID, 0);

    expect(await waiting).toBe(false);
  });

  it('keeps waiting through a queued status push and through other sessions', async () => {
    const { context, sessionManager } = makeContext();
    const waiting = awaitQueuedSessionStart(context, SESSION_ID);

    sessionManager.emit('session-changed', SESSION_ID, { status: 'queued' });
    sessionManager.emit('session-changed', OTHER_SESSION_ID, { status: 'running' });
    sessionManager.emit('exit', OTHER_SESSION_ID, 0);

    expect(await settledValue(waiting)).toBe('pending');

    sessionManager.emit('session-changed', SESSION_ID, { status: 'running' });
    expect(await waiting).toBe(true);
  });

  it('resolves false when the signal aborts while waiting', async () => {
    const { context } = makeContext();
    const controller = new AbortController();
    const waiting = awaitQueuedSessionStart(context, SESSION_ID, controller.signal);

    controller.abort();

    expect(await waiting).toBe(false);
  });

  it('resolves false at once for a signal that is already aborted', async () => {
    const { context } = makeContext();
    const controller = new AbortController();
    controller.abort();

    expect(await awaitQueuedSessionStart(context, SESSION_ID, controller.signal)).toBe(false);
  });

  it('removes its listeners on every way out', async () => {
    const outcomes: Array<(sessionManager: EventEmitter, controller: AbortController) => void> = [
      (sessionManager) => sessionManager.emit('session-changed', SESSION_ID, { status: 'running' }),
      (sessionManager) => sessionManager.emit('exit', SESSION_ID, 0),
      (_sessionManager, controller) => controller.abort(),
    ];
    for (const end of outcomes) {
      const { context, sessionManager } = makeContext();
      const controller = new AbortController();
      const waiting = awaitQueuedSessionStart(context, SESSION_ID, controller.signal);
      expect(sessionManager.listenerCount('session-changed')).toBe(1);
      expect(sessionManager.listenerCount('exit')).toBe(1);

      end(sessionManager, controller);
      await waiting;

      expect(sessionManager.listenerCount('session-changed')).toBe(0);
      expect(sessionManager.listenerCount('exit')).toBe(0);
    }
  });
});
