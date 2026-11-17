import type {
  ExternalSource,
  JiraAuthStatus,
  ImportCheckCliResult,
  ImportExecuteInput,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import {
  type AdapterStatus,
  type BoardAdapter,
  type DownloadedAttachment,
  type FileAttachmentRef,
  type PrerequisiteResult,
  downloadFile,
  extractInlineImageUrls,
  formatCommentsSection,
  mediaTypeFromFilename,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { RefusalError } from '../../../../shared/refusal';
import { JiraClient, JiraHttpError, type JiraCommentRaw, type JiraPage } from './client';
import { loadJiraCredentials, type JiraSiteCredential } from './credential-store';
import { withUpdatedSince } from './jql';
import { mapBoardColumns, mapJiraIssues, type JiraBoardColumn } from './mapper';
import { siteLabel } from './site';
import {
  buildJiraLabel,
  decodeJiraRepository,
  encodeJiraRepository,
  isJiraRepository,
  parseJiraInput,
  type JiraSourceRef,
} from './url-parser';

registerSourceUrlParser('jira', { parse: parseJiraInput, buildLabel: buildJiraLabel });

/** The line every surface shows when Jira refuses the saved sign-in. */
export const JIRA_REJECTED_SAVED_TOKEN = 'Jira rejected the saved token.';

/** How many issues' comments are fetched at once at import time. */
const COMMENT_CONCURRENCY = 4;
/** Page size for the ids-only listing the reconcile prunes against. */
const ID_PAGE_SIZE = 1000;

interface JiraAdapterDeps {
  loadCredentials: () => Promise<Record<string, JiraSiteCredential>>;
  fetchImpl: typeof fetch;
}

/**
 * Board adapter for Jira Cloud and Data Center. A source is a board, a project,
 * a saved filter or a JQL query on one site (`url-parser.ts`); sign-ins are per
 * site (`credential-store.ts`). Import is one-shot: nothing is ever written back
 * to Jira.
 */
export class JiraAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'jira';
  readonly displayName = 'Jira';
  readonly icon = 'layers';
  readonly status: AdapterStatus = 'stable';
  readonly workItemTypeIsItemType = true;

  private readonly deps: JiraAdapterDeps;
  /** Cloud search cursors, per query: page number to the token that fetches it. */
  private readonly cursorCache = new Map<string, Map<number, string>>();
  /** Offset-paged listings, per query: page number to the offset it starts at. */
  private readonly offsetCache = new Map<string, Map<number, number>>();
  /** The signed-in user's Jira time zone per site, for JQL date comparisons, read again at the start of each fetch run. */
  private readonly timeZoneCache = new Map<string, string | undefined>();
  /** A saved filter's JQL, read again at the start of each fetch run. */
  private readonly filterJqlCache = new Map<string, string>();
  /** A board's columns, read again at the start of each fetch run. */
  private readonly boardColumnsCache = new Map<string, JiraBoardColumn[]>();

  constructor(deps?: Partial<JiraAdapterDeps>) {
    this.deps = {
      loadCredentials: deps?.loadCredentials ?? loadJiraCredentials,
      fetchImpl: deps?.fetchImpl ?? fetch,
    };
  }

  // --- Sign-in ---------------------------------------------------------------

  /**
   * Whether a sign-in is saved for the site `target` names (a pasted link, typed
   * JQL, or a saved repository). Served by `boards:jira:authStatus`; Jira-only,
   * since Asana's and Linear's sign-ins are one per account.
   */
  async getAuthStatus(target?: string): Promise<JiraAuthStatus> {
    const credentials = await this.deps.loadCredentials();
    const sites = Object.keys(credentials);
    if (target === undefined || target.trim().length === 0) {
      return sites.length > 0 ? { connected: true } : { connected: false, reason: 'none' };
    }

    let ref: JiraSourceRef;
    try {
      ref = decodeJiraRepository(isJiraRepository(target) ? target : parseJiraInput(target).repository);
    } catch { // report-ok: text that is no Jira source has no site to sign in to; the add reports the parse error itself
      return { connected: sites.length > 0 };
    }

    if (ref.site.length === 0) {
      // Typed JQL names no site: it runs on the one connected site.
      if (sites.length === 1) return this.connectedStatus(credentials[sites[0]]);
      if (sites.length === 0) return { connected: false, reason: 'none' };
      return { connected: false, reason: 'ambiguous-site' };
    }

    const credential = credentials[ref.site];
    if (!credential) return { connected: false, reason: 'none', site: ref.site, prefill: { site: siteLabel(ref.site) } };
    return this.connectedStatus(credential);
  }

  private connectedStatus(credential: JiraSiteCredential): JiraAuthStatus {
    return {
      connected: true,
      site: credential.site,
      account: credential.account,
      prefill: {
        site: siteLabel(credential.site),
        method: credential.method,
        email: credential.email,
        username: credential.username,
      },
    };
  }

  async checkPrerequisites(repository?: string): Promise<PrerequisiteResult> {
    const credentials = await this.deps.loadCredentials();
    if (!repository) {
      return Object.keys(credentials).length > 0
        ? { cliOk: true, authOk: true }
        : { cliOk: true, authOk: false, message: 'Not connected to Jira.' };
    }
    const ref = decodeJiraRepository(repository);
    const credential = credentials[ref.site];
    if (!credential) return { cliOk: true, authOk: false, message: `Not connected to ${siteLabel(ref.site)}.` };
    try {
      await new JiraClient(credential, this.deps.fetchImpl).myself();
      return { cliOk: true, authOk: true };
    } catch (error) { // report-ok: a refused or unreachable check is an answer the Import dialog shows, not a defect
      if (error instanceof JiraHttpError && error.status === 401) {
        return { cliOk: true, authOk: false, message: JIRA_REJECTED_SAVED_TOKEN };
      }
      // Anything else (the site is down, a proxy) is not a sign-in problem: let
      // the fetch report its own error with Retry rather than offer Connect.
      return { cliOk: true, authOk: true };
    }
  }

  async checkCli(repository?: string): Promise<ImportCheckCliResult> {
    return prerequisiteToCheckCli(await this.checkPrerequisites(repository));
  }

  private async clientFor(site: string): Promise<JiraClient> {
    const credentials = await this.deps.loadCredentials();
    const credential = credentials[site];
    if (!credential) throw new RefusalError(`Not connected to ${siteLabel(site)}.`);
    return new JiraClient(credential, this.deps.fetchImpl);
  }

  // --- Sources ---------------------------------------------------------------

  /**
   * Check a parsed source against Jira and name it. Typed JQL gains the one
   * connected site here. Each refusal is the popover's error line.
   */
  async prepareSource(repository: string): Promise<{ label: string; repository: string }> {
    let ref = decodeJiraRepository(repository);
    if (ref.site.length === 0) {
      const sites = Object.keys(await this.deps.loadCredentials());
      if (sites.length === 0) throw new RefusalError('Not connected to Jira.');
      if (sites.length > 1) throw new RefusalError('Paste a search link so the site is known.');
      ref = { ...ref, site: sites[0] };
    }
    const client = await this.clientFor(ref.site);
    const completed = encodeJiraRepository(ref);

    try {
      switch (ref.kind) {
        case 'board': {
          const board = await client.board(ref.value);
          return { label: board.name?.trim() || `Board ${ref.value}`, repository: completed };
        }
        case 'project': {
          const project = await client.project(ref.value);
          return { label: project.name?.trim() || ref.value, repository: completed };
        }
        case 'filter': {
          const filter = await client.filter(ref.value);
          return { label: filter.name?.trim() || `Filter ${ref.value}`, repository: completed };
        }
        case 'jql': {
          await client.search(ref.value, { maxResults: 1, fields: 'id' });
          return { label: ref.value, repository: completed };
        }
      }
    } catch (error) {
      throw this.sourceRefusal(error, ref, client);
    }
  }

  /** The popover line for a failed source check, or the error itself when it is not one Jira explains. */
  private sourceRefusal(error: unknown, ref: JiraSourceRef, client: JiraClient): unknown {
    if (!(error instanceof JiraHttpError)) return error;
    const { status } = error;
    if (status === 401) {
      // The token passed Connect, so a 401 on the board API alone is a scoped
      // token missing the board scopes; on anything else the token died.
      return new RefusalError(ref.kind === 'board' && client.apiBase !== client.site
        ? "This token's scopes can't read boards."
        : JIRA_REJECTED_SAVED_TOKEN);
    }
    if (ref.kind === 'board' && status === 403) {
      return new RefusalError('This account has no Jira Software access.');
    }
    if (status === 404 || (ref.kind === 'filter' && status === 400)) {
      const noun = ref.kind === 'board' ? 'board' : ref.kind === 'filter' ? 'filter' : 'project';
      return new RefusalError(`No ${noun} ${ref.value} that this account can open.`);
    }
    if (ref.kind === 'jql' && status === 400) {
      const message = error.jiraMessage ?? '';
      if (/unbounded/i.test(message)) return new RefusalError("Jira won't run JQL with no search condition.");
      return new RefusalError(message || error.message);
    }
    return new RefusalError(error.jiraMessage ?? error.message);
  }

  // --- Fetching --------------------------------------------------------------

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const ref = decodeJiraRepository(input.repository);
    const client = await this.clientFor(ref.site);
    try {
      const { page, boardColumns } = await this.fetchPage(client, ref, input);
      const alreadyImported = findAlreadyImported('jira', page.issues.map((issue) => issue.id));
      const issues = mapJiraIssues(page.issues, { site: ref.site, boardColumns, alreadyImported });
      return { issues, totalCount: page.total ?? issues.length, hasNextPage: this.hasNextPage(page) };
    } catch (error) {
      if (error instanceof JiraHttpError && error.status === 401) throw new RefusalError(JIRA_REJECTED_SAVED_TOKEN);
      if (error instanceof JiraHttpError) throw new RefusalError(error.jiraMessage ?? error.message);
      throw error;
    }
  }

  private hasNextPage(page: JiraPage): boolean {
    if (page.nextPageToken !== undefined || page.isLast !== undefined) {
      return page.isLast === false && typeof page.nextPageToken === 'string';
    }
    // An empty page ends the run even when the total says more: the next page
    // would start at the same offset and come back empty again.
    if (page.issues.length === 0) return false;
    return typeof page.total === 'number' && (page.startAt ?? 0) + page.issues.length < page.total;
  }

  private async fetchPage(
    client: JiraClient,
    ref: JiraSourceRef,
    input: ImportFetchInput,
  ): Promise<{ page: JiraPage; boardColumns?: JiraBoardColumn[] }> {
    const startsRun = input.page === 1;
    const timeZone = input.since ? await this.timeZoneFor(client, startsRun) : undefined;
    if (ref.kind === 'board') {
      const boardColumns = await this.boardColumnsFor(client, ref.value, startsRun);
      const narrowing = withUpdatedSince('', input.since, timeZone);
      const page = await this.offsetPage(`${client.site}|board|${ref.value}|${narrowing}`, input, (startAt) =>
        client.boardIssues(ref.value, { startAt, maxResults: input.perPage, jql: narrowing || undefined }));
      return { page, boardColumns: boardColumns.length > 0 ? boardColumns : undefined };
    }

    const jql = withUpdatedSince(await this.sourceJql(client, ref, startsRun), input.since, timeZone);
    if (!client.isCloud) {
      return {
        page: await this.offsetPage(`${client.site}|${jql}`, input, (startAt) =>
          client.search(jql, { maxResults: input.perPage, startAt })),
      };
    }

    // Cloud pages by cursor only, while the reconcile asks for page numbers, so
    // remember each page's token as it arrives.
    const cacheKey = `${client.site}|${jql}`;
    const cursors = pageStarts(this.cursorCache, cacheKey);
    const nextPageToken = startsRun ? undefined : cursors.get(input.page);
    if (!startsRun && !nextPageToken) {
      throw new RefusalError(`Jira page ${input.page} was asked for before page ${input.page - 1}.`);
    }
    const page = await client.search(jql, { maxResults: input.perPage, nextPageToken });
    if (page.nextPageToken) cursors.set(input.page + 1, page.nextPageToken);
    if (!this.hasNextPage(page)) this.cursorCache.delete(cacheKey);
    return { page };
  }

  /**
   * One page of an offset-paged listing, by page number. Jira caps a page below
   * the size asked for when it wants to (the agile API, a Data Center search
   * limit), so each page starts where the one before it ended, never at
   * `(page - 1) * perPage`, which would skip the issues in between.
   */
  private async offsetPage(
    cacheKey: string,
    input: ImportFetchInput,
    fetchAt: (startAt: number) => Promise<JiraPage>,
  ): Promise<JiraPage> {
    const starts = pageStarts(this.offsetCache, cacheKey);
    const startAt = input.page === 1 ? 0 : starts.get(input.page);
    if (startAt === undefined) {
      throw new RefusalError(`Jira page ${input.page} was asked for before page ${input.page - 1}.`);
    }
    const page = { ...(await fetchAt(startAt)), startAt };
    starts.set(input.page + 1, startAt + page.issues.length);
    if (!this.hasNextPage(page)) this.offsetCache.delete(cacheKey);
    return page;
  }

  /** A board's columns, read once per fetch run (`fresh` on its first page). */
  private async boardColumnsFor(client: JiraClient, boardId: string, fresh: boolean): Promise<JiraBoardColumn[]> {
    const cacheKey = `${client.site}|${boardId}`;
    const cached = this.boardColumnsCache.get(cacheKey);
    if (cached && !fresh) return cached;
    const columns = mapBoardColumns(await client.boardConfiguration(boardId).catch((error: unknown) => {
      // report-ok: a board whose column setup does not come back (team-managed) shows each issue's Jira status instead
      console.warn('[jira/adapter] board configuration unavailable; showing Jira statuses', error instanceof Error ? error.name : error);
      return {};
    }));
    this.boardColumnsCache.set(cacheKey, columns);
    return columns;
  }

  /**
   * The JQL a project, filter or query source runs. A saved filter's JQL is read
   * again when `fresh` (a run's first page, the id listing), so an edit to the
   * filter in Jira reaches the next refresh.
   */
  private async sourceJql(client: JiraClient, ref: JiraSourceRef, fresh: boolean): Promise<string> {
    if (ref.kind === 'project') return `project = "${ref.value}" ORDER BY updated DESC`;
    if (ref.kind === 'jql') return ref.value;
    const cacheKey = `${client.site}|${ref.value}`;
    const cached = this.filterJqlCache.get(cacheKey);
    if (cached !== undefined && !fresh) return cached;
    const filter = await client.filter(ref.value);
    const jql = filter.jql?.trim() || `filter = ${ref.value}`;
    this.filterJqlCache.set(cacheKey, jql);
    return jql;
  }

  /**
   * The user's Jira time zone, read again at the start of each run (`fresh`): a
   * zone changed in Jira would otherwise shift every incremental window by hours.
   */
  private async timeZoneFor(client: JiraClient, fresh: boolean): Promise<string | undefined> {
    if (!fresh && this.timeZoneCache.has(client.site)) return this.timeZoneCache.get(client.site);
    const myself = await client.myself();
    this.timeZoneCache.set(client.site, myself.timeZone);
    return myself.timeZone;
  }

  /**
   * Every current issue id in the source, ids only. Throws rather than returning
   * an empty list when it cannot answer, because the reconcile prunes against it.
   */
  async listExternalIds(input: { source: ExternalSource; repository: string }): Promise<string[]> {
    const ref = decodeJiraRepository(input.repository);
    const client = await this.clientFor(ref.site);

    if (ref.kind === 'board') {
      return collectOffsetIds((startAt) => client.boardIssues(ref.value, { startAt, maxResults: ID_PAGE_SIZE, fields: 'id' }));
    }

    const jql = await this.sourceJql(client, ref, true);
    if (!client.isCloud) {
      return collectOffsetIds((startAt) => client.search(jql, { maxResults: ID_PAGE_SIZE, startAt, fields: 'id' }));
    }

    const ids: string[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    do {
      const page = await client.search(jql, { maxResults: ID_PAGE_SIZE, nextPageToken, fields: 'id' });
      ids.push(...page.issues.map((issue) => issue.id));
      nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
      if (nextPageToken !== undefined) {
        // A cursor handed back twice would page forever; throwing skips this prune.
        if (seenTokens.has(nextPageToken)) throw new Error('Jira returned the same search cursor twice');
        seenTokens.add(nextPageToken);
      }
    } while (nextPageToken);
    return ids;
  }

  // --- Import ----------------------------------------------------------------

  /** Fold each selected issue's comments into its description, at import time only. */
  async hydrateForImport(
    repository: string,
    issues: ImportExecuteInput['issues'],
  ): Promise<ImportExecuteInput['issues']> {
    const ref = decodeJiraRepository(repository);
    const client = await this.clientFor(ref.site);
    const sections = new Map<string, string>();
    const queue = [...issues];

    const worker = async (): Promise<void> => {
      for (let issue = queue.shift(); issue; issue = queue.shift()) {
        let comments: JiraCommentRaw[];
        try {
          comments = await client.comments(issue.externalId);
        } catch (error) {
          // An issue deleted since the list, or one whose comments this account
          // cannot read, imports without them. Anything else fails the step,
          // which the import handler counts as detail it could not add.
          if (error instanceof JiraHttpError && (error.status === 403 || error.status === 404)) continue;
          throw error;
        }
        const withBodies = comments.filter((comment) => (comment.renderedBody ?? '').trim().length > 0);
        if (withBodies.length === 0) continue;
        sections.set(issue.externalId, formatCommentsSection(withBodies.map((comment) => ({
          author: comment.author?.displayName ?? null,
          createdAt: comment.created ?? '',
          html: comment.renderedBody ?? '',
        }))));
      }
    };
    await Promise.all(Array.from({ length: Math.min(COMMENT_CONCURRENCY, issues.length) }, () => worker()));

    return issues.map((issue) => {
      const section = sections.get(issue.externalId);
      if (!section) return issue;
      return { ...issue, body: issue.body ? `${issue.body}\n\n${section}` : section };
    });
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const refs = extractInlineImageUrls(markdownBody);
    if (refs.length === 0) return { attachments: [], skippedCount: 0 };
    const clients = await this.allClients();
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const ref of refs) {
      const owner = clients.find((client) => client.ownsUrl(ref.url));
      const downloaded = await this.downloadWithAuth(ref.url, ref.filename, owner);
      if (downloaded) attachments.push(downloaded);
      else skippedCount++;
    }
    return { attachments, skippedCount };
  }

  async downloadFileAttachments(
    attachments: FileAttachmentRef[],
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const clients = await this.allClients();
    const results: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const attachment of attachments) {
      const owner = clients.find((client) => client.ownsUrl(attachment.url));
      const url = owner && attachment.externalRef
        ? owner.attachmentDownloadUrl(attachment.externalRef, attachment.url)
        : attachment.url;
      const downloaded = await this.downloadWithAuth(url, attachment.filename, owner);
      if (downloaded) results.push(downloaded);
      else skippedCount++;
    }
    return { attachments: results, skippedCount };
  }

  private async allClients(): Promise<JiraClient[]> {
    const credentials = await this.deps.loadCredentials();
    return Object.values(credentials).map((credential) => new JiraClient(credential, this.deps.fetchImpl));
  }

  /**
   * Download with the site's sign-in when the URL is the site's own. The shared
   * download drops the header on a redirect to another host. Data Center before
   * 8.17 refuses token downloads; those come back null and are counted as skipped.
   */
  private async downloadWithAuth(url: string, filename: string, owner: JiraClient | undefined): Promise<DownloadedAttachment | null> {
    const headers = owner ? { Authorization: owner.authorizationHeader() } : undefined;
    const result = await downloadFile(url, filename, headers ? { headers } : undefined);
    if (!result) return null;
    return { ...result, mediaType: mediaTypeFromFilename(filename) };
  }
}

/** The page map one query keeps in a cache, made on first use. */
function pageStarts<T>(cache: Map<string, Map<number, T>>, cacheKey: string): Map<number, T> {
  let starts = cache.get(cacheKey);
  if (!starts) {
    starts = new Map<number, T>();
    cache.set(cacheKey, starts);
  }
  return starts;
}

/**
 * Every id an offset-paged listing returns. Advances by what each page held,
 * not by the size asked for, because Jira caps a page below `maxResults` when it
 * wants to, and a fixed step would skip the ids in between, which the reconcile
 * would then prune as deleted.
 */
async function collectOffsetIds(fetchAt: (startAt: number) => Promise<JiraPage>): Promise<string[]> {
  const ids: string[] = [];
  for (let startAt = 0; ;) {
    const page = await fetchAt(startAt);
    if (page.issues.length === 0) return ids;
    ids.push(...page.issues.map((issue) => issue.id));
    startAt += page.issues.length;
    if (typeof page.total === 'number' && startAt >= page.total) return ids;
  }
}
