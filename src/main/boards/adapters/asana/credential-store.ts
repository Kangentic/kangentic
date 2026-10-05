import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from '../../shared/encrypted-secret-file';

/**
 * Personal Access Token persisted for the Asana integration. Stored globally
 * (not per-project) because the token represents the Kangentic user's Asana
 * identity, and we want a single "Connect Asana" save to work across every
 * project.
 *
 * On disk the JSON file contains only an `encrypted` field whose value is the
 * output of `encryptSecret(JSON.stringify(AsanaCredential))`
 * (boards/shared/encrypted-secret-file.ts). If safeStorage is unavailable the
 * credential is persisted in plaintext (per the sentinel contract in
 * `src/main/boards/shared/auth.ts`), so the caller must trust the local
 * filesystem in that degraded mode.
 */
export interface AsanaCredential {
  accessToken: string;
  userEmail: string;
  savedAt: string;
}

const STORE_FILENAME = 'asana-credentials.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: storePath(),
    writeSource: 'asana_credential',
    logPrefix: '[asana/credential-store]',
    noun: 'credential',
  };
}

function parseCredential(plaintext: string): AsanaCredential | null {
  const credential = JSON.parse(plaintext) as AsanaCredential;
  // Guard against legacy or malformed stored data. accessToken must be a
  // non-empty string, otherwise sending it as a Bearer header would silently
  // fail on the first Asana API call instead of surfacing "not connected".
  if (typeof credential?.accessToken !== 'string' || credential.accessToken.length === 0) return null;
  return credential;
}

export async function loadAsanaCredential(): Promise<AsanaCredential | null> {
  const file = credentialFile();
  const read = await readEncryptedSecretFile(file, parseCredential);
  if (!read) return null;
  // Written by the sync API under a key the async one does not hold, flagged
  // for re-encryption, or stored in plaintext before encryption was available
  // here (see decryptSecret). The credential in hand is good either way. The
  // rewrite skips a file a Disconnect, a 401 clear, or a new token changed
  // while this load awaited.
  if (read.shouldRewrite) await rewriteEncryptedSecretFile(file, read);
  return read.value;
}

export async function saveAsanaCredential(credential: AsanaCredential): Promise<void> {
  await writeEncryptedSecretFile(credentialFile(), JSON.stringify(credential));
}

export function clearAsanaCredential(): void {
  const filePath = storePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
