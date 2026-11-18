import fs from 'node:fs';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from './encrypted-secret-file';

/**
 * An encrypted file of sign-ins kept one per site (a Jira site, a GitLab server),
 * keyed by the site's base URL. A provider whose credential is good on one server
 * only saves through this, so a second server never signs the first one out.
 */
export interface SiteCredentialStore<Credential extends { site: string }> {
  /** Every saved sign-in, keyed by site base URL. Empty when none is saved. */
  load(): Promise<Record<string, Credential>>;
  /** Save or replace the sign-in for one site. */
  save(credential: Credential): Promise<void>;
}

interface StoredCredentials<Credential> {
  sites: Record<string, Credential>;
}

export function createSiteCredentialStore<Credential extends { site: string }>(options: {
  file: () => EncryptedSecretFile;
  /** True for an entry that can be sent as a credential. */
  isCredential: (value: unknown) => value is Credential;
}): SiteCredentialStore<Credential> {
  function parseStored(plaintext: string): StoredCredentials<Credential> | null {
    const parsed = JSON.parse(plaintext) as Partial<StoredCredentials<unknown>>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.sites !== 'object' || parsed.sites === null) return null;
    // Drop any entry that cannot be sent as a credential, rather than failing the
    // whole file: one malformed site must not sign every other site out.
    const sites: Record<string, Credential> = {};
    for (const [site, credential] of Object.entries(parsed.sites)) {
      if (options.isCredential(credential)) sites[site] = credential;
    }
    return { sites };
  }

  async function load(): Promise<Record<string, Credential>> {
    const file = options.file();
    const read = await readEncryptedSecretFile(file, parseStored);
    if (!read) return {};
    if (read.shouldRewrite) await rewriteEncryptedSecretFile(file, read);
    return read.value.sites;
  }

  /**
   * The saved sign-ins a save starts from. A file that is there but cannot be read
   * (the OS keychain refused the decrypt, the file is damaged) reads as no sites,
   * and writing one site over it would sign every other site out for good, so it
   * is copied aside first. A failed copy fails the save, and the file stays as it was.
   */
  async function loadSitesForSave(): Promise<Record<string, Credential>> {
    const file = options.file();
    const read = await readEncryptedSecretFile(file, parseStored);
    if (read) return read.value.sites;
    if (fs.existsSync(file.filePath)) {
      await fs.promises.copyFile(file.filePath, `${file.filePath}.unreadable-${Date.now()}`);
    }
    return {};
  }

  /**
   * Saves run one at a time. Each one reads the whole file, changes one site and
   * writes it back, so two overlapping saves (two connects, a connect and a
   * renewal) would otherwise each drop the other's site.
   */
  let saveChain: Promise<void> = Promise.resolve();

  function save(credential: Credential): Promise<void> {
    const pending = saveChain.then(async () => {
      const sites = await loadSitesForSave();
      sites[credential.site] = credential;
      await writeEncryptedSecretFile(options.file(), JSON.stringify({ sites } satisfies StoredCredentials<Credential>));
    });
    saveChain = pending.catch(() => undefined); // report-ok: the caller's own promise carries this save's failure; the chain only orders the next save behind it
    return pending;
  }

  return { load, save };
}
