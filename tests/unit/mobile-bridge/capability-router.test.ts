/**
 * Unit tests for src/main/mobile-bridge/capability-router.ts. The
 * load-bearing property: authorization is checked against the SESSION's
 * capability set BEFORE a handler is even looked up, so a device without
 * a granted verb never reaches a registered handler, and a granted-but-
 * unregistered verb fails closed with a clear error rather than doing
 * nothing silently.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { CapabilityRouter, mobileVerbReporter } from '../../../src/main/mobile-bridge/capability-router';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';

function fakeSession(capabilities: string[]): BridgeSession {
  return { capabilities: new Set(capabilities) } as unknown as BridgeSession;
}

function fakeRequest(verb: CapabilityRequestMessage['verb'], overrides: Partial<CapabilityRequestMessage> = {}): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb, payload: {}, ...overrides };
}

describe('CapabilityRouter', () => {
  it('refuses an unauthorized verb without ever calling a registered handler', async () => {
    const router = new CapabilityRouter();
    const handler = vi.fn();
    router.register('move-task', handler);

    const session = fakeSession(['read-board']); // no move-task
    const response = await router.dispatch(fakeRequest('move-task'), session);

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not authorized/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed with a clear error for an authorized but unregistered verb', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession(['move-task']);

    const response = await router.dispatch(fakeRequest('move-task'), session);

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no handler registered/i);
  });

  it('dispatches to the registered handler when the verb is authorized', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession(['read-board']);
    router.register('read-board', (request) => ({ type: 'capability-response', requestId: request.requestId, ok: true, payload: { columns: [] } }));

    const response = await router.dispatch(fakeRequest('read-board'), session);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ columns: [] });
  });

  it('supports an async handler', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession(['read-diff']);
    router.register('read-diff', async (request) => {
      await Promise.resolve();
      return { type: 'capability-response', requestId: request.requestId, ok: true };
    });

    const response = await router.dispatch(fakeRequest('read-diff'), session);
    expect(response.ok).toBe(true);
  });

  it('catches a handler that throws and returns a failed response instead of rejecting', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession(['answer-permission-prompt']);
    router.register('answer-permission-prompt', () => {
      throw new Error('handler exploded');
    });

    const response = await router.dispatch(fakeRequest('answer-permission-prompt'), session);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('handler exploded');
  });

  // The tag that joins a verb defect to the relay's log of the dial it came in on.
  it('reports a throwing handler with the session\'s relay dial id as a tag', async () => {
    const report = vi.spyOn(mobileVerbReporter, 'report').mockReturnValue(true);
    try {
      const router = new CapabilityRouter();
      const session = { capabilities: new Set(['read-board']), relayDialId: '0123456789abcdef' } as unknown as BridgeSession;
      const failure = new TypeError('handler exploded');
      router.register('read-board', () => {
        throw failure;
      });

      await router.dispatch(fakeRequest('read-board'), session);
      expect(report).toHaveBeenCalledWith(failure, {
        tags: { verb: 'read-board' },
        correlationTags: { relay_dial_id: '0123456789abcdef' },
      });
    } finally {
      report.mockRestore();
    }
  });

  // A slow handler can outlast a forced redial, which mints a new dial id; the
  // report must still name the dial the request arrived on.
  it('tags the dial the request arrived on, not one a redial started while the handler ran', async () => {
    const report = vi.spyOn(mobileVerbReporter, 'report').mockReturnValue(true);
    try {
      const router = new CapabilityRouter();
      const session = { capabilities: new Set(['read-diff']), relayDialId: '0123456789abcdef' } as { capabilities: Set<string>; relayDialId: string };
      let releaseHandler: () => void = () => undefined;
      router.register('read-diff', async () => {
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        throw new TypeError('handler exploded');
      });

      const dispatched = router.dispatch(fakeRequest('read-diff'), session as unknown as BridgeSession);
      session.relayDialId = 'fedcba9876543210';
      releaseHandler();
      await dispatched;
      expect(report).toHaveBeenCalledWith(expect.any(TypeError), {
        tags: { verb: 'read-diff' },
        correlationTags: { relay_dial_id: '0123456789abcdef' },
      });
    } finally {
      report.mockRestore();
    }
  });

  it('sends no correlation tags when the session has no relay dial id', async () => {
    const report = vi.spyOn(mobileVerbReporter, 'report').mockReturnValue(true);
    try {
      const router = new CapabilityRouter();
      const session = { capabilities: new Set(['read-board']), relayDialId: null } as unknown as BridgeSession;
      const failure = new TypeError('handler exploded');
      router.register('read-board', () => {
        throw failure;
      });

      await router.dispatch(fakeRequest('read-board'), session);
      expect(report).toHaveBeenCalledTimes(1);
      const [reportedError, reportOptions] = report.mock.calls[0];
      expect(reportedError).toBe(failure);
      expect(reportOptions?.tags).toEqual({ verb: 'read-board' });
      // Undefined, not an empty object and not { relay_dial_id: null }.
      expect(reportOptions?.correlationTags).toBeUndefined();
    } finally {
      report.mockRestore();
    }
  });

  it('unregister() removes a handler so the verb falls back to fail-closed', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession(['read-stream']);
    router.register('read-stream', () => ({ type: 'capability-response', requestId: 'x', ok: true }));
    router.unregister('read-stream');

    const response = await router.dispatch(fakeRequest('read-stream'), session);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no handler registered/i);
  });

  it('every response carries the original requestId', async () => {
    const router = new CapabilityRouter();
    const session = fakeSession([]);
    const response = await router.dispatch(fakeRequest('send-user-message', { requestId: 'abc-123' }), session);
    expect(response.requestId).toBe('abc-123');
  });

  // Phase 2 added interactive-terminal, board-tool-read, board-tool-write to
  // CAPABILITY_VERBS. The router's dispatch logic is verb-agnostic (no
  // per-verb branching), so this is not re-proving the tests above per
  // verb - it confirms the new verbs are valid router inputs at all.
  it.each(['interactive-terminal', 'board-tool-read', 'board-tool-write'] as const)(
    'dispatches the new verb "%s" like any other once registered and authorized',
    async (verb) => {
      const router = new CapabilityRouter();
      const session = fakeSession([verb]);
      router.register(verb, (request) => ({ type: 'capability-response', requestId: request.requestId, ok: true }));

      const response = await router.dispatch(fakeRequest(verb), session);
      expect(response.ok).toBe(true);
    },
  );
});
