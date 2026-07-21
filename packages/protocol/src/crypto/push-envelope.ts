/**
 * E2E-encrypted push notification envelope. Push payloads transit Expo's
 * push service (and APNs/FCM under it), which must never see notification
 * content: the desktop seals every notification into an opaque blob with a
 * device-generated push key (exchanged over the already-secure bridge via
 * the register-push verb), and the phone opens it on-device (Android
 * Notifee / iOS Notification Service Extension). Every open failure
 * degrades to a generic placeholder, never to plaintext.
 *
 * Construction: XChaCha20-Poly1305 with a fresh random 24-byte nonce
 * prepended to the ciphertext, AAD bound to the RECIPIENT device's static
 * public key (so a blob sealed for one device cannot be replayed at
 * another, even if both somehow shared a push key), and the whole thing
 * base64url-encoded (no padding) to ride inside a JSON push payload.
 * Freshness is enforced at open time from the sealed-in `sentAt`:
 * a delayed replay older than 24 hours (or claiming to be from more than
 * 5 minutes in the future) is rejected.
 */
import { randomBytes, xaeadEncrypt, xaeadDecrypt, concatBytes, XCHACHA_NONCE_LENGTH, AEAD_TAG_LENGTH } from './primitives';
import { base64UrlEncode, base64UrlDecode } from '../wire/base64url';
import { isRecord } from '../wire/json-value';

export const PUSH_CATEGORIES = ['input-required', 'turn-complete', 'session-failed', 'plan-complete', 'spawn-stalled'] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === 'string' && (PUSH_CATEGORIES as readonly string[]).includes(value);
}

/** Reject an opened envelope whose sentAt is older than this (stale replay). */
export const PUSH_ENVELOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerated forward clock skew; anything claiming to be further in the future is rejected. */
export const PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * The real notification content, visible only on the sealing desktop and
 * the opening device. Everything the OS-visible push payload carries
 * instead is a static placeholder.
 */
export interface PushEnvelopePlaintext {
  category: PushCategory;
  projectId: string;
  taskId: string;
  sessionId: string;
  taskTitle: string;
  detail: string;
  /** Wall-clock ms at seal time; openPushEnvelope enforces the freshness window from it. */
  sentAt: number;
}

function requireEnvelopeString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`push envelope plaintext is missing a string "${field}"`);
  return value;
}

/** Narrows a decrypted envelope's JSON to PushEnvelopePlaintext. Throws on any malformed field. */
export function parsePushEnvelopePlaintext(value: unknown): PushEnvelopePlaintext {
  if (!isRecord(value)) throw new Error('push envelope plaintext must be an object');
  if (!isPushCategory(value.category)) throw new Error('push envelope plaintext has an unknown "category"');
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt)) {
    throw new Error('push envelope plaintext has an invalid "sentAt"');
  }
  return {
    category: value.category,
    projectId: requireEnvelopeString(value, 'projectId'),
    taskId: requireEnvelopeString(value, 'taskId'),
    sessionId: requireEnvelopeString(value, 'sessionId'),
    taskTitle: requireEnvelopeString(value, 'taskTitle'),
    detail: requireEnvelopeString(value, 'detail'),
    sentAt: value.sentAt,
  };
}

/**
 * Seals a notification into an opaque base64url blob:
 * base64url(nonce[24] || XChaCha20-Poly1305(pushKey, nonce, aad=recipientStaticPublicKey, JSON(plaintext))).
 */
export function sealPushEnvelope(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, plaintext: PushEnvelopePlaintext): string {
  const nonce = randomBytes(XCHACHA_NONCE_LENGTH);
  const encodedPlaintext = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = xaeadEncrypt(pushKey, nonce, recipientStaticPublicKey, encodedPlaintext);
  return base64UrlEncode(concatBytes(nonce, ciphertext));
}

/**
 * Opens a sealed push blob. Throws on: a malformed blob, a tampered
 * ciphertext, the wrong key, the wrong recipient key (AAD mismatch),
 * non-JSON or malformed plaintext, an unknown category, or a sentAt
 * outside the freshness window (older than 24h, or more than 5min in the
 * future). The caller (the device-side notification handler) catches and
 * shows the generic placeholder.
 */
export function openPushEnvelope(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, blob: string): PushEnvelopePlaintext {
  const bytes = base64UrlDecode(blob);
  if (bytes.length < XCHACHA_NONCE_LENGTH + AEAD_TAG_LENGTH) {
    throw new Error('push envelope blob is too short');
  }
  const nonce = bytes.subarray(0, XCHACHA_NONCE_LENGTH);
  const ciphertext = bytes.subarray(XCHACHA_NONCE_LENGTH);
  const decrypted = xaeadDecrypt(pushKey, nonce, recipientStaticPublicKey, ciphertext);
  const decoded: unknown = JSON.parse(new TextDecoder().decode(decrypted));
  const plaintext = parsePushEnvelopePlaintext(decoded);
  const now = Date.now();
  if (plaintext.sentAt < now - PUSH_ENVELOPE_MAX_AGE_MS) throw new Error('push envelope is stale');
  if (plaintext.sentAt > now + PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS) throw new Error('push envelope sentAt is in the future');
  return plaintext;
}
