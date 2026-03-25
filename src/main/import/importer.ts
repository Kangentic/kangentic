import type {
  ExternalSource,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../shared/types';

/** Downloaded attachment from an import source. */
export interface DownloadedAttachment {
  filename: string;
  data: string;
  mediaType: string;
  sizeBytes: number;
  sourceUrl: string;
}

/**
 * Common interface for all import source implementations.
 * Each source (GitHub Issues, GitHub Projects, Azure DevOps) implements this
 * so the IPC handlers remain source-agnostic.
 */
export interface Importer {
  /** Check CLI availability and authentication. */
  checkCli(): Promise<ImportCheckCliResult>;

  /**
   * Fetch items from the external source.
   * Receives the full ImportFetchInput and a function to look up which external IDs
   * are already imported (called with the source and a list of IDs after fetching).
   * Returns the normalized ImportFetchResult ready for the renderer.
   */
  fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult>;

  /**
   * Download inline images from a markdown body.
   * Returns downloaded attachments and a count of skipped downloads.
   */
  downloadImages(markdownBody: string): Promise<{
    attachments: DownloadedAttachment[];
    skippedCount: number;
  }>;

  /**
   * Download file attachments from an external source using authenticated HTTP.
   * Optional - only implemented by sources that have explicit file attachments
   * (e.g. Azure DevOps AttachedFile relations).
   */
  downloadFileAttachments?(
    attachments: Array<{ url: string; filename: string; sizeBytes: number }>,
  ): Promise<{
    attachments: DownloadedAttachment[];
    skippedCount: number;
  }>;
}

/**
 * Registry of importers keyed by ExternalSource.
 * Used by the IPC handlers to dispatch to the correct implementation.
 */
export type ImporterRegistry = Record<ExternalSource, Importer>;
