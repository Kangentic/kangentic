import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from '../../shared/encrypted-secret-file';

interface LinearCredentialBase {
  /** The Linear user's name, for the "connected as" line. */
  userName: string;
  /** The workspace's URL key (linear.app/<urlKey>/...), used to build team links. */
  organizationUrlKey: string;
  savedAt: string;
}

/** A personal API key pasted from Linear's Security & Access settings. Never expires. */
export interface LinearApiKeyCredential extends LinearCredentialBase {
  kind: 'api_key';
  apiKey: string;
}

/**
 * Tokens from the browser sign-in. The access token lasts 24 hours and the
 * refresh token 30 days; every refresh returns a new pair (Linear rotates them).
 */
export interface LinearOAuthCredential extends LinearCredentialBase {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  /** ISO 8601 UTC time the access token stops working. */
  expiresAt: string;
}

/**
 * The credential for the Linear integration, stored globally (not per project)
 * because it is the Kangentic user's Linear identity: one Connect works in every
 * project. On disk the file holds only `{ encrypted }` (encrypted-secret-file.ts).
 */
export type LinearCredential = LinearApiKeyCredential | LinearOAuthCredential;

const STORE_FILENAME = 'linear-credentials.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: storePath(),
    writeSource: 'linear_credential',
    logPrefix: '[linear/credential-store]',
    noun: 'credential',
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Returns null for a malformed file, so a broken store reads as "not connected".
 * A credential with no workspace URL key is malformed too: every team link the
 * picker saves is built from it, and an empty one makes a URL the parser refuses.
 */
export function parseLinearCredential(plaintext: string): LinearCredential | null {
  const parsed = JSON.parse(plaintext) as Partial<LinearApiKeyCredential> & Partial<LinearOAuthCredential>;
  if (!nonEmptyString(parsed?.organizationUrlKey)) return null;
  const base = {
    userName: typeof parsed?.userName === 'string' ? parsed.userName : '',
    organizationUrlKey: typeof parsed?.organizationUrlKey === 'string' ? parsed.organizationUrlKey : '',
    savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : '',
  };
  if (parsed?.kind === 'api_key' && nonEmptyString(parsed.apiKey)) {
    return { ...base, kind: 'api_key', apiKey: parsed.apiKey };
  }
  if (
    parsed?.kind === 'oauth'
    && nonEmptyString(parsed.accessToken)
    && nonEmptyString(parsed.refreshToken)
    && nonEmptyString(parsed.expiresAt)
  ) {
    return {
      ...base,
      kind: 'oauth',
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  }
  return null;
}

export async function loadLinearCredential(): Promise<LinearCredential | null> {
  const file = credentialFile();
  const read = await readEncryptedSecretFile(file, parseLinearCredential);
  if (!read) return null;
  // Same rewrite rule as the Asana store: re-encrypt a plaintext or flagged blob,
  // unless a sign-in, a refresh or a clear changed the file while this load awaited.
  if (read.shouldRewrite) await rewriteEncryptedSecretFile(file, read);
  return read.value;
}

export async function saveLinearCredential(credential: LinearCredential): Promise<void> {
  await writeEncryptedSecretFile(credentialFile(), JSON.stringify(credential));
}

/** Delete the stored credential. `force` makes a missing file, or a clear racing another, a no-op. */
export function clearLinearCredential(): void {
  fs.rmSync(storePath(), { force: true });
}
