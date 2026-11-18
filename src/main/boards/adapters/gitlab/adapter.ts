import type {
  ExternalSource,
  GitLabAuthStatus,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import { RefusalError, SignInRefusedError } from '../../../../shared/refusal';
import {
  type AdapterStatus,
  type BoardAdapter,
  type DownloadedAttachment,
  type PrerequisiteResult,
  DOWNLOAD_CONCURRENCY,
  downloadFile,
  extractInlineImageUrls,
  isSignInRenewalDue,
  mediaTypeFromFilename,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { GITLAB_MAX_PER_PAGE } from './constants';
import { GitLabClient, type GitLabNamespace } from './client';
import {
  credentialForUrl,
  loadGitLabCredentials,
  saveGitLabCredential,
  type GitLabCredential,
} from './credential-store';
import { freshCredential } from './fresh-credential';
import { GitLabHttpError, isAuthRefusal } from './gitlab-error';
import { probeGitLabServer } from './instance';
import { gitLabExternalId, mapGitLabIssues } from './mapper';
import { boardForSource, labelListsInOrder } from './status';
import {
  buildGitLabLabel,
  decodeGitLabRepository,
  encodeGitLabRepository,
  hostOf,
  isGitLabCom,
  isGitLabRepository,
  parseGitLabUrl,
  serverLabel,
  type GitLabSourceRef,
} from './url-parser';

registerSourceUrlParser('gitlab', { parse: parseGitLabUrl, buildLabel: buildGitLabLabel });

/** The line every surface shows when GitLab refuses the saved sign-in and sends no text of its own. */
const GITLAB_REJECTED_SAVED_TOKEN = 'GitLab rejected the saved token.';

/** A project or group's upload, as a full link on its server: `<base>/<path>/uploads/<secret>/<file>`. */
const UPLOAD_PATH = /^\/(.+)\/uploads\/([0-9a-f]{16,})\/([^/?#]+)$/;

export interface GitLabAdapterDependencies {
  loadCredentials: () => Promise<Record<string, GitLabCredential>>;
  saveCredential: (credential: GitLabCredential) => Promise<void>;
  fetchImpl: typeof fetch;
}

/**
 * The refusal a GitLab error becomes on a surface that shows one line: GitLab's
 * own text when it sent one. A 401 is the saved sign-in being refused, which the
 * class tells Add Source so it can offer Connect again.
 */
function refusalFrom(error: unknown): unknown {
  if (!(error instanceof GitLabHttpError)) return error;
  // The status is read here, not through `isAuthRefusal`: that guard would narrow the rest to `never`.
  if (error.status === 401) return new SignInRefusedError(error.providerMessage ?? GITLAB_REJECTED_SAVED_TOKEN);
  return new RefusalError(error.providerMessage ?? error.message);
}

/**
 * Board adapter for GitLab Issues, on gitlab.com and self-managed servers. A
 * source is a project or a group, optionally with the issue board a pasted link
 * named; sign-ins are per server (`credential-store.ts`). Import is one-shot and
 * read-only: nothing is ever written back to GitLab.
 */
export class GitLabAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'gitlab';
  readonly displayName = 'GitLab';
  readonly icon = 'square-kanban';
  readonly status: AdapterStatus = 'stable';
  readonly workItemTypeIsItemType = true;

  private readonly dependencies: GitLabAdapterDependencies;
  /** A source's project or group, read again at the start of each fetch run. */
  private readonly namespaceCache = new Map<string, GitLabNamespace>();
  /** A source board's label lists, read again at the start of each fetch run. */
  private readonly labelListsCache = new Map<string, string[]>();
  /** Project ids by `<base>|<path>`, for the uploads API. A project's id never changes. */
  private readonly projectIdCache = new Map<string, number>();

  constructor(dependencies?: Partial<GitLabAdapterDependencies>) {
    this.dependencies = {
      loadCredentials: dependencies?.loadCredentials ?? loadGitLabCredentials,
      saveCredential: dependencies?.saveCredential ?? saveGitLabCredential,
      fetchImpl: dependencies?.fetchImpl ?? fetch,
    };
  }

  // --- Sign-in ---------------------------------------------------------------

  /**
   * Whether a sign-in is saved for the server `target` names (a pasted link or a
   * saved repository). A server Kangentic has no sign-in for is asked whether it
   * runs GitLab first: one that does not is refused here, with the line the Add
   * Source popover shows, rather than opening Connect for it.
   */
  async getAuthStatus(target?: string): Promise<GitLabAuthStatus> {
    const credentials = await this.dependencies.loadCredentials();
    if (target === undefined || target.trim().length === 0) {
      return Object.keys(credentials).length > 0 ? { connected: true } : { connected: false, reason: 'none' };
    }

    const ref = decodeGitLabRepository(isGitLabRepository(target) ? target : parseGitLabUrl(target).repository);
    const credential = credentialForUrl(credentials, `${ref.base}/${ref.path}`);
    if (credential) {
      return { connected: true, site: credential.site, account: credential.account, prefill: { site: serverLabel(credential.site) } };
    }

    const probe = await probeGitLabServer(ref.base, ref.path.split('/'), this.dependencies.fetchImpl);
    if (probe.kind === 'not-gitlab') throw new RefusalError(`${hostOf(ref.base)} is not a GitLab instance.`);
    if (probe.kind === 'unreachable') throw new RefusalError(`Couldn't reach ${hostOf(ref.base)}.`);
    return { connected: false, reason: 'none', site: probe.base, prefill: { site: serverLabel(probe.base) } };
  }

  async checkPrerequisites(repository?: string): Promise<PrerequisiteResult> {
    const credentials = await this.dependencies.loadCredentials();
    if (!repository) {
      return Object.keys(credentials).length > 0
        ? { cliOk: true, authOk: true }
        : { cliOk: true, authOk: false, message: 'Not connected to GitLab.' };
    }
    const ref = decodeGitLabRepository(repository);
    const credential = credentialForUrl(credentials, `${ref.base}/${ref.path}`);
    if (!credential) return { cliOk: true, authOk: false, message: `Not connected to ${serverLabel(ref.base)}.` };
    try {
      await (await this.clientFor(credential)).currentUser();
      return { cliOk: true, authOk: true };
    } catch (error) { // report-ok: a refused sign-in is the answer the Import dialog shows; any other failure is left to the fetch that follows, which reports it
      if (isAuthRefusal(error)) {
        return { cliOk: true, authOk: false, message: error.providerMessage ?? GITLAB_REJECTED_SAVED_TOKEN };
      }
      // Anything else (the server is down, a renewal that failed on the network)
      // is not a sign-in problem: let the fetch report it with Retry.
      return { cliOk: true, authOk: true };
    }
  }

  async checkCli(repository?: string): Promise<ImportCheckCliResult> {
    return prerequisiteToCheckCli(await this.checkPrerequisites(repository));
  }

  /**
   * Renew every saved browser sign-in that is due, so one nobody imports from
   * does not go stale. A personal access token and a recent sign-in are left
   * alone. A renewal GitLab refuses changes nothing here: the next Import shows
   * it and offers Connect. Every server is tried before a failure nobody
   * expected is thrown.
   */
  async keepSignInAlive(now: number = Date.now()): Promise<void> {
    const credentials = await this.dependencies.loadCredentials();
    let unexpected: unknown;
    for (const credential of Object.values(credentials)) {
      if (credential.method !== 'oauth' || !isSignInRenewalDue(credential.savedAt, now)) continue;
      try {
        await freshCredential(
          credential,
          { fetchImpl: this.dependencies.fetchImpl, save: this.dependencies.saveCredential, now: () => now },
          { force: true },
        );
      } catch (error) { // report-ok: a refused sign-in is the next Import's to show; anything else is thrown below, once every server was tried
        if (isAuthRefusal(error)) continue;
        unexpected ??= error;
      }
    }
    if (unexpected !== undefined) throw unexpected;
  }

  /** A client for the credential, renewing a browser sign-in that is about to lapse. */
  private async clientFor(credential: GitLabCredential): Promise<GitLabClient> {
    const current = await freshCredential(credential, { fetchImpl: this.dependencies.fetchImpl, save: this.dependencies.saveCredential });
    return new GitLabClient(current, this.dependencies.fetchImpl);
  }

  /** The saved sign-in for a source's server, or the refusal that says there is none. */
  private async credentialFor(ref: GitLabSourceRef): Promise<GitLabCredential> {
    const credentials = await this.dependencies.loadCredentials();
    const credential = credentials[ref.base] ?? credentialForUrl(credentials, `${ref.base}/${ref.path}`);
    if (!credential) throw new RefusalError(`Not connected to ${serverLabel(ref.base)}.`);
    return credential;
  }

  // --- Sources ---------------------------------------------------------------

  /**
   * Check a pasted source against GitLab and name it. The link's path is read
   * relative to the server's real base (an instance under a path prefix), then
   * asked of GitLab as a project and as a group. A board link's board must be on
   * that project or group. Each refusal is the popover's error line.
   */
  async prepareSource(repository: string): Promise<{ label: string; repository: string; scopeKind: 'project' | 'group'; host?: string }> {
    const lexical = decodeGitLabRepository(repository);
    const credentials = await this.dependencies.loadCredentials();
    const linkUrl = `${lexical.base}/${lexical.path}`;
    const credential = credentialForUrl(credentials, linkUrl);
    if (!credential) throw new RefusalError(`Not connected to ${serverLabel(lexical.base)}.`);

    const base = credential.site;
    const path = linkUrl.slice(base.length + 1);
    if (path.length === 0) throw new RefusalError('Paste a GitLab project, group or board link.');

    const client = await this.clientFor(credential);
    let namespace: GitLabNamespace | null;
    try {
      namespace = await client.resolveNamespace(path);
    } catch (error) {
      throw refusalFrom(error);
    }
    if (!namespace) throw new RefusalError(`No project or group ${path} that this account can open.`);

    if (lexical.board) {
      try {
        await client.board(namespace, lexical.board);
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404) {
          throw new RefusalError(`No board ${lexical.board} in ${namespace.fullPath}.`);
        }
        throw refusalFrom(error);
      }
    }

    return {
      label: namespace.fullPath,
      repository: encodeGitLabRepository({ base, path: namespace.fullPath, board: lexical.board }),
      scopeKind: namespace.kind,
      host: isGitLabCom(base) ? undefined : serverLabel(base),
    };
  }

  // --- Fetching --------------------------------------------------------------

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const ref = decodeGitLabRepository(input.repository);
    const credential = await this.credentialFor(ref);
    try {
      const client = await this.clientFor(credential);
      const startsRun = input.page === 1;
      const namespace = await this.namespaceFor(client, input.repository, ref, startsRun);
      const labelLists = await this.labelListsFor(client, input.repository, namespace, ref.board, startsRun);
      const page = await client.issuesPage(namespace, {
        page: input.page,
        perPage: Math.min(Math.max(1, input.perPage), GITLAB_MAX_PER_PAGE),
        updatedAfter: input.since,
      });
      const alreadyImported = findAlreadyImported('gitlab', page.issues.map((issue) => gitLabExternalId(client.base, issue.id)));
      const issues = mapGitLabIssues(page.issues, { base: client.base, scopeKind: namespace.kind, labelLists, alreadyImported });
      return { issues, totalCount: issues.length, hasNextPage: page.hasNextPage };
    } catch (error) {
      throw refusalFrom(error);
    }
  }

  /** A source's project or group, read once per fetch run (`fresh` on its first page). */
  private async namespaceFor(
    client: GitLabClient,
    repository: string,
    ref: GitLabSourceRef,
    fresh: boolean,
  ): Promise<GitLabNamespace> {
    const cached = this.namespaceCache.get(repository);
    if (cached && !fresh) return cached;
    const namespace = await client.resolveNamespace(ref.path);
    if (!namespace) throw new RefusalError(`No project or group ${ref.path} that this account can open.`);
    this.namespaceCache.set(repository, namespace);
    return namespace;
  }

  /** The source board's label lists, read once per fetch run. A source with no board, or none this account can read, has none. */
  private async labelListsFor(
    client: GitLabClient,
    repository: string,
    namespace: GitLabNamespace,
    savedBoardId: string | undefined,
    fresh: boolean,
  ): Promise<string[]> {
    const cached = this.labelListsCache.get(repository);
    if (cached && !fresh) return cached;
    let lists: string[] = [];
    try {
      lists = labelListsInOrder(boardForSource(await client.boards(namespace), savedBoardId));
    } catch (error) {
      // A server or tier that does not serve boards to this account shows Open and Closed only.
      if (!(error instanceof GitLabHttpError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
    this.labelListsCache.set(repository, lists);
    return lists;
  }

  // --- Import ----------------------------------------------------------------

  /**
   * Download the images in an imported issue's description. A link to an upload
   * on a server Kangentic holds a sign-in for downloads through GitLab's uploads
   * API (GitLab 17.4 and later) with that server's sign-in, because the plain
   * upload link does not accept a token. The sign-in goes to its own server
   * only. A download that fails (an older server, a deleted upload) leaves the
   * link in the description and counts as skipped. Any other image downloads as
   * it does for every provider, with no sign-in.
   */
  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const refs = extractInlineImageUrls(markdownBody);
    if (refs.length === 0) return { attachments: [], skippedCount: 0 };
    const credentials = await this.dependencies.loadCredentials();

    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (let batchStart = 0; batchStart < refs.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = refs.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.all(batch.map((ref) => this.downloadImage(ref.url, ref.filename, credentials)));
      for (const result of results) {
        if (result) attachments.push(result);
        else skippedCount++;
      }
    }
    return { attachments, skippedCount };
  }

  private async downloadImage(
    url: string,
    filename: string,
    credentials: Record<string, GitLabCredential>,
  ): Promise<DownloadedAttachment | null> {
    const credential = credentialForUrl(credentials, url);
    const upload = credential ? UPLOAD_PATH.exec(url.slice(credential.site.length)) : null;
    if (!credential || !upload) {
      const plain = await downloadFile(url, filename);
      return plain ? { ...plain, mediaType: mediaTypeFromFilename(filename) } : null;
    }

    const [, projectPath, secret, file] = upload;
    let client: GitLabClient;
    let projectId: number;
    try {
      client = await this.clientFor(credential);
      projectId = await this.projectIdFor(client, projectPath);
    } catch (error) { // report-ok: an upload whose project cannot be read (deleted, no access, a lapsed sign-in) stays a link in the description and is counted as skipped
      console.warn('[gitlab/adapter] upload project unavailable; keeping the link', error instanceof Error ? error.name : 'unknown');
      return null;
    }
    const apiUrl = `${client.base}/api/v4/projects/${projectId}/uploads/${secret}/${file}`;
    const downloaded = await downloadFile(apiUrl, filename, { headers: client.authorizationHeaders() });
    // The API serves every upload as octet-stream, so the type comes from the file name.
    return downloaded ? { ...downloaded, mediaType: mediaTypeFromFilename(filename), sourceUrl: url } : null;
  }

  private async projectIdFor(client: GitLabClient, projectPath: string): Promise<number> {
    const cacheKey = `${client.base}|${projectPath}`;
    const cached = this.projectIdCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const projectId = await client.projectId(projectPath);
    this.projectIdCache.set(cacheKey, projectId);
    return projectId;
  }
}
