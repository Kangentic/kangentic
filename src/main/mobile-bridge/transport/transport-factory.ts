import type { Transport } from '@kangentic/protocol';
import { RelayClient, type RelayWebSocketConstructor } from './relay-client';
import { resolveRelayChromiumFallback } from './relay-websocket';

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
   * The WebSocket to dial with, for tests. Omitted, the client dials with
   * Node's global and keeps Electron's `net.WebSocket` as its fallback
   * (relay-websocket.ts says why in that order).
   */
  webSocketConstructor?: RelayWebSocketConstructor;
  /** The network stack an injected `webSocketConstructor` runs on, for the dial log lines. */
  webSocketStack?: string;
}

export function createTransport(options: TransportFactoryOptions): Transport {
  return new RelayClient({
    relayUrl: options.relayUrl,
    slotId: options.slotId,
    logLabel: options.logLabel,
    webSocketConstructor: options.webSocketConstructor,
    webSocketStack: options.webSocketStack,
    fallbackWebSocket: options.webSocketConstructor ? undefined : resolveRelayChromiumFallback(options.relayUrl),
  });
}
