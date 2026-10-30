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
 *
 * An envelope may also carry `clears`: notifications the desktop saw resolve
 * since its last message to this device (see PushClearEntry). The standalone
 * clear message that carries them otherwise lives in push-clear.ts and reuses
 * this file's construction.
 */
import { randomBytes, xaeadEncrypt, xaeadDecrypt, concatBytes, XCHACHA_NONCE_LENGTH, AEAD_TAG_LENGTH } from './primitives';
import { base64UrlEncode, base64UrlDecode } from '../wire/base64url';
import { isRecord } from '../wire/json-value';
import { isPermissionWaitKindWire, type PermissionWaitKindWire } from '../events/payloads';

/**
 * Append only. `workflow-complete` (every task of a workflow reached Done) is
 * the newest; a phone that predates it reads the envelope as an unknown
 * category and shows the generic placeholder.
 */
export const PUSH_CATEGORIES = ['input-required', 'turn-complete', 'session-failed', 'plan-complete', 'spawn-stalled', 'workflow-complete'] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === 'string' && (PUSH_CATEGORIES as readonly string[]).includes(value);
}

/** Reject an opened envelope whose sentAt is older than this (stale replay). */
export const PUSH_ENVELOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerated forward clock skew; anything claiming to be further in the future is rejected. */
export const PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * What kind of session a notification is about, when it is not a task's
 * agent (protocol 0.20.0). `command-terminal`: a Command Terminal, so the tap
 * opens that terminal's screen by `sessionId` (its `taskId` names no board
 * task) and `taskTitle` carries the terminal's name.
 */
export const PUSH_SESSION_KINDS = ['command-terminal'] as const;

export type PushSessionKind = (typeof PUSH_SESSION_KINDS)[number];

export function isPushSessionKind(value: unknown): value is PushSessionKind {
  return typeof value === 'string' && (PUSH_SESSION_KINDS as readonly string[]).includes(value);
}

/**
 * One notification the desktop saw resolve: a prompt answered at the desk, a
 * session back at work, a task moved, finished, or deleted. It names the
 * notification it clears by copying `category`, `projectId`, `taskId`,
 * `sessionId` and `sessionKind` verbatim from that notification's envelope,
 * so spawn-stalled's `sessionId` is `''`.
 *
 * `notifiedAt` is the `sentAt` of the newest notification the entry clears. A
 * phone removes a displayed notification only when its category and ids match
 * AND its own envelope `sentAt` is at or before `notifiedAt`. That bound is
 * what makes delivery order irrelevant: a normal-priority clear that Doze
 * holds back can land after a fresh high-priority push for the same session
 * and category, and without the bound it would remove the new one.
 */
export interface PushClearEntry {
  category: PushCategory;
  projectId: string;
  taskId: string;
  sessionId: string;
  notifiedAt: number;
  /** Copied from the cleared envelope; absent for a task's agent. */
  sessionKind?: PushSessionKind;
}

/**
 * Narrows a decrypted `clears` array, tolerantly. A non-array yields no
 * entries. An entry with an unknown category (from a newer desktop), a
 * non-string id, or a non-finite `notifiedAt` is dropped on its own; an
 * unknown `sessionKind` is omitted; unknown fields are ignored. A bad entry
 * never costs the other entries, or the notification they ride on.
 */
export function parsePushClearEntries(value: unknown): PushClearEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PushClearEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const { category, projectId, taskId, sessionId, notifiedAt, sessionKind } = candidate;
    if (!isPushCategory(category)) continue;
    if (typeof projectId !== 'string' || typeof taskId !== 'string' || typeof sessionId !== 'string') continue;
    if (typeof notifiedAt !== 'number' || !Number.isFinite(notifiedAt)) continue;
    entries.push({
      category,
      projectId,
      taskId,
      sessionId,
      notifiedAt,
      ...(isPushSessionKind(sessionKind) ? { sessionKind } : {}),
    });
  }
  return entries;
}

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
  /** The task's title, or for a `command-terminal` session the terminal's name. */
  taskTitle: string;
  detail: string;
  /** Wall-clock ms at seal time; openPushEnvelope enforces the freshness window from it. */
  sentAt: number;
  /** Absent for a task's agent. See PUSH_SESSION_KINDS. */
  sessionKind?: PushSessionKind;
  /**
   * What an `input-required` notification's wait is for (protocol 0.26.0):
   * `question` titles it "Agent has a question", `approval` "Agent needs
   * your approval". Absent when the agent did not say, and on a workflow
   * task's notice; the category's own title ("Agent needs your input") stays
   * the fallback, and is what a phone that predates the field shows.
   */
  waitKind?: PermissionWaitKindWire;
  /**
   * A notification the user wrote, as a Notify me automation row's Title and
   * Body (protocol 0.26.0). Set together, on an `input-required` envelope
   * with an empty `sessionId`, so a tap opens the task. A phone that knows
   * them shows `title` over `body`. One that predates them shows the
   * category's title over `taskTitle - detail`, which is why `detail`
   * carries the same Body.
   */
  title?: string;
  body?: string;
  /**
   * Notifications this device should remove, riding on this one. The phone
   * applies them BEFORE presenting this envelope's own notification, so an
   * entry naming the same category and ids removes only the older alert it
   * replaces. Absent when there is nothing to clear, and only ever sent to a
   * device that registered with `acceptsClears`.
   */
  clears?: PushClearEntry[];
}

function requireEnvelopeString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`push envelope plaintext is missing a string "${field}"`);
  return value;
}

/**
 * Narrows a decrypted envelope's JSON to PushEnvelopePlaintext. Throws on any
 * malformed required field. The optional ones are dropped instead when
 * malformed or unknown (`sessionKind`, `waitKind`, `title`, `body`,
 * `clears`), so the notification still opens.
 */
export function parsePushEnvelopePlaintext(value: unknown): PushEnvelopePlaintext {
  if (!isRecord(value)) throw new Error('push envelope plaintext must be an object');
  if (!isPushCategory(value.category)) throw new Error('push envelope plaintext has an unknown "category"');
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt)) {
    throw new Error('push envelope plaintext has an invalid "sentAt"');
  }
  // Tolerant on purpose: a malformed clears list must never cost the
  // notification it rides on.
  const clears = parsePushClearEntries(value.clears);
  return {
    category: value.category,
    projectId: requireEnvelopeString(value, 'projectId'),
    taskId: requireEnvelopeString(value, 'taskId'),
    sessionId: requireEnvelopeString(value, 'sessionId'),
    taskTitle: requireEnvelopeString(value, 'taskTitle'),
    detail: requireEnvelopeString(value, 'detail'),
    sentAt: value.sentAt,
    // An unknown kind (from a newer desktop) is dropped, not rejected, so the
    // notification still opens; the tap then routes as a task's would.
    ...(isPushSessionKind(value.sessionKind) ? { sessionKind: value.sessionKind } : {}),
    // An unknown wait kind reads as an unknown wait: the category's title.
    ...(isPermissionWaitKindWire(value.waitKind) ? { waitKind: value.waitKind } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(clears.length > 0 ? { clears } : {}),
  };
}

/**
 * The construction every sealed push payload shares:
 * base64url(nonce[24] || XChaCha20-Poly1305(pushKey, nonce, aad=recipientStaticPublicKey, JSON(plaintext))).
 * Internal to the package: callers seal through sealPushEnvelope or sealPushClear.
 */
export function sealPushJson(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, plaintext: object): string {
  const nonce = randomBytes(XCHACHA_NONCE_LENGTH);
  const encodedPlaintext = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = xaeadEncrypt(pushKey, nonce, recipientStaticPublicKey, encodedPlaintext);
  return base64UrlEncode(concatBytes(nonce, ciphertext));
}

/** Decrypts a sealPushJson blob and parses its JSON, unvalidated. Throws on a short blob, a tamper, or a wrong key or AAD. */
export function openPushJson(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, blob: string, label: string): unknown {
  const bytes = base64UrlDecode(blob);
  if (bytes.length < XCHACHA_NONCE_LENGTH + AEAD_TAG_LENGTH) {
    throw new Error(`${label} blob is too short`);
  }
  const nonce = bytes.subarray(0, XCHACHA_NONCE_LENGTH);
  const ciphertext = bytes.subarray(XCHACHA_NONCE_LENGTH);
  const decrypted = xaeadDecrypt(pushKey, nonce, recipientStaticPublicKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/** Rejects a sealed `sentAt` outside the freshness window: older than 24h, or more than 5min in the future. */
export function assertPushFreshness(sentAt: number, label: string): void {
  const now = Date.now();
  if (sentAt < now - PUSH_ENVELOPE_MAX_AGE_MS) throw new Error(`${label} is stale`);
  if (sentAt > now + PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS) throw new Error(`${label} sentAt is in the future`);
}

/** Seals a notification into an opaque base64url blob (see sealPushJson for the construction). */
export function sealPushEnvelope(pushKey: Uint8Array, recipientStaticPublicKey: Uint8Array, plaintext: PushEnvelopePlaintext): string {
  return sealPushJson(pushKey, recipientStaticPublicKey, plaintext);
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
  const plaintext = parsePushEnvelopePlaintext(openPushJson(pushKey, recipientStaticPublicKey, blob, 'push envelope'));
  assertPushFreshness(plaintext.sentAt, 'push envelope');
  return plaintext;
}
