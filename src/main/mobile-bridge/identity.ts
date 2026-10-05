import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config/paths';
import { decryptSecret, encryptSecret, isGenuineEncryptionAvailable } from '../boards/shared/auth';
import { safeWriteJson } from '../safe-write';
import {
  bytesToHex,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hexToBytes,
  type Ed25519KeyPair,
  type X25519KeyPair,
} from '@kangentic/protocol';

/**
 * The desktop's mobile-bridge device identity: a static X25519 keypair
 * (the Noise session/pairing identity) and an Ed25519 master signing
 * keypair (roster signing root of trust). Generated once at first use and
 * persisted globally (machine-wide, not per-project - the identity
 * represents this desktop installation, like the Asana credential).
 *
 * Mirrors src/main/boards/adapters/asana/credential-store.ts's
 * file-in-PATHS.configDir pattern: a JSON envelope whose single
 * `encrypted` field is encryptSecret(JSON.stringify(secretMaterial)).
 * Reuses encryptSecret/decryptSecret/isGenuineEncryptionAvailable from
 * src/main/boards/shared/auth.ts verbatim - they are generic string-in/
 * string-out helpers despite living under boards/.
 *
 * Unlike the Asana credential, the private key material here MUST be
 * genuinely protected: refuses to persist when isGenuineEncryptionAvailable()
 * is false (no Linux secret store, so only the hardcoded fallback key), rather
 * than falling back to encryptSecret's own degradation. A mobile bridge
 * identity that can't be protected shouldn't silently exist on disk.
 *
 * Load, save and create are async because safeStorage's async API is
 * (src/main/boards/shared/auth.ts). MobileBridgeService loads the identity once
 * when it warms up and serves its synchronous readers from that cache.
 */
export interface BridgeIdentity {
  staticKeyPair: X25519KeyPair;
  masterSigningKeyPair: Ed25519KeyPair;
  createdAt: string;
}

interface StoredIdentity {
  staticSecretKeyHex: string;
  staticPublicKeyHex: string;
  masterSigningSecretKeyHex: string;
  masterSigningPublicKeyHex: string;
  createdAt: string;
}

interface StoredShape {
  encrypted: string;
}

const IDENTITY_FILENAME = 'mobile-bridge-identity.json';

function identityPath(): string {
  return path.join(PATHS.configDir, IDENTITY_FILENAME);
}

function toStored(identity: BridgeIdentity): StoredIdentity {
  return {
    staticSecretKeyHex: bytesToHex(identity.staticKeyPair.secretKey),
    staticPublicKeyHex: bytesToHex(identity.staticKeyPair.publicKey),
    masterSigningSecretKeyHex: bytesToHex(identity.masterSigningKeyPair.secretKey),
    masterSigningPublicKeyHex: bytesToHex(identity.masterSigningKeyPair.publicKey),
    createdAt: identity.createdAt,
  };
}

function fromStored(stored: StoredIdentity): BridgeIdentity {
  return {
    staticKeyPair: { secretKey: hexToBytes(stored.staticSecretKeyHex), publicKey: hexToBytes(stored.staticPublicKeyHex) },
    masterSigningKeyPair: { secretKey: hexToBytes(stored.masterSigningSecretKeyHex), publicKey: hexToBytes(stored.masterSigningPublicKeyHex) },
    createdAt: stored.createdAt,
  };
}

export async function loadBridgeIdentity(): Promise<BridgeIdentity | null> {
  const filePath = identityPath();
  if (!fs.existsSync(filePath)) return null;
  let identity: BridgeIdentity;
  let shouldRewrite: boolean;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredShape;
    if (!parsed.encrypted) return null;
    const decrypted = await decryptSecret(parsed.encrypted);
    const stored = JSON.parse(decrypted.plaintext) as StoredIdentity;
    if (typeof stored?.staticSecretKeyHex !== 'string' || stored.staticSecretKeyHex.length === 0) return null;
    identity = fromStored(stored);
    shouldRewrite = decrypted.shouldRewrite;
  } catch (error) {
    console.warn('[mobile-bridge/identity] failed to load identity:', error);
    return null;
  }
  // Written by the sync API under a key the async one does not hold, or flagged
  // for re-encryption (see decryptSecret). Only ever rewritten under GENUINE
  // encryption, the same bar creating an identity has to clear. A failed
  // rewrite only means the same migration runs on the next load.
  if (shouldRewrite && (await isGenuineEncryptionAvailable())) {
    try {
      await saveBridgeIdentity(identity);
    } catch (error) {
      console.warn('[mobile-bridge/identity] could not rewrite the identity in the current format:', error);
    }
  }
  return identity;
}

async function saveBridgeIdentity(identity: BridgeIdentity): Promise<void> {
  const encrypted = await encryptSecret(JSON.stringify(toStored(identity)));
  const payload: StoredShape = { encrypted };
  // mode 0o600: best-effort defense-in-depth for the file holding the
  // encrypted private-key material (no-op on Windows, honored on POSIX at
  // create time). The payload is already safeStorage-encrypted; this just
  // narrows who can read the ciphertext at rest. Degrades rather than throws
  // (see safe-write.ts) - an unwritable config directory must not reject
  // pairing, and the shared write-failure-notice latch tells the user once.
  safeWriteJson(identityPath(), payload, 'mobile_bridge_identity', { mode: 0o600 });
}

/**
 * Loads the existing identity, or generates and persists a new one.
 * Throws rather than persisting unprotected private key material when
 * genuine encryption is unavailable (Linux basic_text backend) - callers
 * should check isGenuineEncryptionAvailable() first and surface a clear
 * "secure storage unavailable" status instead of calling this blindly.
 */
export async function loadOrCreateBridgeIdentity(): Promise<BridgeIdentity> {
  const existing = await loadBridgeIdentity();
  if (existing) return existing;

  if (!(await isGenuineEncryptionAvailable())) {
    throw new Error(
      'Cannot create a mobile bridge identity: secure storage is unavailable (no Linux secret store, or safeStorage disabled). Refusing to persist an unprotected private key.',
    );
  }

  const identity: BridgeIdentity = {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
  await saveBridgeIdentity(identity);
  return identity;
}

export function clearBridgeIdentity(): void {
  // rmSync with force ignores a missing file (no existsSync TOCTOU); the
  // try/catch swallows a transient Windows lock (AV/backup holding a handle)
  // so a best-effort clear never throws into the caller.
  try {
    fs.rmSync(identityPath(), { force: true });
  } catch (error) {
    console.warn('[mobile-bridge/identity] failed to clear identity:', error);
  }
}
