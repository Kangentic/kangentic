/**
 * The QR pairing payload: a bootstrap for the pairing ceremony, never a
 * long-lived secret (Happy's `handy://<32-byte-master-secret>` is the
 * mistake this avoids). It carries only the desktop's PUBLIC key, a
 * single-use short-lived pairing token, the relay address, and the
 * protocol version. Everything is size-bounded on decode, since this is
 * the largest unauthenticated-input attack surface in the whole system
 * (a malicious QR / malicious relay-address-carrying payload) - the KDE
 * Connect CVE lesson from the research doc: minimize and size-bound
 * everything pre-auth.
 */
import { X25519_KEY_LENGTH, concatBytes } from '../crypto/primitives';
import { base64UrlDecode, base64UrlEncode } from '../wire/base64url';

export const PAIRING_URI_SCHEME = 'kangentic-pair';
const PAYLOAD_VERSION = 1;
const PAIRING_TOKEN_LENGTH = 32;
const MAX_RELAY_ADDRESS_LENGTH = 512;
/** Generous cap on the whole decoded payload - defends against a QR/URI crafted to trigger unbounded allocation before any other validation runs. */
const MAX_PAYLOAD_LENGTH = 4096;

export interface PairingQrPayload {
  desktopStaticPublicKey: Uint8Array;
  pairingToken: Uint8Array;
  relayAddress: string;
  /** ISO 8601. The pairing service is the actual enforcement point; this is carried for the phone's own UX (e.g. "this code expired"). */
  expiresAt: string;
  /**
   * The bridge protocol version (see version.ts's PROTOCOL_VERSION), so the
   * phone can surface "this desktop is running an incompatible version,
   * please update" BEFORE attempting a handshake doomed to fail, instead
   * of only an opaque authentication error. The actual downgrade
   * PROTECTION is the Noise prologue binding (crypto/pairing-handshake.ts),
   * which is enforced independent of this field; this is diagnostic only.
   */
  protocolVersion: string;
}

function writeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function encodePairingQrPayload(payload: PairingQrPayload): string {
  if (payload.desktopStaticPublicKey.length !== X25519_KEY_LENGTH) {
    throw new Error(`desktopStaticPublicKey must be ${X25519_KEY_LENGTH} bytes`);
  }
  if (payload.pairingToken.length !== PAIRING_TOKEN_LENGTH) {
    throw new Error(`pairingToken must be ${PAIRING_TOKEN_LENGTH} bytes`);
  }
  const relayAddressBytes = new TextEncoder().encode(payload.relayAddress);
  if (relayAddressBytes.length > MAX_RELAY_ADDRESS_LENGTH) {
    throw new Error(`relayAddress exceeds ${MAX_RELAY_ADDRESS_LENGTH} bytes`);
  }
  const expiresAtBytes = new TextEncoder().encode(payload.expiresAt);
  const protocolVersionBytes = new TextEncoder().encode(payload.protocolVersion);

  const body = concatBytes(
    Uint8Array.of(PAYLOAD_VERSION),
    payload.desktopStaticPublicKey,
    payload.pairingToken,
    writeUint32(relayAddressBytes.length),
    relayAddressBytes,
    writeUint32(expiresAtBytes.length),
    expiresAtBytes,
    writeUint32(protocolVersionBytes.length),
    protocolVersionBytes,
  );
  if (body.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(`Pairing QR payload exceeds ${MAX_PAYLOAD_LENGTH} bytes`);
  }
  return `${PAIRING_URI_SCHEME}://${base64UrlEncode(body)}`;
}

export function decodePairingQrPayload(uri: string): PairingQrPayload {
  const prefix = `${PAIRING_URI_SCHEME}://`;
  if (!uri.startsWith(prefix)) throw new Error('Not a kangentic pairing URI');
  const encoded = uri.slice(prefix.length);
  if (encoded.length > MAX_PAYLOAD_LENGTH * 2) {
    // base64 expands ~4/3; reject wildly-oversized input before even decoding.
    throw new Error('Pairing QR payload is too large');
  }
  const body = base64UrlDecode(encoded);
  if (body.length > MAX_PAYLOAD_LENGTH) throw new Error('Pairing QR payload is too large');
  if (body.length < 1 + X25519_KEY_LENGTH + PAIRING_TOKEN_LENGTH + 4) throw new Error('Pairing QR payload is too short');

  let offset = 0;
  const version = body[offset];
  offset += 1;
  if (version !== PAYLOAD_VERSION) throw new Error(`Unsupported pairing QR payload version: ${version}`);

  const desktopStaticPublicKey = body.subarray(offset, offset + X25519_KEY_LENGTH);
  offset += X25519_KEY_LENGTH;

  const pairingToken = body.subarray(offset, offset + PAIRING_TOKEN_LENGTH);
  offset += PAIRING_TOKEN_LENGTH;

  const relayAddressLength = readUint32(body, offset);
  offset += 4;
  if (relayAddressLength > MAX_RELAY_ADDRESS_LENGTH || offset + relayAddressLength > body.length) {
    throw new Error('Pairing QR payload has an invalid relay address length');
  }
  const relayAddress = new TextDecoder().decode(body.subarray(offset, offset + relayAddressLength));
  offset += relayAddressLength;

  if (offset + 4 > body.length) throw new Error('Pairing QR payload is missing an expiresAt length');
  const expiresAtLength = readUint32(body, offset);
  offset += 4;
  if (offset + expiresAtLength > body.length) throw new Error('Pairing QR payload has an invalid expiresAt length');
  const expiresAt = new TextDecoder().decode(body.subarray(offset, offset + expiresAtLength));
  offset += expiresAtLength;

  if (offset + 4 > body.length) throw new Error('Pairing QR payload is missing a protocol version');
  const protocolVersionLength = readUint32(body, offset);
  offset += 4;
  if (offset + protocolVersionLength > body.length) throw new Error('Pairing QR payload has an invalid protocolVersion length');
  const protocolVersion = new TextDecoder().decode(body.subarray(offset, offset + protocolVersionLength));

  return { desktopStaticPublicKey, pairingToken, relayAddress, expiresAt, protocolVersion };
}
