/**
 * Relay address resolution and validation, shared by the renderer (Mobile
 * Devices settings tab) and the main process (mobile-bridge reconcile,
 * pairing, dial). Deep-imports the dependency-free
 * @kangentic/protocol/pairing/relay-address leaf rather than the package
 * root, so the renderer bundle does not pull in the rest of the protocol
 * package's crypto (@noble/*) - see relay-address.ts's own header.
 */
import { MAX_RELAY_ADDRESS_LENGTH, isSecureRelayAddress } from '@kangentic/protocol/pairing/relay-address';
import type { AppConfig } from './types';

export const KANGENTIC_HOSTED_RELAY_URL = 'wss://relay.kangentic.com';
export const LOCAL_DEV_RELAY_URL = 'ws://127.0.0.1:8080';

export type RelayUrlValidation = { ok: true; normalized: string } | { ok: false; reason: string };

/**
 * Mirrors the phone's pairing QR scanner exactly (see
 * @kangentic/protocol/pairing/relay-address's isSecureRelayAddress), applied
 * to the NORMALIZED value rather than the raw draft. That ordering matters:
 * `new URL()` canonicalizes IPv4/IPv6 spellings (`ws://127.1` ->
 * `ws://127.0.0.1/`) before the TLS/loopback check runs, so the value that
 * passes here, gets persisted, and gets embedded in the pairing QR is always
 * the exact string the phone will independently accept. Checking the raw
 * string instead would accept encodings the phone rejects.
 */
export function validateRelayUrl(raw: string): RelayUrlValidation {
  if (raw.includes('\\')) {
    return { ok: false, reason: 'Relay address cannot contain a backslash.' };
  }
  // Byte length, not character length, to agree with the protocol package's
  // own cap (packages/protocol/src/pairing/qr.ts encodes relayAddress with
  // the same TextEncoder byte count) - a multi-byte URL that passes a
  // character-length check can still overflow the QR payload.
  if (new TextEncoder().encode(raw).length > MAX_RELAY_ADDRESS_LENGTH) {
    return { ok: false, reason: `Relay address is too long (max ${MAX_RELAY_ADDRESS_LENGTH} bytes).` };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Enter a full relay URL, e.g. wss://relay.example.com.' };
  }

  if (url.hash) {
    return { ok: false, reason: 'Relay address cannot include a #fragment; the pairing slot is carried in the query string.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Relay address cannot include a username or password.' };
  }

  const normalized = url.href;
  // Re-check the cap against the NORMALIZED value, not just the raw draft.
  // Normalization can grow the string (an authority-only URL gains a trailing
  // '/'), so a raw input at exactly the cap can normalize past it. `normalized`
  // is what gets persisted and embedded in the pairing QR, so letting an
  // over-cap value through here would both overflow the QR payload and fail
  // this same check on every later resolveRelayUrl() - silently falling back
  // to the hosted relay with no error surfaced anywhere in the UI.
  if (new TextEncoder().encode(normalized).length > MAX_RELAY_ADDRESS_LENGTH) {
    return { ok: false, reason: `Relay address is too long (max ${MAX_RELAY_ADDRESS_LENGTH} bytes).` };
  }
  if (!isSecureRelayAddress(normalized)) {
    return {
      ok: false,
      reason: 'Your phone will refuse to pair with a relay that is not using TLS. Use wss://, or ws:// only for localhost, 127.0.0.1, or [::1].',
    };
  }

  return { ok: true, normalized };
}

/**
 * The relay mode a config actually behaves as. `relayMode` missing but
 * `relayUrl` set means the value was saved under the pre-relayMode schema, so
 * it is treated as 'custom' rather than silently dropped - that inference is
 * the ONLY thing keeping an upgrading self-hoster on their own relay, since
 * DEFAULT_CONFIG deliberately does not seed a relayMode (see the comment on
 * DEFAULT_CONFIG.mobileBridge in src/shared/types.ts).
 *
 * Shared rather than duplicated on purpose: the settings tab's Select and the
 * dialer must agree on the mode, or the UI reports a relay the bridge is not
 * actually connected to.
 */
export function inferRelayMode(bridge: AppConfig['mobileBridge']): 'hosted' | 'local' | 'custom' {
  if (bridge?.relayMode) return bridge.relayMode;
  return (bridge?.relayUrl ?? '').length > 0 ? 'custom' : 'hosted';
}

/**
 * Resolves the relay URL a bridge session should actually dial. Always
 * returns a normalized, valid URL - never the stored `relayUrl` verbatim,
 * and never ''. An empty or invalid custom URL falls back to the hosted relay
 * rather than reaching a WebSocket dial.
 *
 * 'local' is gated on __KANGENTIC_DEV__ here, even though the feature itself
 * ships in production: `mobileBridge.*` is GLOBAL config in a shared
 * configDir, so a `relayMode: 'local'` value saved from a dev build (or
 * hand-edited) survives into a production build on the same machine. Without
 * this gate, a production build would silently dial plaintext loopback
 * (`ws://127.0.0.1:8080`) instead of falling back to the hosted relay - the
 * Select simply not OFFERING 'local' in production does not protect a config
 * value that predates the build that reads it.
 */
export function resolveRelayUrl(bridge: AppConfig['mobileBridge']): string {
  const storedUrl = bridge?.relayUrl ?? '';
  switch (inferRelayMode(bridge)) {
    case 'local':
      return __KANGENTIC_DEV__ ? LOCAL_DEV_RELAY_URL : KANGENTIC_HOSTED_RELAY_URL;
    case 'custom': {
      const validation = validateRelayUrl(storedUrl);
      return validation.ok ? validation.normalized : KANGENTIC_HOSTED_RELAY_URL;
    }
    case 'hosted':
    default:
      return KANGENTIC_HOSTED_RELAY_URL;
  }
}

/** ws -> http, wss -> https, path fixed to /healthz (the relay's health endpoint lives at the server root regardless of the dial path), query preserved. */
export function relayHealthUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  url.hash = '';
  return url.href;
}
