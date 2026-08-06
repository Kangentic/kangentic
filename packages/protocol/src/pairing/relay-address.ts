/**
 * Relay address rules, mirrored by the mobile app's src/pairing/qr.ts (which
 * hardened these rules first; this module now matches it). This module
 * imports nothing on purpose: it is
 * deep-imported by the desktop's src/shared/relay.ts, which the RENDERER
 * bundles, and pulling in the rest of this package (crypto/primitives ->
 * @noble/*) would drag Noise crypto into that bundle for no reason. Keep it
 * dependency-free.
 */

export const MAX_RELAY_ADDRESS_LENGTH = 512;

const LOOPBACK_WS_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const PLAINTEXT_SCHEME = 'ws://';

/**
 * Strips a `:port` suffix, leaving an IPv6 literal's bracketed colons alone.
 * Null when the authority is malformed.
 *
 * The bracketed branch REJECTS rather than truncates: trimming at the ']'
 * would read `[::1]evil.com` as the host `[::1]`, handing the loopback
 * carve-out to an attacker-controlled name. After the literal, only a port
 * may follow.
 */
function hostWithoutPort(authority: string): string | null {
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket === -1) return null;
    const afterLiteral = authority.slice(closingBracket + 1);
    if (afterLiteral !== '' && !/^:[0-9]+$/.test(afterLiteral)) return null;
    return authority.slice(0, closingBracket + 1);
  }
  const portSeparator = authority.lastIndexOf(':');
  if (portSeparator === -1) return authority;
  const port = authority.slice(portSeparator + 1);
  // A non-numeric "port" is not a port, so the whole string is the host - and
  // will simply fail the loopback check.
  return /^[0-9]+$/.test(port) ? authority.slice(0, portSeparator) : authority;
}

/**
 * The host a `ws://` address actually dials, or null when it is not plaintext
 * or cannot be read as a bare authority.
 *
 * Hand-rolled rather than `new URL()` because this module is deliberately
 * dependency-free AND because the mobile app runs the same rules on Hermes,
 * whose URL implementation is partial.
 */
function plaintextRelayHost(relayAddress: string): string | null {
  if (!relayAddress.startsWith(PLAINTEXT_SCHEME)) return null;
  const afterScheme = relayAddress.slice(PLAINTEXT_SCHEME.length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  // Userinfo present: everything before the '@' is credentials, so the real
  // host is whatever follows. Rejected outright rather than parsed - a
  // loopback carve-out has no reason to carry credentials.
  if (authority.includes('@')) return null;
  const host = hostWithoutPort(authority);
  return host === null ? null : host.toLowerCase();
}

/**
 * True if the phone's pairing QR scanner will accept this relay address.
 * wss:// is always secure; ws:// is accepted only for loopback.
 *
 * The relay address arrives inside a scanned QR payload, so it is attacker
 * controllable: a crafted QR naming a plaintext host would route the whole
 * ceremony through that host, and the pairing then persists it to the trust
 * anchor for every later session. That is what the restriction prevents, and
 * it holds regardless of how strong the frames themselves are.
 *
 * Note this rule predates derivePairingSlotId() and used to be justified by
 * the pairing token being dialed verbatim as `?slot=`, which put the Noise PSK
 * in cleartext on the wire. The slot is a derived routing label now, so that
 * particular exposure is gone - the address-pinning reason above is not, which
 * is why the restriction stays.
 *
 * Parses the AUTHORITY rather than prefix-matching. Prefix matching accepted
 * `ws://127.0.0.1:8080@evil.test`: everything before an '@' is userinfo, so
 * that address dials evil.test while looking like loopback. Authority parsing
 * also subsumes the old boundary check, since `localhost.evil.com` is simply a
 * different host.
 */
export function isSecureRelayAddress(relayAddress: string): boolean {
  if (relayAddress.startsWith('wss://')) return true;
  const host = plaintextRelayHost(relayAddress);
  return host !== null && LOOPBACK_WS_HOSTS.includes(host);
}
