/**
 * Relay address rules shared, byte-for-byte, with the mobile app's
 * src/pairing/qr.ts. This module imports nothing on purpose: it is
 * deep-imported by the desktop's src/shared/relay.ts, which the RENDERER
 * bundles, and pulling in the rest of this package (crypto/primitives ->
 * @noble/*) would drag Noise crypto into that bundle for no reason. Keep it
 * dependency-free.
 */

export const MAX_RELAY_ADDRESS_LENGTH = 512;

const LOOPBACK_WS_PREFIXES = ['ws://localhost', 'ws://127.0.0.1', 'ws://[::1]'];

/**
 * True if the phone's pairing QR scanner will accept this relay address.
 * wss:// is always secure; ws:// is accepted only for loopback, since the
 * pairing token doubles as the Noise PSK and is dialed verbatim as
 * `?slot=`. Prefix-based (not hostname-based) with an explicit boundary
 * check, so `ws://localhost.evil.com` - a hostname that merely starts with
 * the string "localhost" - is rejected rather than treated as loopback.
 */
export function isSecureRelayAddress(relayAddress: string): boolean {
  if (relayAddress.startsWith('wss://')) return true;
  return LOOPBACK_WS_PREFIXES.some((prefix) => {
    if (!relayAddress.startsWith(prefix)) return false;
    const boundaryChar = relayAddress.charAt(prefix.length);
    return boundaryChar === '' || boundaryChar === ':' || boundaryChar === '/' || boundaryChar === '?' || boundaryChar === '#';
  });
}
