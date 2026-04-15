import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths';
import { decryptSecret, encryptSecret } from '../../shared';

/**
 * Persists the user-supplied Asana OAuth app credentials (client_id AND
 * client_secret) in the global config directory.
 *
 * Asana's OAuth `/-/oauth_token` endpoint rejects PKCE-only requests with
 * 401 `invalid_client`; confidential-client auth is required. We therefore
 * collect both values from the user via the setup wizard and encrypt the
 * whole blob through `safeStorage` before writing to disk.
 *
 * Separate from `asana-credentials.json` because lifecycles differ:
 *   - app credentials are set once per install (or when the user reconfigures)
 *   - session credentials (access/refresh tokens) rotate on every refresh
 */

export interface AsanaAppCredentials {
  clientId: string;
  clientSecret: string;
}

interface StoredShape {
  encrypted: string;
}

const STORE_FILENAME = 'asana-app.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

export function loadAsanaAppCredentials(): AsanaAppCredentials | null {
  const filePath = storePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as StoredShape;
    if (!parsed.encrypted) return null;
    const decrypted = decryptSecret(parsed.encrypted);
    const creds = JSON.parse(decrypted) as AsanaAppCredentials;
    if (!creds.clientId || !creds.clientSecret) return null;
    return creds;
  } catch (error) {
    console.warn('[asana/app-config-store] failed to load app credentials:', error);
    return null;
  }
}

export function saveAsanaAppCredentials(credentials: AsanaAppCredentials): void {
  const clientId = credentials.clientId.trim();
  const clientSecret = credentials.clientSecret.trim();
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error('Both Client ID and Client Secret are required.');
  }
  fs.mkdirSync(PATHS.configDir, { recursive: true });
  const encrypted = encryptSecret(JSON.stringify({ clientId, clientSecret }));
  const payload: StoredShape = { encrypted };
  fs.writeFileSync(storePath(), JSON.stringify(payload, null, 2));
}

export function clearAsanaAppCredentials(): void {
  const filePath = storePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
