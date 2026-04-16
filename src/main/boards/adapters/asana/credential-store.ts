import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths';
import { decryptSecret, encryptSecret } from '../../shared';

/**
 * Personal Access Token persisted for the Asana integration. Stored globally
 * (not per-project) because the token represents the Kangentic user's Asana
 * identity, and we want a single "Connect Asana" save to work across every
 * project.
 *
 * On disk the JSON file contains only an `encrypted` field whose value is the
 * output of `encryptSecret(JSON.stringify(AsanaCredential))`. If safeStorage
 * is unavailable the credential is persisted in plaintext (per the sentinel
 * contract in `src/main/boards/shared/auth.ts`), so the caller must trust the
 * local filesystem in that degraded mode.
 */
export interface AsanaCredential {
  accessToken: string;
  userEmail: string;
  savedAt: string;
}

interface StoredShape {
  encrypted: string;
}

const STORE_FILENAME = 'asana-credentials.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

export function loadAsanaCredential(): AsanaCredential | null {
  const filePath = storePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredShape;
    if (!parsed.encrypted) return null;
    const decrypted = decryptSecret(parsed.encrypted);
    const credential = JSON.parse(decrypted) as AsanaCredential;
    // Guard against legacy or malformed stored data. accessToken must be a
    // non-empty string, otherwise sending it as a Bearer header would silently
    // fail on the first Asana API call instead of surfacing "not connected".
    if (typeof credential?.accessToken !== 'string' || credential.accessToken.length === 0) {
      return null;
    }
    return credential;
  } catch (error) {
    console.warn('[asana/credential-store] failed to load credential:', error);
    return null;
  }
}

export function saveAsanaCredential(credential: AsanaCredential): void {
  fs.mkdirSync(PATHS.configDir, { recursive: true });
  const encrypted = encryptSecret(JSON.stringify(credential));
  const payload: StoredShape = { encrypted };
  fs.writeFileSync(storePath(), JSON.stringify(payload, null, 2));
}

export function clearAsanaCredential(): void {
  const filePath = storePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
