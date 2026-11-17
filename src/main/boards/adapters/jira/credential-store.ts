import path from 'node:path';
import type { JiraConnectMethod, JiraDeployment } from '../../../../shared/types';
import { PATHS } from '../../../config/paths';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from '../../shared/encrypted-secret-file';

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
  /** The API token, personal access token or password. */
  secret: string;
  /** Cloud: the site's id, for calls through Atlassian's API gateway. */
  cloudId?: string;
  /** Cloud: a scoped token, which only works through the gateway. */
  viaGateway?: boolean;
  /** Who signed in: an email or a username, shown in the UI. */
  account: string;
  savedAt: string;
}

interface StoredCredentials {
  sites: Record<string, JiraSiteCredential>;
}

const STORE_FILENAME = 'jira-credentials.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: storePath(),
    writeSource: 'jira_credential',
    logPrefix: '[jira/credential-store]',
    noun: 'credentials',
  };
}

function isCredential(value: unknown): value is JiraSiteCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JiraSiteCredential>;
  return typeof candidate.site === 'string' && candidate.site.length > 0
    && typeof candidate.secret === 'string' && candidate.secret.length > 0
    && (candidate.deployment === 'cloud' || candidate.deployment === 'datacenter')
    && typeof candidate.method === 'string';
}

function parseStored(plaintext: string): StoredCredentials | null {
  const parsed = JSON.parse(plaintext) as Partial<StoredCredentials>;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.sites !== 'object' || parsed.sites === null) return null;
  // Drop any entry that cannot be sent as a credential, rather than failing the
  // whole file: one malformed site must not sign every other site out.
  const sites: Record<string, JiraSiteCredential> = {};
  for (const [site, credential] of Object.entries(parsed.sites)) {
    if (isCredential(credential)) sites[site] = credential;
  }
  return { sites };
}

/** Every saved Jira sign-in, keyed by site base URL. Empty when none is saved. */
export async function loadJiraCredentials(): Promise<Record<string, JiraSiteCredential>> {
  const file = credentialFile();
  const read = await readEncryptedSecretFile(file, parseStored);
  if (!read) return {};
  if (read.shouldRewrite) await rewriteEncryptedSecretFile(file, read);
  return read.value.sites;
}

/**
 * Saves run one at a time. Each one reads the whole file, changes one site and
 * writes it back, so two overlapping connects would otherwise each drop the
 * other's site.
 */
let saveChain: Promise<void> = Promise.resolve();

/** Save or replace the sign-in for one site. */
export function saveJiraCredential(credential: JiraSiteCredential): Promise<void> {
  const save = saveChain.then(async () => {
    const sites = await loadJiraCredentials();
    sites[credential.site] = credential;
    await writeEncryptedSecretFile(credentialFile(), JSON.stringify({ sites } satisfies StoredCredentials));
  });
  saveChain = save.catch(() => undefined); // report-ok: the caller's own promise carries this save's failure; the chain only orders the next save behind it
  return save;
}
