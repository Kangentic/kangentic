/**
 * Sealed push clears: the desktop telling a device that notifications it
 * already sent have resolved (a prompt answered at the desk, a session back
 * at work, a task moved, finished, or deleted), so the phone can remove them
 * from the lock screen before the user ever opens the app.
 *
 * Same construction as push-envelope.ts: XChaCha20-Poly1305 under the
 * device's push key, AAD = the recipient's static public key, base64url, and
 * the same `sentAt` freshness window. A clear rides under a different data key
 * than a notification (`data.clear`, not `data.blob`), so a phone tells the
 * two apart BEFORE decrypting anything. That matters because an older app
 * shows the generic placeholder for any `data.blob` it cannot open; a clear
 * delivered there would become a new notification. The desktop also sends
 * clears only to a device that registered with `acceptsClears`.
 *
 * One key and one AAD seal both kinds, with no label telling them apart
 * inside the ciphertext, and that is deliberate. A clear moved into
 * `data.blob` fails the envelope parse and shows the placeholder, which
 * anyone holding the push token can already cause by sending junk. An
 * envelope moved into `data.clear` either fails the clear parse or applies
 * clears the desktop really sealed. Neither gives Expo, FCM or APNs anything
 * new, and keeping the AAD lets the iOS Notification Service Extension open
 * piggybacked clears with the code it already has.
 */
import { isRecord } from '../wire/json-value';
import { AEAD_TAG_LENGTH, XCHACHA_NONCE_LENGTH } from './primitives';
import {
  assertPushFreshness,
  openPushJson,
  parsePushClearEntries,
  sealPushJson,
  type PushClearEntry,
} from './push-envelope';

/** The push payload data key a sealed notification envelope rides under. */
export const PUSH_ENVELOPE_DATA_KEY = 'blob';
/** The push payload data key a sealed clear rides under; its presence is what marks a message as a clear. */
export const PUSH_CLEAR_DATA_KEY = 'clear';

/** A standalone clear message: no notification of its own, just what to remove. */
export interface PushClearPlaintext {
  clears: PushClearEntry[];
  /** Wall-clock ms at seal time; openPushClear enforces the freshness window from it. */
  sentAt: number;
}

/**
 * Narrows a decrypted clear's JSON to PushClearPlaintext. Throws when the
 * message itself is malformed (not an object, `clears` not an array, a bad
 * `sentAt`); a malformed entry inside `clears` is dropped on its own (see
 * parsePushClearEntries).
 */
export function parsePushClearPlaintext(value: unknown): PushClearPlaintext {
  if (!isRecord(value)) throw new Error('push clear plaintext must be an object');
  if (!Array.isArray(value.clears)) throw new Error('push clear plaintext has no "clears" array');
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt)) {
    throw new Error('push clear plaintext has an invalid "sentAt"');
  }
  return { clears: parsePushClearEntries(value.clears), sentAt: value.sentAt };
}

/** Seals a clear message into an opaque base64url blob, for the `data.clear` key. */
export function sealPushClear(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, plaintext: PushClearPlaintext): string {
  return sealPushJson(pushKey, recipientStaticPublicKey, plaintext);
}

/**
 * Opens a sealed clear. Throws on everything openPushEnvelope throws on (a
 * malformed or tampered blob, the wrong key or recipient, a stale or future
 * `sentAt`) and on a malformed message. The device-side caller catches and
 * does nothing: a clear that cannot be opened never displays anything.
 */
export function openPushClear(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, blob: string): PushClearPlaintext {
  const plaintext = parsePushClearPlaintext(openPushJson(pushKey, recipientStaticPublicKey, blob, 'push clear'));
  assertPushFreshness(plaintext.sentAt, 'push clear');
  return plaintext;
}

/**
 * The length of the base64url blob sealing `plaintext` would produce:
 * 24 bytes of nonce, the UTF-8 JSON, and the 16-byte tag, base64url-encoded
 * without padding. Lets a sender fit a message under a push payload limit
 * without sealing it first.
 */
export function sealedPushBlobLength(plaintext: object): number {
  const byteLength = XCHACHA_NONCE_LENGTH + new TextEncoder().encode(JSON.stringify(plaintext)).length + AEAD_TAG_LENGTH;
  return Math.ceil((byteLength * 4) / 3);
}
