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
import { describe, it, expect, vi } from 'vitest';
import { createTransport } from '../../../src/main/mobile-bridge/transport/transport-factory';
import { RelayClient } from '../../../src/main/mobile-bridge/transport/relay-client';

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
