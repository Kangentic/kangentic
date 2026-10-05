import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config/paths';
import { isGenuineEncryptionAvailable } from '../boards/shared/auth';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from '../boards/shared/encrypted-secret-file';
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
 * Stored like the Asana credential (src/main/boards/adapters/asana/credential-store.ts),
 * through the same file helper in src/main/boards/shared/encrypted-secret-file.ts:
 * a JSON envelope in PATHS.configDir whose single `encrypted` field is
 * encryptSecret(JSON.stringify(secretMaterial)). That helper and
 * isGenuineEncryptionAvailable (boards/shared/auth.ts) are generic despite living
 * under boards/.
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

const IDENTITY_FILENAME = 'mobile-bridge-identity.json';

function identityPath(): string {
  return path.join(PATHS.configDir, IDENTITY_FILENAME);
}

function identityFile(): EncryptedSecretFile {
  return {
    filePath: identityPath(),
    writeSource: 'mobile_bridge_identity',
    logPrefix: '[mobile-bridge/identity]',
    noun: 'identity',
  };
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

function parseIdentity(plaintext: string): BridgeIdentity | null {
  const stored = JSON.parse(plaintext) as StoredIdentity;
  if (typeof stored?.staticSecretKeyHex !== 'string' || stored.staticSecretKeyHex.length === 0) return null;
  return fromStored(stored);
}

export async function loadBridgeIdentity(): Promise<BridgeIdentity | null> {
  const file = identityFile();
  const read = await readEncryptedSecretFile(file, parseIdentity);
  if (!read) return null;
  // Written by the sync API under a key the async one does not hold, or flagged
  // for re-encryption (see decryptSecret). Only ever rewritten under GENUINE
  // encryption, the same bar creating an identity has to clear.
  if (read.shouldRewrite && (await isGenuineEncryptionAvailable())) {
    await rewriteEncryptedSecretFile(file, read);
  }
  return read.value;
}

async function saveBridgeIdentity(identity: BridgeIdentity): Promise<void> {
  await writeEncryptedSecretFile(identityFile(), JSON.stringify(toStored(identity)));
}

/**
 * Loads the existing identity, or generates and persists a new one.
 * Throws rather than persisting unprotected private key material when
 * genuine encryption is unavailable (no Linux secret store, or safeStorage
 * disabled) - callers should check isGenuineEncryptionAvailable() first and
 * surface a clear "secure storage unavailable" status instead of calling this
 * blindly.
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
