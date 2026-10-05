import type { Transport } from '@kangentic/protocol';
import { RelayClient, type RelayWebSocketConstructor } from './relay-client';
import { resolveRelayWebSocket } from './relay-websocket';

/**
 * The swap point named in the research doc's Phase 1 scope: relay is the
 * only implementation today, but everything above this call (pairing
 * service, bridge sessions, capability router) only ever sees the
 * `Transport` interface. A WebRTC data channel implementation (Phase 4)
 * slots in here with nothing above it changing.
 */
export interface TransportFactoryOptions {
  relayUrl: string;
  slotId: string;
  /** Short tag for the transport's log lines (a truncated device id, or 'pairing'); never the slot id. */
  logLabel?: string;
  /**
   * The WebSocket to dial with. Omitted, the app's Chromium-backed
   * `net.WebSocket` is used when it is available (relay-websocket.ts), else
   * Node's global.
   */
  webSocketConstructor?: RelayWebSocketConstructor;
}

export function createTransport(options: TransportFactoryOptions): Transport {
  return new RelayClient({
    relayUrl: options.relayUrl,
    slotId: options.slotId,
    logLabel: options.logLabel,
    webSocketConstructor: options.webSocketConstructor ?? resolveRelayWebSocket(),
  });
}
