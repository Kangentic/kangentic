/**
 * Unit tests for src/main/mobile-bridge/transport/transport-factory.ts.
 *
 * The module's own doc comment names it as the deliberate swap point for a
 * future non-relay Transport implementation (WebRTC, Phase 4): everything
 * above createTransport() only ever sees the Transport interface, never
 * RelayClient directly. Every existing test mocks this factory out entirely
 * (mobile-bridge-service.test.ts, relay-pairing-integration.test.ts), so
 * nothing pinned that it actually forwards its options to RelayClient
 * correctly. RelayClient itself is fully covered by relay-client.test.ts;
 * this file only needs to confirm the thin forwarding contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransport } from '../../../src/main/mobile-bridge/transport/transport-factory';
import { RelayClient } from '../../../src/main/mobile-bridge/transport/relay-client';
import { resolveRelayChromiumFallback } from '../../../src/main/mobile-bridge/transport/relay-websocket';

// The real resolver reads Electron's `net` and `session`, which a unit test has
// no app for. Mocked, it answers undefined (no fallback) unless a test says
// otherwise, which is also what it answers under plain Node, so the tests
// below that do not care about the fallback behave as before.
vi.mock('../../../src/main/mobile-bridge/transport/relay-websocket', () => ({
  resolveRelayChromiumFallback: vi.fn(),
}));

// File-level so a preferred fallback set by one test can never leak into
// another test's createTransport() call, whatever order the tests run in.
beforeEach(() => {
  vi.mocked(resolveRelayChromiumFallback).mockReset();
});

describe('createTransport()', () => {
  it('returns a RelayClient instance', () => {
    const transport = createTransport({ relayUrl: 'ws://127.0.0.1:1', slotId: 'slot-a' });
    expect(transport).toBeInstanceOf(RelayClient);
  });

  it('forwards relayUrl and slotId through to the underlying RelayClient', () => {
    // RelayClient keeps relayUrl/slotId private, so the forwarding contract
    // is observed indirectly: the dial URL RelayClient builds embeds both
    // (see relay-client.ts's `dial()`), which surfaces as the actual
    // WebSocket connection target. We assert this via the connect-time URL
    // rather than reaching into RelayClient internals. dial() parses with
    // new URL() and sets the slot via searchParams, so a bare-host input
    // gains a normalized trailing slash before the query string.
    const capturedUrls: string[] = [];
    class RecordingWebSocket {
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        capturedUrls.push(url);
      }
      close(): void {
        // no-op: this test only inspects the constructed URL.
      }
    }
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;

    try {
      const transport = createTransport({ relayUrl: 'ws://relay.example.com', slotId: 'my-slot-id' });
      // connect() never resolves here (RecordingWebSocket never fires onopen)
      // and that is fine - we only need dial()'s synchronous URL construction
      // to have run, which happens before any await point.
      void transport.connect().catch(() => undefined);

      // `role=desktop` is the relay's metrics hint (kangentic-relay's
      // guards/peerRole.ts): attribution only, never a gate, so the relay's
      // waiting-peer split can tell this desktop from a phone.
      expect(capturedUrls).toEqual(['ws://relay.example.com/?slot=my-slot-id&role=desktop']);
      transport.close();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    }
  });

  it('dials with an injected WebSocket constructor instead of the global one', () => {
    // The app injects Electron's net.WebSocket (relay-websocket.ts) so the relay
    // rides Chromium's network stack: system proxy, PAC and the OS trust store.
    // The global must not be touched when a constructor is given.
    const injectedUrls: string[] = [];
    const globalUrls: string[] = [];
    class InjectedWebSocket {
      binaryType = 'nodebuffer';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        injectedUrls.push(url);
      }
      close(): void {
        // no-op: this test only inspects which constructor dialed.
      }
    }
    class GlobalWebSocket extends InjectedWebSocket {
      constructor(url: string) {
        super(url);
        globalUrls.push(url);
      }
    }
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = GlobalWebSocket;

    try {
      const transport = createTransport({
        relayUrl: 'ws://relay.example.com',
        slotId: 'my-slot-id',
        webSocketConstructor: InjectedWebSocket as unknown as typeof WebSocket,
      });
      void transport.connect().catch(() => undefined);

      expect(injectedUrls).toEqual(['ws://relay.example.com/?slot=my-slot-id&role=desktop']);
      expect(globalUrls).toEqual([]);
      transport.close();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    }
  });

  it('each call constructs a fresh transport instance (no shared/singleton state across pairing attempts)', () => {
    const first = createTransport({ relayUrl: 'ws://127.0.0.1:1', slotId: 'slot-a' });
    const second = createTransport({ relayUrl: 'ws://127.0.0.1:1', slotId: 'slot-b' });
    expect(first).not.toBe(second);
  });

  it('forwards logLabel through to RelayClient, which prefixes its log lines with it', () => {
    // RelayClient keeps its logPrefix private, and its state getter never
    // surfaces the label either, so the forwarding contract is observed the
    // same indirect way as the URL test above: through a line RelayClient
    // actually writes to the console. A dial that closes before it opens logs
    // `${logPrefix} dial failed: ...` via console.warn - see relay-client.ts's
    // logClose().
    const createdSockets: RecordingWebSocket[] = [];
    class RecordingWebSocket {
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(_url: string) {
        createdSockets.push(this);
      }
      close(): void {
        // no-op: this test only drives the handlers it captured.
      }
    }
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const transport = createTransport({ relayUrl: 'ws://relay.example.com', slotId: 'my-slot-id', logLabel: 'abcdef12' });
      // connect() never resolves here (the socket never fires onopen); the
      // rejection below is expected and handled.
      void transport.connect().catch(() => undefined);

      const socket = createdSockets.at(-1);
      if (!socket) throw new Error('expected RelayClient to have constructed a WebSocket');
      // Simulate the dial closing before it ever opened, which is what makes
      // RelayClient write its logPrefix-carrying line.
      socket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[mobile-bridge/relay-client abcdef12]'));

      transport.close();
    } finally {
      warnSpy.mockRestore();
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    }
  });
});

describe('createTransport() Chromium fallback wiring', () => {
  /**
   * A WebSocket stand-in that records which constructor dialed (by label) and
   * keeps every instance so a test can drive its handlers. It never opens or
   * closes on its own.
   */
  interface RecordedSocket {
    onclose: ((event: CloseEvent) => void) | null;
  }
  function createRecordingWebSocket(label: string, dialLog: string[], sockets: RecordedSocket[] = []): typeof WebSocket {
    class RecordingWebSocket {
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(_url: string) {
        dialLog.push(label);
        sockets.push(this);
      }
      close(): void {
        // no-op: these tests only inspect which constructor dialed.
      }
    }
    return RecordingWebSocket as unknown as typeof WebSocket;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never resolves the Chromium fallback when a WebSocket constructor is injected, so the injected one is the only stack dialed', () => {
    const dialLog: string[] = [];
    vi.stubGlobal('WebSocket', createRecordingWebSocket('global', dialLog));
    // A fallback that is preferred would take over the first dial if the
    // factory ever handed it to the client.
    vi.mocked(resolveRelayChromiumFallback).mockReturnValue({
      webSocketConstructor: createRecordingWebSocket('fallback', dialLog),
      stack: 'chromium',
      isPreferred: () => true,
    });

    const transport = createTransport({
      relayUrl: 'ws://relay.example.com',
      slotId: 'my-slot-id',
      webSocketConstructor: createRecordingWebSocket('injected', dialLog),
    });
    void transport.connect().catch(() => undefined);

    expect(resolveRelayChromiumFallback).not.toHaveBeenCalled();
    expect(dialLog).toEqual(['injected']);
    transport.close();
  });

  it('resolves the Chromium fallback for the relay URL when no constructor is injected, and hands it to the client', () => {
    const dialLog: string[] = [];
    vi.stubGlobal('WebSocket', createRecordingWebSocket('global', dialLog));
    vi.mocked(resolveRelayChromiumFallback).mockReturnValue({
      webSocketConstructor: createRecordingWebSocket('fallback', dialLog),
      stack: 'chromium',
      isPreferred: () => true,
    });

    const transport = createTransport({ relayUrl: 'ws://relay.example.com', slotId: 'my-slot-id' });
    void transport.connect().catch(() => undefined);

    expect(resolveRelayChromiumFallback).toHaveBeenCalledTimes(1);
    expect(resolveRelayChromiumFallback).toHaveBeenCalledWith('ws://relay.example.com');
    // Preferred, so the very first dial is on the fallback rather than the global.
    expect(dialLog).toEqual(['fallback']);
    transport.close();
  });

  it('forwards webSocketStack, so the dial lines name the injected constructor\'s stack', () => {
    const sockets: RecordedSocket[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const transport = createTransport({
        relayUrl: 'ws://relay.example.com',
        slotId: 'my-slot-id',
        logLabel: 'stackfwd',
        webSocketConstructor: createRecordingWebSocket('injected', [], sockets),
        webSocketStack: 'chromium',
      });
      void transport.connect().catch(() => undefined);

      // The dial closes before it opened, which is what writes the dial-failed line.
      sockets[0].onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);

      const dialFailedLines = warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[mobile-bridge/relay-client stackfwd] dial failed:'));
      expect(dialFailedLines).toHaveLength(1);
      expect(dialFailedLines[0].endsWith('(via chromium)')).toBe(true);
      transport.close();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
