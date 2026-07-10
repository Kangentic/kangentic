import type { Transport } from '@kangentic/protocol';
import { RelayClient } from './relay-client';

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
}

export function createTransport(options: TransportFactoryOptions): Transport {
  return new RelayClient({ relayUrl: options.relayUrl, slotId: options.slotId });
}
