import crypto from 'node:crypto';

/**
 * The desktop half of the kangentic.com token handoff (kangentic.com
 * `functions/oauth/jira/seal.ts`, whose header pins the contract). A browser
 * sign-in that goes through kangentic.com never carries a token in the clear:
 * the service, or the Trello return page in the browser, seals it to a P-256
 * key this attempt made, and only this process can open it.
 *
 * The `state` the service reads is base64url JSON with exactly three keys,
 * `{ "port", "pub", "nonce" }`: the loopback port as a JSON integer, the
 * uncompressed public point (65 bytes, first byte 0x04), and a nonce of 16 to 64
 * bytes, the whole at most 1024 characters. A state that breaks any of these
 * gets a plain 400 on kangentic.com and never redirects back.
 *
 * Opening a payload: ECDH with the ephemeral key it carries gives 32 bytes;
 * HKDF-SHA256 over them, salted with the nonce's bytes and with the provider's
 * info string, gives the AES-256-GCM key; the payload is
 * ephemeralPub (65) || iv (12) || ciphertext, the 16-byte tag at its end.
 */

export const JIRA_SEAL_INFO = 'kangentic-jira-oauth-v1';
export const TRELLO_SEAL_INFO = 'kangentic-trello-oauth-v1';

/** The lowest loopback port the kangentic.com token service redirects to. */
export const LOWEST_SERVICE_PORT = 1024;

const NONCE_BYTES = 32;
const STATE_MAX_LENGTH = 1024;
const PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A payload that does not open: damaged, cut short, or sealed for another attempt. */
export class SealedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedPayloadError';
  }
}

/** Strict unpadded base64url, as the service writes it. Up to two trailing `=` are forgiven. */
export function decodeBase64Url(text: string): Buffer | null {
  const body = text.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) return null;
  return Buffer.from(body, 'base64url');
}

export interface SealedSignInKeys {
  /** The nonce exactly as the state carries it. */
  readonly nonce: string;
  /** The `state` for an attempt listening on `port`. */
  stateFor(port: number): string;
  /** True when a callback's `nonce` is this attempt's. Missing counts as a mismatch. */
  nonceMatches(received: string | null): boolean;
  /** The plaintext of a payload sealed to this attempt. Throws `SealedPayloadError`. */
  open(payload: string, info: string): string;
}

/** A fresh key pair and nonce for one sign-in attempt. */
export function createSealedSignInKeys(): SealedSignInKeys {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const nonceBytes = crypto.randomBytes(NONCE_BYTES);
  const nonce = nonceBytes.toString('base64url');
  const pub = publicKey.toString('base64url');

  return {
    nonce,
    stateFor(port: number): string {
      if (!Number.isInteger(port) || port < LOWEST_SERVICE_PORT || port > 65535) throw new RangeError('loopback port out of range');
      // Key order is fixed and nothing else is added: the service refuses any other key.
      const state = Buffer.from(JSON.stringify({ port, pub, nonce }), 'utf8').toString('base64url');
      if (state.length > STATE_MAX_LENGTH) throw new RangeError('sign-in state too long');
      return state;
    },
    nonceMatches(received: string | null): boolean {
      if (received === null) return false;
      const expected = Buffer.from(nonce, 'utf8');
      const actual = Buffer.from(received, 'utf8');
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    },
    open(payload: string, info: string): string {
      return openSealedPayload(payload, ecdh, nonceBytes, info);
    },
  };
}

/** What one loopback callback of a sealed sign-in carries. */
export type SealedCallback =
  | { kind: 'ignore' }
  | { kind: 'error'; code: string; description: string | null }
  | { kind: 'unopened' }
  | { kind: 'opened'; plaintext: string };

/**
 * Read a callback the token service or the Trello return page sent, in the one
 * safe order. The nonce comes first, on an error too, so a forged
 * `error=access_denied` cannot end the attempt: only the real redirect knows the
 * nonce. Then the error, then the payload. A payload that is missing or does not
 * open is `unopened`, which the provider shows as its service failing.
 */
export function readSealedCallback(
  params: URLSearchParams,
  keys: SealedSignInKeys,
  info: string,
  logPrefix: string,
): SealedCallback {
  if (!keys.nonceMatches(params.get('nonce'))) return { kind: 'ignore' };
  const code = params.get('error');
  if (code !== null) return { kind: 'error', code, description: params.get('error_description') };
  const payload = params.get('payload');
  if (!payload) return { kind: 'unopened' };
  try {
    return { kind: 'opened', plaintext: keys.open(payload, info) };
  } catch (openError) { // report-ok: open() throws only SealedPayloadError, a damaged answer the provider shows as its service failing; a throw here would escape the request handler
    console.warn(`${logPrefix} the sealed payload did not open:`, openError instanceof SealedPayloadError ? openError.name : 'unknown');
    return { kind: 'unopened' };
  }
}

function openSealedPayload(payload: string, ecdh: crypto.ECDH, salt: Buffer, info: string): string {
  const bytes = decodeBase64Url(payload);
  if (!bytes || bytes.length < PUBLIC_KEY_BYTES + IV_BYTES + TAG_BYTES) {
    throw new SealedPayloadError('sealed payload is not well formed');
  }
  const ephemeralPublicKey = bytes.subarray(0, PUBLIC_KEY_BYTES);
  const iv = bytes.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + IV_BYTES);
  const sealed = bytes.subarray(PUBLIC_KEY_BYTES + IV_BYTES);
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const shared = ecdh.computeSecret(ephemeralPublicKey);
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(info, 'utf8'), 32));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (openError) {
    // An ephemeral key off the curve, or a tag that does not verify. Rethrown as
    // one class, with no byte of the payload in it.
    throw new SealedPayloadError(`sealed payload did not open (${openError instanceof Error ? openError.name : 'unknown'})`);
  }
}
