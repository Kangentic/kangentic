import fs from 'node:fs';
import { safeWriteJson } from '../../safe-write';
import { decryptSecret, encryptSecret } from './auth';

/**
 * A small JSON file that holds one secret as `{ "encrypted": encryptSecret(plaintext) }`.
 * The Asana token (boards/adapters/asana/credential-store.ts) and the mobile bridge
 * identity (mobile-bridge/identity.ts) are both stored this way under PATHS.configDir.
 *
 * Writes go through the guarded writer at mode 0o600. The payload is already
 * safeStorage-encrypted; the mode narrows who can read the ciphertext at rest (a no-op
 * on Windows, honored on POSIX at create time). The write degrades rather than throws
 * (safe-write.ts): an unwritable config directory must not reject "Connect Asana" or
 * pairing, and the write-failure-notice latch keyed by `writeSource` tells the user once.
 */
export interface EncryptedSecretFile {
  filePath: string;
  /** The guarded writer's failure-latch key, named for the file's purpose. */
  writeSource: string;
  /** Prefix for this file's log lines, such as '[asana/credential-store]'. */
  logPrefix: string;
  /** What the file holds, in its log lines: 'credential', 'identity'. */
  noun: string;
}

interface StoredShape {
  encrypted: string;
}

export interface ReadSecret<Value> {
  value: Value;
  /** The decrypted text, which a rewrite re-encrypts unchanged. */
  plaintext: string;
  /** The ciphertext as read, so a rewrite can tell whether anything replaced it since. */
  ciphertext: string;
  /** decryptSecret's verdict that the file is in an older format and should be rewritten. */
  shouldRewrite: boolean;
}

/**
 * Read, decrypt and parse the file. Null when it is absent or empty, when `parse`
 * rejects the value, or when reading, decrypting or parsing throws (logged).
 */
export async function readEncryptedSecretFile<Value>(
  file: EncryptedSecretFile,
  parse: (plaintext: string) => Value | null,
): Promise<ReadSecret<Value> | null> {
  if (!fs.existsSync(file.filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file.filePath, 'utf8')) as StoredShape;
    if (!parsed.encrypted) return null;
    const decrypted = await decryptSecret(parsed.encrypted);
    const value = parse(decrypted.plaintext);
    if (value === null) return null;
    return {
      value,
      plaintext: decrypted.plaintext,
      ciphertext: parsed.encrypted,
      shouldRewrite: decrypted.shouldRewrite,
    };
  } catch (error) {
    console.warn(`${file.logPrefix} failed to load ${file.noun}:`, error);
    return null;
  }
}

/** Encrypt and write. Degrades rather than throws on a failed write (see above). */
export async function writeEncryptedSecretFile(file: EncryptedSecretFile, plaintext: string): Promise<void> {
  writeStoredCiphertext(file, await encryptSecret(plaintext));
}

/**
 * Re-encrypt a secret `readEncryptedSecretFile` flagged with `shouldRewrite`, and write
 * it back only if the file still holds the ciphertext that read returned. A clear or a
 * new save that lands during the awaits wins, so the stale secret never comes back over
 * it. Never throws: a failed rewrite only means the same migration runs on the next read.
 */
export async function rewriteEncryptedSecretFile<Value>(
  file: EncryptedSecretFile,
  read: ReadSecret<Value>,
): Promise<void> {
  try {
    const encrypted = await encryptSecret(read.plaintext);
    if (readStoredCiphertext(file.filePath) === read.ciphertext) writeStoredCiphertext(file, encrypted);
  } catch (error) {
    console.warn(`${file.logPrefix} could not rewrite the ${file.noun} in the current format:`, error);
  }
}

function readStoredCiphertext(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredShape;
    return parsed.encrypted ?? null;
  } catch {
    return null;
  }
}

function writeStoredCiphertext(file: EncryptedSecretFile, encrypted: string): void {
  const payload: StoredShape = { encrypted };
  safeWriteJson(file.filePath, payload, file.writeSource, { mode: 0o600 });
}
