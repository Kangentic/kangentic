/**
 * The kangentic.com side of the browser sign-in handoff, for tests: ports of
 * `parseState` and `seal` from kangentic.com's `functions/oauth/jira/seal.ts`
 * (commit 344fb6c), run on WebCrypto as the service and the Trello return page
 * run them. They are the other side of the contract the desktop decrypts
 * against, not a copy of the code under test.
 */

const subtle = globalThis.crypto.subtle;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };

export function fromBase64Url(text: string): Uint8Array | null {
  const body = text.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) return null;
  const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(parts: Uint8Array[]): string {
  let binary = '';
  for (const part of parts) for (const byte of part) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface ServiceState {
  port: number;
  key: CryptoKey;
  nonce: string;
  salt: Uint8Array;
}

/** The service's state check, rule for rule. Null for anything it refuses with a 400. */
export async function parseState(raw: string | null): Promise<ServiceState | null> {
  if (!raw || raw.length > 1024) return null;
  const bytes = fromBase64Url(raw);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'nonce,port,pub') return null;
  const { port, pub, nonce } = value as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (typeof pub !== 'string' || typeof nonce !== 'string') return null;
  const point = fromBase64Url(pub);
  const salt = fromBase64Url(nonce);
  if (!point || point.length !== 65 || point[0] !== 0x04) return null;
  if (!salt || salt.length < 16 || salt.length > 64) return null;
  try {
    const key = await subtle.importKey('raw', point, P256, false, []);
    return { port, key, nonce, salt };
  } catch {
    return null;
  }
}

/** The service's sealing, with the info string the provider uses. */
export async function seal(plaintext: string, state: ServiceState, info: string): Promise<string> {
  const ephemeral = (await subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const shared = await subtle.deriveBits({ name: 'ECDH', public: state.key }, ephemeral.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: state.salt, info: new TextEncoder().encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const publicKey = await subtle.exportKey('raw', ephemeral.publicKey);
  return toBase64Url([new Uint8Array(publicKey), iv, new Uint8Array(ciphertext)]);
}

/**
 * The redirect the service (or the Trello return page) sends the browser on to:
 * a sealed payload, or an error code, always with the nonce from the state.
 */
export async function serviceRedirect(
  stateText: string,
  path: string,
  outcome: { plaintext: string; info: string } | { error: string; description?: string },
): Promise<string> {
  const state = await parseState(stateText);
  if (!state) throw new Error('the service would refuse this state with a 400');
  const target = new URL(`http://127.0.0.1:${state.port}${path}`);
  if ('plaintext' in outcome) {
    target.searchParams.set('payload', await seal(outcome.plaintext, state, outcome.info));
  } else {
    target.searchParams.set('error', outcome.error);
    if (outcome.description) target.searchParams.set('error_description', outcome.description);
  }
  target.searchParams.set('nonce', state.nonce);
  return target.toString();
}
