/**
 * Unit tests for src/main/mobile-bridge/transport/relay-client.ts, focused
 * on the reconnect behavior (the one Phase-1 deliverable this module owns
 * that relay-pairing-integration.test.ts doesn't exercise - that file
 * only covers a single successful connection through to pairing
 * completion). Runs against a real local `ws` server (not the shared
 * relay-double.ts, since these tests need to unilaterally drop a
 * connection from the server side, which the double's pairing-rendezvous
 * shape doesn't model).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { RelayClient } from '../../../src/main/mobile-bridge/transport/relay-client';

/**
 * A minimal controllable stand-in for the global `WebSocket` used only by
 * the close-during-pending-connect test below. Deliberately never fires
 * `onopen`/`onclose` on its own - the point of that test is to prove
 * RelayClient.close() settles a still-pending connect() promise ITSELF,
 * without depending on any later socket event (a real local `ws` server
 * opens far too fast on localhost to reliably observe a still-CONNECTING
 * socket, so this is not testable against a real socket).
 */
class FakeWebSocket {
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCallCount = 0;

  constructor(readonly url: string) {}

  send(): void {
    // no-op: never reached by the pending-connect test.
  }

  close(): void {
    this.closeCallCount += 1;
    // Intentionally does NOT fire onclose - see class doc comment.
  }
}

async function startEchoServer(): Promise<{ url: string; wss: WebSocketServer; connectionCount: () => number }> {
  const wss = new WebSocketServer({ port: 0 });
  let connectionCount = 0;
  wss.on('connection', (socket) => {
    connectionCount += 1;
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Echo server failed to bind a port');
  return { url: `ws://127.0.0.1:${address.port}`, wss, connectionCount: () => connectionCount };
}

describe('RelayClient', () => {
  let activeClients: RelayClient[] = [];
  let activeServers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const client of activeClients) client.close();
    activeClients = [];
    await Promise.all(
      activeServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => resolve());
          }),
      ),
    );
    activeServers = [];
  });

  it('connects, sends, and receives a frame round trip', async () => {
    const { url, wss } = await startEchoServer();
    activeServers.push(wss);
    const client = new RelayClient({ relayUrl: url, slotId: 'test-slot' });
    activeClients.push(client);

    await client.connect();
    expect(client.state).toBe('connected');

    const framePromise = new Promise<Uint8Array>((resolve) => {
      client.onFrame(resolve);
    });
    client.send(new TextEncoder().encode('hello relay'));
    const received = await framePromise;
    expect(new TextDecoder().decode(received)).toBe('hello relay');
  });

  it('automatically reconnects after the server drops the connection', async () => {
    const { url, wss, connectionCount } = await startEchoServer();
    activeServers.push(wss);
    const client = new RelayClient({ relayUrl: url, slotId: 'test-slot' });
    activeClients.push(client);

    await client.connect();
    expect(connectionCount()).toBe(1);

    const states: string[] = [];
    client.onStateChange((state) => states.push(state));

    const reconnected = new Promise<void>((resolve) => {
      const unsubscribe = client.onStateChange((state) => {
        if (state === 'connected') {
          unsubscribe();
          resolve();
        }
      });
    });

    // Drop the connection from the server side.
    for (const socket of wss.clients) socket.terminate();

    await reconnected;
    expect(states).toContain('reconnecting');
    expect(client.state).toBe('connected');
    expect(connectionCount()).toBe(2);

    // The reconnected socket still works.
    const framePromise = new Promise<Uint8Array>((resolve) => client.onFrame(resolve));
    client.send(new TextEncoder().encode('still alive'));
    const received = await framePromise;
    expect(new TextDecoder().decode(received)).toBe('still alive');
  }, 15_000);

  it('does not reconnect after an explicit close()', async () => {
    const { url, wss } = await startEchoServer();
    activeServers.push(wss);
    const client = new RelayClient({ relayUrl: url, slotId: 'test-slot' });
    activeClients.push(client);

    await client.connect();
    client.close();

    expect(client.state).toBe('closed');
    // Give any stray reconnect timer a chance to fire, if the bug existed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.state).toBe('closed');
  });

  it('rejects immediately on a malformed relayUrl instead of entering the reconnect backoff loop', async () => {
    const client = new RelayClient({ relayUrl: 'not a url', slotId: 'test-slot' });
    activeClients.push(client);

    await expect(client.connect()).rejects.toThrow();
    expect(client.state).toBe('closed');

    // No reconnect timer was armed: state stays 'closed' rather than cycling into 'reconnecting'.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.state).toBe('closed');
  });

  it('send() throws when called before connecting', () => {
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    expect(() => client.send(new Uint8Array([1, 2, 3]))).toThrow(/not connected/);
  });

  it('send() throws once the per-session byte cap is exceeded', async () => {
    const { url, wss } = await startEchoServer();
    activeServers.push(wss);
    const client = new RelayClient({ relayUrl: url, slotId: 'test-slot', maxBytesPerSession: 4 });
    activeClients.push(client);

    await client.connect();
    expect(() => client.send(new Uint8Array(5))).toThrow(/byte cap/);
  });

  it('settles a still-pending connect() promise (rejects) when close() is called before the socket opens', async () => {
    const fakeSockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        fakeSockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', TrackedFakeWebSocket as unknown as typeof WebSocket);

    try {
      const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
      activeClients.push(client);

      // dial()'s Promise executor runs synchronously up through
      // `new WebSocket(url)`, so by the time connect() returns, the fake
      // socket already exists and onopen has NOT fired.
      const connectPromise = client.connect();
      expect(fakeSockets).toHaveLength(1);

      client.close();

      await expect(connectPromise).rejects.toThrow(/closed before it opened/);
      expect(fakeSockets[0].closeCallCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
