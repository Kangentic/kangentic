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
import { describe, it, expect } from 'vitest';
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

      expect(capturedUrls).toEqual(['ws://relay.example.com/?slot=my-slot-id']);
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
});
