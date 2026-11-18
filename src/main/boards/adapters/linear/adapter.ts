import type {
  ExternalSource,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import {
  type BoardAdapter,
  type AdapterStatus,
  type DownloadedAttachment,
  type PrerequisiteResult,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { RefusalError } from '../../../../shared/refusal';
import { LinearClient, NOT_CONNECTED_MESSAGE } from './client';
import { mapLinearIssues, stateOrderByIdFrom } from './mapper';
import { buildLinearLabel, parseLinearUrl } from './url-parser';

registerSourceUrlParser('linear', { parse: parseLinearUrl, buildLabel: buildLinearLabel });

/**
 * Board adapter for Linear. Signs in with a personal API key or Linear's OAuth
 * sign-in (both held by `credential-store.ts`) and imports one team's issues.
 * The repository is the team key. Read-only: nothing here writes to Linear.
 *
 * `status` is `'stable'` because a missing sign-in is runtime state: it surfaces
 * through `checkPrerequisites`, and the UI routes the user into Connect Linear.
 */
export class LinearAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'linear';
  readonly displayName = 'Linear';
  readonly icon = 'linear';
  readonly status: AdapterStatus = 'stable';
  private readonly client: LinearClient;
  private readonly stateOrderCache = new Map<string, Map<string, number>>();

  constructor(client?: LinearClient) {
    this.client = client ?? new LinearClient();
  }

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    if (!(await this.client.hasCredential())) {
      return { cliOk: true, authOk: false, message: NOT_CONNECTED_MESSAGE };
    }
    try {
      await this.client.getViewer();
      return { cliOk: true, authOk: true };
    } catch (error) {
      // report-ok: any failed check (Linear's refusal of a revoked key or an expired sign-in, or no network) is the answer the Import dialog's banner shows, as Asana's check does.
      const message = error instanceof Error ? error.message : 'Linear authentication check failed';
      return { cliOk: true, authOk: false, message };
    }
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return prerequisiteToCheckCli(await this.checkPrerequisites());
  }

  keepSignInAlive(now?: number): Promise<void> {
    return this.client.keepSignInAlive(now);
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const stateOrderById = await this.stateOrderFor(input.repository, input.page <= 1);
    const { issues: rawIssues, hasNextPage } = await this.client.listIssues(input.repository, {
      page: input.page,
      perPage: input.perPage,
      since: input.since,
    });
    const alreadyImportedIds = findAlreadyImported('linear', rawIssues.map((issue) => issue.id));
    const issues = mapLinearIssues(rawIssues, stateOrderById, alreadyImportedIds);
    return { issues, totalCount: issues.length, hasNextPage };
  }

  /**
   * The team's board order, read on a reconcile's first page and reused for the
   * pages after it, so a 10-page reconcile asks Linear for the states once.
   */
  private async stateOrderFor(teamKey: string, refresh: boolean): Promise<Map<string, number>> {
    const cached = this.stateOrderCache.get(teamKey);
    if (cached && !refresh) return cached;
    const teamWithStates = await this.client.getTeam(teamKey);
    if (!teamWithStates) {
      throw new RefusalError(`No Linear team with key ${teamKey} is visible to this sign-in.`);
    }
    const stateOrderById = stateOrderByIdFrom(teamWithStates.states);
    this.stateOrderCache.set(teamKey, stateOrderById);
    return stateOrderById;
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.client.downloadInlineImages(markdownBody);
  }

  async resolveLabel(repository: string): Promise<string | null> {
    try {
      const teamWithStates = await this.client.getTeam(repository);
      return teamWithStates?.team.name.trim() || null;
    } catch (error) {
      // report-ok: the placeholder "Linear team <KEY>" label stays, the same fallback Asana uses.
      console.warn('[linear/adapter] resolveLabel failed:', error instanceof Error ? error.name : 'unknown');
      return null;
    }
  }
}
