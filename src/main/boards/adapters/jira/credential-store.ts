import path from 'node:path';
import type { JiraConnectMethod, JiraDeployment } from '../../../../shared/types';
import { PATHS } from '../../../config/paths';
import type { EncryptedSecretFile } from '../../shared/encrypted-secret-file';
import { createSiteCredentialStore } from '../../shared/site-credential-store';

/**
 * One saved Jira sign-in. Jira sign-ins are per site (an API token is good on
 * every Cloud site the account can open, but a Data Center token only on its
 * own server), so the store keeps one per site base URL.
 */
export interface JiraSiteCredential {
  /** The site's base URL, the store's key. */
  site: string;
  deployment: JiraDeployment;
  method: JiraConnectMethod;
  /** Cloud API token: the Atlassian account's email. */
  email?: string;
  /** Data Center password: the Jira username. */
  username?: string;
  /** The API token, personal access token or password, or a browser sign-in's access token. */
  secret: string;
  /**
   * Browser sign-in only: the refresh token, rotated on every refresh, and when the
   * access token expires (UTC ISO 8601). Each site holds its own grant, from its own
   * sign-in, so one site's rotation never spends another's token.
   */
  refreshToken?: string;
  expiresAt?: string;
  /** Cloud: the site's id, for calls through Atlassian's API gateway. */
  cloudId?: string;
  /** Cloud: a scoped token or a browser sign-in, which only work through the gateway. */
  viaGateway?: boolean;
  /** Who signed in: an email or a username, shown in the UI. */
  account: string;
  savedAt: string;
}

const STORE_FILENAME = 'jira-credentials.json';

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: path.join(PATHS.configDir, STORE_FILENAME),
    writeSource: 'jira_credential',
    logPrefix: '[jira/credential-store]',
    noun: 'credentials',
  };
}

function isCredential(value: unknown): value is JiraSiteCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JiraSiteCredential>;
  const isBase = typeof candidate.site === 'string' && candidate.site.length > 0
    && typeof candidate.secret === 'string' && candidate.secret.length > 0
    && (candidate.deployment === 'cloud' || candidate.deployment === 'datacenter')
    && typeof candidate.method === 'string';
  if (!isBase) return false;
  if (candidate.method !== 'oauth') return true;
  // A browser sign-in cannot be renewed, or even sent, without these.
  return typeof candidate.refreshToken === 'string' && candidate.refreshToken.length > 0
    && typeof candidate.expiresAt === 'string'
    && typeof candidate.cloudId === 'string' && candidate.cloudId.length > 0;
}

const store = createSiteCredentialStore<JiraSiteCredential>({ file: credentialFile, isCredential });

/** Every saved Jira sign-in, keyed by site base URL. Empty when none is saved. */
export function loadJiraCredentials(): Promise<Record<string, JiraSiteCredential>> {
  return store.load();
}

/** Save or replace the sign-in for one site. */
export function saveJiraCredential(credential: JiraSiteCredential): Promise<void> {
  return store.save(credential);
}
