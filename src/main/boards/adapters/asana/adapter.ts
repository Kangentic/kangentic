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
  type FileAttachmentRef,
  type PrerequisiteResult,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { AsanaClient } from './client';
import { mapAsanaTasks } from './mapper';
import { buildAsanaLabel, parseAsanaUrl } from './url-parser';

registerSourceUrlParser('asana', { parse: parseAsanaUrl, buildLabel: buildAsanaLabel });

/**
 * Board adapter for Asana. Authenticates with a Personal Access Token (PAT)
 * the user creates at app.asana.com/0/my-apps and pastes into the setup
 * dialog.
 *
 * `status` is `'stable'` because configuration (the user's PAT) is runtime
 * state, not a build-time contract. The "not connected" state surfaces
 * through `checkPrerequisites` so the UI can route users into the Connect
 * flow.
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
    if (!this.client.hasCredential()) {
      return {
        cliOk: true,
        authOk: false,
        message: 'Not connected to Asana. Click "Connect Asana" to paste a Personal Access Token.',
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

    // Asana stores inline images (pasted into the description) as regular
    // attachments, so `/tasks/{gid}/attachments` covers BOTH the Attachments
    // panel and inline images. No need to also scrape html_notes here.
    const attachmentsByTask = await this.client.fetchAttachmentsForTasks(tasks);

    const alreadyImportedIds = findAlreadyImported('asana', tasks.map((task) => task.gid));
    const issues = mapAsanaTasks(tasks, alreadyImportedIds).map((issue) => {
      const attachments = attachmentsByTask.get(issue.externalId) ?? [];
      const fileAttachments: FileAttachmentRef[] = attachments
        .filter((attachment) => typeof attachment.download_url === 'string' && attachment.download_url!.length > 0)
        .map((attachment) => ({
          url: attachment.download_url!,
          filename: attachment.name ?? attachment.gid,
          sizeBytes: attachment.size ?? 0,
          // Asana's download_url expires within ~2 minutes. Stash the
          // attachment gid so the executor can re-fetch a fresh URL from
          // /attachments/{gid} right before downloading.
          externalRef: attachment.gid,
        }));
      return fileAttachments.length > 0 ? { ...issue, fileAttachments } : issue;
    });

    return { issues, totalCount: issues.length, hasNextPage };
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
      const project = await this.client.getProject(repository);
      return project?.name?.trim() || null;
    } catch (error) {
      console.warn('[asana/adapter] resolveLabel failed:', error);
      return null;
    }
  }
}
