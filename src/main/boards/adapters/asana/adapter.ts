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
import { AsanaClient } from './client';
import { isOAuthConfigured } from './oauth';
import { mapAsanaTasks } from './mapper';
import { buildAsanaLabel, parseAsanaUrl } from './url-parser';

registerSourceUrlParser('asana', { parse: parseAsanaUrl, buildLabel: buildAsanaLabel });

/**
 * Board adapter for Asana. Uses OAuth 2.0 + PKCE for authentication.
 *
 * `status` is `'stable'` because configuration (the OAuth client_id and the
 * user's tokens) is runtime state, not a build-time contract. The "not
 * configured" / "not connected" states surface through `checkPrerequisites`
 * so the UI can route users into the setup wizard or the Connect flow.
 */
export class AsanaAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'asana';
  readonly displayName = 'Asana';
  readonly icon = 'kanban-square';
  readonly status: AdapterStatus = 'stable';
  private readonly client: AsanaClient;

  constructor(client?: AsanaClient) {
    this.client = client ?? new AsanaClient();
  }

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    if (!isOAuthConfigured()) {
      return {
        cliOk: false,
        authOk: false,
        message: 'Asana is not set up yet. Click "Set up Asana" to get started.',
      };
    }
    if (!this.client.hasCredential()) {
      return {
        cliOk: true,
        authOk: false,
        message: 'Not connected to Asana. Click "Connect Asana" to sign in.',
      };
    }
    try {
      await this.client.getMe();
      return { cliOk: true, authOk: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Asana authentication check failed';
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
    const { tasks, hasNextPage } = await this.client.listTasks(input.repository, {
      page: input.page,
      perPage: input.perPage,
      searchQuery: input.searchQuery,
      state: input.state,
    });

    const attachmentsByTask = await this.client.fetchAttachmentsForTasks(tasks);

    const alreadyImportedIds = findAlreadyImported('asana', tasks.map((task) => task.gid));
    const issues = mapAsanaTasks(tasks, alreadyImportedIds).map((issue) => {
      const attachments = attachmentsByTask.get(issue.externalId) ?? [];
      const fileAttachments = attachments
        .filter((attachment) => typeof attachment.download_url === 'string' && attachment.download_url.length > 0)
        .map((attachment) => ({
          url: attachment.download_url!,
          filename: attachment.name ?? attachment.gid,
          sizeBytes: attachment.size ?? 0,
        }));
      return fileAttachments.length > 0 ? { ...issue, fileAttachments } : issue;
    });

    return { issues, totalCount: issues.length, hasNextPage };
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.client.downloadInlineImages(markdownBody);
  }

  async downloadFileAttachments(
    attachments: Array<{ url: string; filename: string; sizeBytes: number }>,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.client.downloadFileAttachments(attachments);
  }

  async resolveLabel(repository: string): Promise<string | null> {
    try {
      const project = await this.client.getProject(repository);
      return project?.name?.trim() || null;
    } catch (error) {
      console.warn('[asana/adapter] resolveLabel failed:', error);
      return null;
    }
  }
}
