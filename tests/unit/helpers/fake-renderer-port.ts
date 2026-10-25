/**
 * A renderer's direct port to the pty host, faked for the unit tier: the host
 * core (or `SessionManager.attachRendererPort`) takes `port`, `received` holds
 * what the host sent the renderer, and `send` posts as the renderer would (a
 * keystroke, an ack). Synchronous, so a test's assertions see each message as
 * soon as the host sends it.
 */
import type { RendererPort } from '../../../src/main/pty/host/protocol';
import type { FromPtyHostPortMessage, ToPtyHostPortMessage } from '../../../src/shared/pty-port-protocol';

export interface FakeRendererPort {
  port: RendererPort;
  received: FromPtyHostPortMessage[];
  /** Post as the renderer: the host's `message` listener gets it. */
  send(message: ToPtyHostPortMessage): void;
  /** The renderer's end went away (a reload, a closed window). */
  disconnect(): void;
  readonly closed: boolean;
}

export function createFakeRendererPort(onMessage?: (message: FromPtyHostPortMessage) => void): FakeRendererPort {
  const received: FromPtyHostPortMessage[] = [];
  const messageListeners: Array<(messageEvent: { data: unknown }) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const port: RendererPort = {
    postMessage(message) {
      if (closed) return;
      received.push(message);
      onMessage?.(message);
    },
    on(event: 'message' | 'close', listener: ((messageEvent: { data: unknown }) => void) | (() => void)) {
      if (event === 'message') messageListeners.push(listener as (messageEvent: { data: unknown }) => void);
      else closeListeners.push(listener as () => void);
      return port;
    },
    start() {},
    close() {
      closed = true;
    },
  };
  return {
    port,
    received,
    send(message) {
      for (const listener of messageListeners) listener({ data: message });
    },
    disconnect() {
      closed = true;
      for (const listener of closeListeners) listener();
    },
    get closed() {
      return closed;
    },
  };
}

/** The `data` messages a fake port received, as `{ sessionId, data }`. */
export function receivedOutput(fake: FakeRendererPort): Array<{ sessionId: string; data: string }> {
  return fake.received.flatMap((message) => (message.type === 'data' ? [{ sessionId: message.sessionId, data: message.data }] : []));
}
