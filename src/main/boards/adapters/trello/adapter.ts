import type { ExternalSource, ImportCheckCliResult, ImportFetchInput, ImportFetchResult } from '../../../../shared/types';
import {
  type BoardAdapter,
  type AdapterStatus,
  type DownloadedAttachment,
  type FileAttachmentRef,
  type PrerequisiteResult,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { TRELLO_NOT_CONNECTED_MESSAGE, TrelloClient, type TrelloBoardSnapshot } from './client';
import { mapTrelloCards, type TrelloMappedIssue } from './mapper';
import { buildTrelloLabel, parseTrelloUrl } from './url-parser';

registerSourceUrlParser('trello', { parse: parseTrelloUrl, buildLabel: buildTrelloLabel });

/** Page size when the caller does not name one. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Board adapter for Trello: a one-time, read-only import of one board's cards. It never writes to
 * Trello. The credential (Trello API key plus user token) is runtime state, so `status` is
 * `'stable'` and "not connected" surfaces through `checkPrerequisites`, which the Import dialog's
 * Connect Trello button reads.
 *
 * A board is read whole on page 1 (lists with archived ones, every card with archived ones) and
 * filtered here: Trello cards have no open or closed state of their own, so Closed means an
 * archived card or any card on an archived list.
 */
export class TrelloAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'trello';
  readonly displayName = 'Trello';
  readonly icon = 'trello';
  readonly status: AdapterStatus = 'stable';
  private readonly client: TrelloClient;
  /** A loaded board's cards, mapped and sorted once, so each later page only filters and slices. */
  private readonly issuesBySnapshot = new WeakMap<TrelloBoardSnapshot, TrelloMappedIssue[]>();

  constructor(client?: TrelloClient) {
    this.client = client ?? new TrelloClient();
  }

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    if (!(await this.client.hasCredential())) {
      return { cliOk: true, authOk: false, message: TRELLO_NOT_CONNECTED_MESSAGE };
    }
    try {
      await this.client.listBoards();
      return { cliOk: true, authOk: true };
    } catch (error) {
      // report-ok: a refused or unreachable Trello is the answer this check exists to give; the
      // Import dialog shows it in its banner with the Connect Trello button
      const message = error instanceof Error ? error.message : 'Trello authentication check failed';
      return { cliOk: true, authOk: false, message };
    }
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return prerequisiteToCheckCli(await this.checkPrerequisites());
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const page = Math.max(1, input.page);
    const snapshot = await this.client.loadBoard(input.repository, page === 1);
    const state = input.state ?? 'all';
    const matching = this.boardIssues(snapshot)
      .filter((issue) => state === 'all' || issue.stateCategory === state)
      .filter((issue) => matchesSearch(issue, input.searchQuery));

    const perPage = input.perPage > 0 ? input.perPage : DEFAULT_PAGE_SIZE;
    const start = (page - 1) * perPage;
    const pageIssues = matching.slice(start, start + perPage);
    // Only this page's cards are looked up, so paging a large board does not query every card
    // once per page.
    const alreadyImportedIds = findAlreadyImported('trello', pageIssues.map((issue) => issue.externalId));
    const issues = pageIssues.map((issue) => ({ ...issue, alreadyImported: alreadyImportedIds.has(issue.externalId) }));
    return { issues, totalCount: matching.length, hasNextPage: start + perPage < matching.length };
  }

  private boardIssues(snapshot: TrelloBoardSnapshot): TrelloMappedIssue[] {
    const cached = this.issuesBySnapshot.get(snapshot);
    if (cached) return cached;
    const issues = mapTrelloCards(snapshot.cards, snapshot.lists, new Set()).sort(byBoardPosition);
    this.issuesBySnapshot.set(snapshot, issues);
    return issues;
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.client.downloadInlineImages(markdownBody);
  }

  async downloadFileAttachments(
    attachments: FileAttachmentRef[],
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.client.downloadFileAttachments(attachments);
  }

  async resolveLabel(repository: string): Promise<string | null> {
    try {
      return await this.client.getBoardName(repository);
    } catch (error) {
      // report-ok: the source keeps its fallback label; a refused token surfaces when the board opens
      console.warn('[trello/adapter] resolveLabel failed:', error instanceof Error ? error.name : 'unknown');
      return null;
    }
  }
}

function matchesSearch(issue: TrelloMappedIssue, searchQuery: string | undefined): boolean {
  const query = searchQuery?.trim().toLowerCase() ?? '';
  if (query.length === 0) return true;
  const haystack = [issue.title, issue.displayId, issue.state, issue.assignee ?? '', ...issue.labels]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/** Left to right by list, then most recently active first within a list. */
function byBoardPosition(left: TrelloMappedIssue, right: TrelloMappedIssue): number {
  if (left.stateOrder !== right.stateOrder) return left.stateOrder - right.stateOrder;
  // ISO 8601 timestamps order as plain strings; localeCompare would run ICU collation per comparison.
  if (left.updatedAt === right.updatedAt) return 0;
  return right.updatedAt < left.updatedAt ? -1 : 1;
}
