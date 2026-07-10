/**
 * The swappable transport boundary. A Transport moves opaque frames
 * (already-encrypted secretstream frames, or raw Noise handshake bytes
 * during pairing/session setup) between two peers; it knows nothing about
 * Noise, capability verbs, or the message schema. The relay client
 * (src/main/mobile-bridge/transport/relay-client.ts, desktop-side) is the
 * v1 implementation; a WebRTC data channel implementation (Phase 4) slots
 * in behind this exact interface, so nothing above the transport layer
 * changes when direct P2P becomes available.
 */
export type TransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type Unsubscribe = () => void;

export interface Transport {
  readonly state: TransportState;
  connect(): Promise<void>;
  /** Sends one opaque frame. Throws if the transport is not connected. */
  send(frame: Uint8Array): void;
  /** Synchronous, idempotent teardown. */
  close(): void;
  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
}
