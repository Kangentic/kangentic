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
import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { WebSocketServer } from 'ws';
import { RelayClient, isRedialableTransport } from '../../../src/main/mobile-bridge/transport/relay-client';

/**
 * A minimal controllable stand-in for the global `WebSocket`. Deliberately
 * never fires `onopen`/`onclose` on its own: the close-during-pending-connect
 * test proves RelayClient.close() settles a still-pending connect() promise
 * ITSELF, without depending on any later socket event (a real local `ws`
 * server opens far too fast on localhost to reliably observe a
 * still-CONNECTING socket), and the redial and watchdog tests need to hold a
 * dial open for exactly as long as they choose. A test drives it with
 * `open()` (the server accepted the upgrade) and `fail(code)` (the socket
 * died: undici fires onerror and then onclose for a dial that never opened,
 * and onclose alone for an established socket).
 */
interface FakeErrorEvent {
  type: string;
  message?: string;
  error?: Error;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: FakeErrorEvent) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  closeCallCount = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {
    // no-op: never reached by these tests.
  }

  close(): void {
    this.closeCallCount += 1;
    // Intentionally does NOT fire onclose - see class doc comment.
  }

  private opened = false;

  open(): void {
    this.opened = true;
    this.onopen?.();
  }

  /**
   * @param errorEvent Overrides the default `{ type: 'error', message:
   * 'connect ECONNREFUSED' }` onerror payload, for a test driving
   * describeErrorEvent's other two branches (an Error with no message, or
   * neither). Only fired for a dial that never opened, same as the default.
   */
  fail(code: number, reason = '', errorEvent?: FakeErrorEvent): void {
    if (!this.opened && code === 1006) this.onerror?.(errorEvent ?? { type: 'error', message: 'connect ECONNREFUSED' });
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function stubFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
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

  /**
   * The guarantee revokeDevice()'s goodbye rides on: sendGoodbye() is
   * immediately followed by dispose(), which calls transport.close(). Per
   * the WHATWG close algorithm the closing handshake starts AFTER queued
   * messages, so the frame must reach the server anyway - this pins that
   * for the global (undici) WebSocket this client actually uses, the way
   * the mobile repo's relayTransport.test.ts pins it for `ws`.
   */
  it('flushes a frame written immediately before close()', async () => {
    const { url, wss } = await startEchoServer();
    activeServers.push(wss);
    const serverReceived = new Promise<Uint8Array>((resolve) => {
      wss.on('connection', (socket) => {
        socket.on('message', (data) => resolve(new Uint8Array(data as Buffer)));
      });
    });
    const client = new RelayClient({ relayUrl: url, slotId: 'test-slot' });
    activeClients.push(client);
    await client.connect();

    client.send(new TextEncoder().encode('goodbye'));
    client.close();

    const received = await serverReceived;
    expect(new TextDecoder().decode(received)).toBe('goodbye');
  });

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
    stubFakeWebSocket();

    try {
      const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
      activeClients.push(client);

      // dial()'s Promise executor runs synchronously up through
      // `new WebSocket(url)`, so by the time connect() returns, the fake
      // socket already exists and onopen has NOT fired.
      const connectPromise = client.connect();
      expect(FakeWebSocket.instances).toHaveLength(1);

      client.close();

      await expect(connectPromise).rejects.toThrow(/closed before it opened/);
      expect(FakeWebSocket.instances[0].closeCallCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The forced redial and the dial watchdog: the two ways a socket the OS never
 * reports on gets replaced. `redialNow({ force })` is BridgeSession's lever
 * for a socket that reads open and carries nothing (its spent presence
 * budget); the watchdog is this class's own bound on a dial that reaches
 * none of its handlers, which nothing above the transport can see. Both
 * mirror kangentic-mobile's relayTransportReconnect.test.ts. Fake timers and
 * the fake socket wherever the test needs to hold a dial open; the real echo
 * server for the one property only a real socket can prove (an abandoned
 * socket's late close arming nothing).
 *
 * Constants mirror relay-client.ts: INITIAL_BACKOFF_MS 500, DIAL_TIMEOUT_MS 30s.
 */
describe('RelayClient redial and dial watchdog', () => {
  let activeClients: RelayClient[] = [];
  let activeServers: WebSocketServer[] = [];
  let logSpy: MockInstance<typeof console.log>;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

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
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function loggedLines(spy: MockInstance<typeof console.log>): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
  }

  it('is a RedialableTransport, which the plain Transport doubles are not', () => {
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    expect(isRedialableTransport(client)).toBe(true);
    expect(
      isRedialableTransport({
        state: 'connected',
        connect: () => Promise.resolve(),
        send: () => undefined,
        close: () => undefined,
        onFrame: () => () => undefined,
        onStateChange: () => () => undefined,
      }),
    ).toBe(false);
  });

  it('a forced redial abandons the open socket, dials afresh, and the abandoned socket\'s late close arms nothing', async () => {
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

    client.redialNow({ force: true, reason: 'test' });
    // 'reconnecting' is emitted synchronously, BEFORE the new dial, so a
    // BridgeSession sees its leave-connected edge before the fresh socket.
    expect(client.state).toBe('reconnecting');

    await reconnected;
    expect(connectionCount()).toBe(2);
    expect(states).toEqual(['reconnecting', 'connected']);

    // The abandoned socket really closes (the server drops it), and its
    // close event, arriving after the successor opened, must neither null
    // the successor nor arm a third dial. Without the handler detach in
    // abandonSocket() this reads 3.
    await expect.poll(() => wss.clients.size, { timeout: 5_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(connectionCount()).toBe(2);
    expect(client.state).toBe('connected');

    const framePromise = new Promise<Uint8Array>((resolve) => client.onFrame(resolve));
    client.send(new TextEncoder().encode('fresh socket'));
    expect(new TextDecoder().decode(await framePromise)).toBe('fresh socket');
  }, 15_000);

  it('a non-forced kick on an open socket is a no-op', () => {
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);
    FakeWebSocket.instances[0].open();
    expect(client.state).toBe('connected');

    client.redialNow({ reason: 'test' });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closeCallCount).toBe(0);
    expect(client.state).toBe('connected');
  });

  it('a kick mid-backoff dials at once and the stale reconnect timer never fires', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);
    FakeWebSocket.instances[0].open();

    // The socket drops: a 500ms reconnect is armed.
    FakeWebSocket.instances[0].fail(1006);
    expect(client.state).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    client.redialNow({ reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(client.state).toBe('connected');

    // Well past the stale timer AND the watchdog: neither dials again.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('the backoff ladder restarts at the floor after a kick', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);
    FakeWebSocket.instances[0].open();

    // Three failures climb the ladder: 500, 1000, then 2000 armed.
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].fail(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].fail(1006);

    client.redialNow({ reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(4);

    // The kicked dial fails too: the next attempt is 500ms out, not 4000.
    FakeWebSocket.instances[3].fail(1006);
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  it('is a no-op while idle, after a malformed-URL close, and after an explicit close()', async () => {
    stubFakeWebSocket();
    const idle = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(idle);
    idle.redialNow({ force: true, reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(0);

    const malformed = new RelayClient({ relayUrl: 'not a url', slotId: 'test-slot' });
    activeClients.push(malformed);
    await expect(malformed.connect()).rejects.toThrow();
    expect(malformed.state).toBe('closed');
    malformed.redialNow({ force: true, reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(malformed.state).toBe('closed');

    const closed = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(closed);
    void closed.connect().catch(() => undefined);
    FakeWebSocket.instances[0].open();
    closed.close();
    closed.redialNow({ force: true, reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(closed.state).toBe('closed');
  });

  it('a forced redial mid-dial rejects the pending connect() and dials again', async () => {
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    const connectPromise = client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    client.redialNow({ force: true, reason: 'test' });

    await expect(connectPromise).rejects.toThrow(/abandoned by a forced redial/);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].closeCallCount).toBe(1);
    expect(FakeWebSocket.instances[1].closeCallCount).toBe(0);
  });

  it('the dial watchdog abandons a dial that never opens and joins the backoff ladder', async () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    const connectPromise = client.connect();
    connectPromise.catch(() => undefined);

    vi.advanceTimersByTime(29_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closeCallCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances[0].closeCallCount).toBe(1);
    expect(client.state).toBe('reconnecting');
    await expect(connectPromise).rejects.toThrow(/timed out/);
    expect(loggedLines(warnSpy).some((line) => line.includes('dial timed out after 30 s'))).toBe(true);

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('close() during a dial clears the watchdog rather than leaking it', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);
    vi.advanceTimersByTime(1_000);

    client.close();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.state).toBe('closed');
  });

  it('a superseded dial\'s watchdog never reaches its successor', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);

    // The first dial's watchdog would fire at 30s; it is superseded at 10s.
    vi.advanceTimersByTime(10_000);
    client.redialNow({ force: true, reason: 'test' });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Past the first dial's deadline: the successor is untouched, and it
    // opens before its own deadline (40s) so nothing else fires either.
    vi.advanceTimersByTime(20_001);
    expect(FakeWebSocket.instances[1].closeCallCount).toBe(0);
    FakeWebSocket.instances[1].open();
    expect(client.state).toBe('connected');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.state).toBe('connected');
  });

  it('logs the park-timeout close at log level and every other close at warn, with the code', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot', logLabel: 'abcd1234' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);
    FakeWebSocket.instances[0].open();

    // The routine churn of a parked slot: once a minute forever, so `log`.
    FakeWebSocket.instances[0].fail(4408, 'park_timeout');
    expect(loggedLines(logSpy).some((line) => line.includes('[mobile-bridge/relay-client abcd1234]') && line.includes('code 4408'))).toBe(true);
    expect(loggedLines(warnSpy).some((line) => line.includes('closed:'))).toBe(false);

    // A keepalive reap or a dead TCP peer: the signal, so `warn`.
    vi.advanceTimersByTime(500);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);
    expect(loggedLines(warnSpy).some((line) => line.includes('closed: code=1006'))).toBe(true);

    // A dial that never opened folds the onerror text into one warn line.
    vi.advanceTimersByTime(500);
    FakeWebSocket.instances[2].fail(1006);
    expect(loggedLines(warnSpy).some((line) => line.includes('dial failed: connect ECONNREFUSED'))).toBe(true);

    // The forced redial names its reason.
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[3].open();
    client.redialNow({ force: true, reason: 'peer went silent' });
    expect(loggedLines(warnSpy).some((line) => line.includes('forced redial (peer went silent) from connected'))).toBe(true);
  });

  it('folds an onerror carrying only an Error, with no message, into the dial-failed warn line', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);

    FakeWebSocket.instances[0].fail(1006, '', { type: 'error', error: new Error('tls handshake failed') });

    expect(loggedLines(warnSpy).some((line) => line.includes('dial failed: tls handshake failed'))).toBe(true);
  });

  it('falls back to "<event type> event with no message" when onerror carries neither a message nor an error', () => {
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    void client.connect().catch(() => undefined);

    FakeWebSocket.instances[0].fail(1006, '', { type: 'error' });

    expect(loggedLines(warnSpy).some((line) => line.includes('dial failed: error event with no message'))).toBe(true);
  });

  it('scheduleReconnect() arms the reconnect timer before emitting "reconnecting", so a re-entrant kick clears the timer instead of racing one that was never armed', async () => {
    // Pins the ORDER inside scheduleReconnect(): the reconnect timer must be
    // armed before setState('reconnecting') emits, because a listener that
    // reacts to that emission by calling redialNow() runs synchronously,
    // re-entrantly, from inside this very call. If the emit ran first, the
    // kick would find no timer to clear, and the timer armed moments later
    // by the (still-running) original scheduleReconnect() call would go on
    // to fire its own second dial.
    vi.useFakeTimers();
    stubFakeWebSocket();
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1', slotId: 'test-slot' });
    activeClients.push(client);
    const connectPromise = client.connect();
    connectPromise.catch(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);

    let kicked = false;
    client.onStateChange((state) => {
      if (state !== 'reconnecting' || kicked) return;
      kicked = true;
      // Non-forced: this.socket is already null at this point (onclose
      // cleared it before scheduleReconnect ran), so this reaches the
      // "dial now" branch rather than being skipped as a no-op kick.
      client.redialNow({ reason: 'test kick' });
    });

    // The dial never opens: this fires onerror then onclose, which schedules
    // a reconnect and emits 'reconnecting' - synchronously running the kick
    // above from inside that emission.
    FakeWebSocket.instances[0].fail(1006);

    // Exactly one new socket was dialed by the kick.
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The original INITIAL_BACKOFF_MS (500ms) timer was cleared by the
    // kick: letting it elapse, and a bit beyond, must not dial a third.
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The re-entrant kick did not orphan the transport: close() still works
    // and the original connect() promise settles instead of hanging forever.
    client.close();
    expect(client.state).toBe('closed');
    await expect(connectPromise).rejects.toThrow();
  });
});
