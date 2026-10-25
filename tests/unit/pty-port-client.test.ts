/**
 * PtyPortClient (src/preload/pty-port-client.ts): the renderer's end of its
 * direct port to the pty host. These pin what `useTerminal` relies on: a
 * scrollback answer resolves before the output after it is dispatched, an
 * answer for a request this page never made is dropped, main's `{ sentToPort }`
 * settles nothing, a rejected request rejects, a port swap fails what the dead
 * host never answered, and keystrokes made before the first port reach the host
 * in order.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';
import { PtyPortClient, type PtyPortEndpoint } from '../../src/preload/pty-port-client';
import type { ScrollbackInvokeResult, ToPtyHostPortMessage } from '../../src/shared/pty-port-protocol';

interface FakeEndpoint extends PtyPortEndpoint {
  sent: ToPtyHostPortMessage[];
  /** Deliver a message from the host, as the DOM port's `message` event does. */
  receive(data: unknown): void;
  closed: boolean;
  started: boolean;
}

function createEndpoint(): FakeEndpoint {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const endpoint: FakeEndpoint = {
    sent: [],
    closed: false,
    started: false,
    postMessage(message) {
      endpoint.sent.push(message);
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    start() {
      endpoint.started = true;
    },
    close() {
      endpoint.closed = true;
    },
    receive(data) {
      for (const listener of [...listeners]) listener({ data });
    },
  };
  return endpoint;
}

/** An invoke main has not answered yet. */
function deferredInvoke() {
  let resolveInvoke: (result: ScrollbackInvokeResult | string) => void = () => undefined;
  let rejectInvoke: (error: unknown) => void = () => undefined;
  const calls: Array<{ sessionId: string; requestId: number }> = [];
  const invoke = vi.fn((sessionId: string, requestId: number) => {
    calls.push({ sessionId, requestId });
    return new Promise<ScrollbackInvokeResult | string>((resolve, reject) => {
      resolveInvoke = resolve;
      rejectInvoke = reject;
    });
  });
  return {
    invoke,
    calls,
    resolve: (result: ScrollbackInvokeResult | string) => resolveInvoke(result),
    reject: (error: unknown) => rejectInvoke(error),
  };
}

describe('PtyPortClient', () => {
  it('keeps writes and acks made before the first port, and sends them in order once it arrives', () => {
    const client = new PtyPortClient(vi.fn());
    client.write('session-1', 'a');
    client.ack('session-1', 40);
    client.write('session-1', 'b');

    const endpoint = createEndpoint();
    client.attachPort(endpoint);
    client.write('session-1', 'c');

    expect(endpoint.started).toBe(true);
    expect(endpoint.sent).toEqual([
      { type: 'write', sessionId: 'session-1', data: 'a' },
      { type: 'ack', sessionId: 'session-1', bytes: 40 },
      { type: 'write', sessionId: 'session-1', data: 'b' },
      { type: 'write', sessionId: 'session-1', data: 'c' },
    ]);
  });

  it('dispatches each data message to every listener, and stops after the unsubscribe', () => {
    const client = new PtyPortClient(vi.fn());
    const endpoint = createEndpoint();
    client.attachPort(endpoint);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = client.onData(first);
    client.onData(second);

    endpoint.receive({ type: 'data', sessionId: 'session-1', data: 'hello' });
    unsubscribeFirst();
    endpoint.receive({ type: 'data', sessionId: 'session-1', data: 'again' });

    expect(first.mock.calls).toEqual([['session-1', 'hello']]);
    expect(second.mock.calls).toEqual([['session-1', 'hello'], ['session-1', 'again']]);
  });

  it('resolves the scrollback before the output after it is dispatched, so the continuation sees the order the host sent', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    const endpoint = createEndpoint();
    client.attachPort(endpoint);
    const order: string[] = [];
    client.onData((_sessionId, data) => order.push(`data:${data}`));

    const replay = client.getScrollback('session-1').then((data) => order.push(`scrollback:${data}`));
    const { requestId } = main.calls[0];
    endpoint.receive({ type: 'data', sessionId: 'session-1', data: 'before the sample' });
    endpoint.receive({ type: 'scrollback', requestId, data: 'the sample' });
    // The resolve's continuation is a microtask: it runs before the next port
    // message, which the DOM delivers as its own task.
    await Promise.resolve();
    endpoint.receive({ type: 'data', sessionId: 'session-1', data: 'after the sample' });
    await replay;

    expect(order).toEqual(['data:before the sample', 'scrollback:the sample', 'data:after the sample']);
  });

  it('settles nothing on main\'s { sentToPort: true }, whichever side arrives first', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    const endpoint = createEndpoint();
    client.attachPort(endpoint);

    const replay = client.getScrollback('session-1');
    main.resolve({ sentToPort: true });
    await Promise.resolve();
    endpoint.receive({ type: 'scrollback', requestId: main.calls[0].requestId, data: 'from the port' });

    await expect(replay).resolves.toBe('from the port');
  });

  it('resolves on main\'s own data when the host held no port for this renderer', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    client.attachPort(createEndpoint());

    const replay = client.getScrollback('session-1');
    main.resolve({ sentToPort: false, data: 'answered by main' });

    await expect(replay).resolves.toBe('answered by main');
  });

  it('drops an answer for a request id this page never made', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    const endpoint = createEndpoint();
    client.attachPort(endpoint);
    const settled = vi.fn();

    void client.getScrollback('session-1').then(settled, settled);
    endpoint.receive({ type: 'scrollback', requestId: main.calls[0].requestId + 100, data: 'meant for the page before a reload' });
    endpoint.receive({ type: 'not-a-host-message' });
    endpoint.receive('garbage');
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });

  it('rejects when main\'s invoke rejects, and when the host reports a failed sample', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    const endpoint = createEndpoint();
    client.attachPort(endpoint);

    const rejectedByMain = client.getScrollback('session-1');
    main.reject(new Error('no such session'));
    await expect(rejectedByMain).rejects.toThrow('no such session');

    const failedInHost = client.getScrollback('session-1');
    endpoint.receive({ type: 'scrollbackFailed', requestId: main.calls[1].requestId, message: 'sample failed' });
    await expect(failedInHost).rejects.toThrow('sample failed');
  });

  it('on a port swap, rejects what the old host never answered, closes the old port and hears only the new one', async () => {
    const main = deferredInvoke();
    const client = new PtyPortClient(main.invoke);
    const oldEndpoint = createEndpoint();
    client.attachPort(oldEndpoint);
    const listener = vi.fn();
    client.onData(listener);

    const pending = client.getScrollback('session-1');
    const replacement = createEndpoint();
    client.attachPort(replacement);

    await expect(pending).rejects.toThrow(/restarted/);
    expect(oldEndpoint.closed).toBe(true);
    oldEndpoint.receive({ type: 'data', sessionId: 'session-1', data: 'from the dead host' });
    replacement.receive({ type: 'data', sessionId: 'session-1', data: 'from the new host' });
    expect(listener.mock.calls).toEqual([['session-1', 'from the new host']]);

    client.write('session-1', 'k');
    expect(replacement.sent).toEqual([{ type: 'write', sessionId: 'session-1', data: 'k' }]);
    expect(oldEndpoint.sent).toEqual([]);
  });
});
