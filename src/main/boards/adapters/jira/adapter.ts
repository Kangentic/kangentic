import type { ExternalSource, ImportCheckCliResult, ImportFetchInput, ImportFetchResult } from '../../../../shared/types';
import type { BoardAdapter, AdapterStatus, DownloadedAttachment, PrerequisiteResult } from '../../shared';
import { RefusalError } from '../../../../shared/refusal';

const NOT_IMPLEMENTED = 'Jira adapter is not yet implemented (tracked in #481).';

export class JiraAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'jira';
  readonly displayName = 'Jira';
  readonly icon = 'layers';
  readonly status: AdapterStatus = 'stub';

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    throw new RefusalError(NOT_IMPLEMENTED);
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return { available: false, authenticated: false, error: NOT_IMPLEMENTED };
  }

  async fetch(
    _input: ImportFetchInput,
    _findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    throw new RefusalError(NOT_IMPLEMENTED);
  }

  async downloadImages(_markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    throw new RefusalError(NOT_IMPLEMENTED);
  }
}
