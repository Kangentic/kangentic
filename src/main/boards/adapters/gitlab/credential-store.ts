import path from 'node:path';
import { PATHS } from '../../../config/paths';
import type { EncryptedSecretFile } from '../../shared/encrypted-secret-file';
import { createSiteCredentialStore } from '../../shared/site-credential-store';

/**
 * One saved GitLab sign-in. A token or a sign-in is good on one server only
 * (gitlab.com, or one self-managed instance), so the store keeps one per server
 * base URL.
 */
export interface GitLabCredential {
  /** The server's base URL, the store's key. */
  site: string;
  /** `token`: a personal access token. `oauth`: a browser sign-in (gitlab.com). */
  method: 'token' | 'oauth';
  /** The personal access token, or the OAuth access token. */
  secret: string;
  /** OAuth only: the refresh token, replaced on every renewal. */
  refreshToken?: string;
  /** OAuth only: ISO 8601 UTC time the access token stops working. */
  expiresAt?: string;
  /** Who signed in: a GitLab username, shown in the UI. */
  account: string;
  savedAt: string;
}

const STORE_FILENAME = 'gitlab-credentials.json';

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: path.join(PATHS.configDir, STORE_FILENAME),
    writeSource: 'gitlab_credential',
    logPrefix: '[gitlab/credential-store]',
    noun: 'credentials',
  };
}

function isCredential(value: unknown): value is GitLabCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GitLabCredential>;
  return typeof candidate.site === 'string' && candidate.site.length > 0
    && typeof candidate.secret === 'string' && candidate.secret.length > 0
    && (candidate.method === 'token' || candidate.method === 'oauth');
}

const store = createSiteCredentialStore<GitLabCredential>({ file: credentialFile, isCredential });

/** Every saved GitLab sign-in, keyed by server base URL. Empty when none is saved. */
export function loadGitLabCredentials(): Promise<Record<string, GitLabCredential>> {
  return store.load();
}

/** Save or replace the sign-in for one server. */
export function saveGitLabCredential(credential: GitLabCredential): Promise<void> {
  return store.save(credential);
}

/**
 * The saved sign-in whose server a link lives on: the credential whose base URL
 * the link starts with, the longest base first (an instance under a path prefix
 * beside one at the bare origin).
 */
export function credentialForUrl(
  credentials: Record<string, GitLabCredential>,
  url: string,
): GitLabCredential | undefined {
  const lower = url.toLowerCase();
  return Object.values(credentials)
    .filter((credential) => {
      const base = credential.site.toLowerCase();
      return lower === base || lower.startsWith(`${base}/`);
    })
    .sort((first, second) => second.site.length - first.site.length)[0];
}
