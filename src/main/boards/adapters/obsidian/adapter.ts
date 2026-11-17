import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ExternalIssue,
  ExternalSource,
  FileAttachmentRef,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import {
  type AdapterStatus,
  type BoardAdapter,
  type DownloadedAttachment,
  type PrerequisiteResult,
  DOWNLOAD_CONCURRENCY,
  MAX_ATTACHMENT_SIZE,
  downloadFile,
  extractInlineImageUrls,
  mediaTypeFromFilename,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { buildObsidianLabel, parseObsidianFolder } from './url-parser';
import { findVaultRoot, fromVaultPath } from './vault';
import { folderProblem, readVaultItems, type VaultItemKind, type VaultRead } from './vault-reader';
import type { VaultItem } from './vault-item';

registerSourceUrlParser('obsidian_notes', { parse: parseObsidianFolder, buildLabel: buildObsidianLabel });
registerSourceUrlParser('obsidian_checklist', { parse: parseObsidianFolder, buildLabel: buildObsidianLabel });

/** A reconcile's fetch and its prune run back to back; one read of the vault serves both. */
const READ_REUSE_MS = 5_000;

/**
 * Board adapter for an Obsidian vault on this computer. The repository is the
 * folder the source was added with; the vault is the nearest folder above it
 * holding `.obsidian`. Read-only: nothing here writes to the vault.
 *
 * There is no CLI and no sign-in, so the check is a folder check, and the fetch
 * reads the whole folder in one pass (no paging, no `since`). Embedded files are
 * copied from disk in `downloadFileAttachments`; web images take the shared
 * download path.
 */
class ObsidianAdapter implements BoardAdapter {
  readonly displayName = 'Obsidian';
  readonly icon = 'obsidian';
  readonly status: AdapterStatus = 'stable';
  /** Each folder's read for `READ_REUSE_MS` after it starts. */
  private readonly recentReads = new Map<string, Promise<VaultRead>>();

  constructor(readonly id: ExternalSource, private readonly kind: VaultItemKind) {}

  /** No CLI and no sign-in: there is nothing to check until a folder is named. */
  async checkPrerequisites(): Promise<PrerequisiteResult> {
    return { cliOk: true, authOk: true };
  }

  /** With a saved source's folder: whether it is still there, and still in a vault. */
  async checkCli(repository?: string): Promise<ImportCheckCliResult> {
    const problem = repository ? folderProblem(repository) : null;
    return prerequisiteToCheckCli(problem ? { cliOk: false, authOk: false, message: problem } : await this.checkPrerequisites());
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    if (input.page > 1) return { issues: [], totalCount: 0, hasNextPage: false };
    const { vaultRoot, items } = await this.read(input.repository);
    const alreadyImported = findAlreadyImported(this.id, items.map((item) => item.externalId));
    const issues = items.map((item) => this.toExternalIssue(item, vaultRoot, alreadyImported.has(item.externalId)));
    return { issues, totalCount: issues.length, hasNextPage: false };
  }

  async listExternalIds(input: { source: ExternalSource; repository: string }): Promise<string[]> {
    const { items } = await this.read(input.repository);
    return items.map((item) => item.externalId);
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const images = extractInlineImageUrls(markdownBody);
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (let batchStart = 0; batchStart < images.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = images.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.all(batch.map((image) => downloadFile(image.url, image.filename)));
      for (const result of results) {
        if (result) attachments.push(result);
        else skippedCount += 1;
      }
    }
    return { attachments, skippedCount };
  }

  /**
   * Copy embedded files from the vault. Each reference is re-checked here, since
   * the renderer hands the list back: a file is read only when it sits inside a
   * vault and is within the attachment size cap.
   */
  async downloadFileAttachments(references: FileAttachmentRef[]): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const reference of references) {
      const attachment = await readEmbeddedFile(reference);
      if (attachment) attachments.push(attachment);
      else skippedCount += 1;
    }
    return { attachments, skippedCount };
  }

  private read(repository: string): Promise<VaultRead> {
    const recent = this.recentReads.get(repository);
    if (recent) return recent;
    const read = readVaultItems(repository, this.kind);
    this.recentReads.set(repository, read);
    const forget = () => {
      // A newer read may have taken this folder's slot; leave that one alone.
      if (this.recentReads.get(repository) === read) this.recentReads.delete(repository);
    };
    // The entry holds every item of the folder, so it is dropped once the window ends.
    setTimeout(forget, READ_REUSE_MS).unref();
    read.catch(forget); // report-ok: the caller awaits the same promise and gets the error; this only drops it from the reuse window
    return read;
  }

  private toExternalIssue(item: VaultItem, vaultRoot: string, alreadyImported: boolean): ExternalIssue {
    const fileAttachments: FileAttachmentRef[] = item.embeddedFiles.map((file) => ({
      url: pathToFileURL(fromVaultPath(vaultRoot, file.vaultPath)).href,
      filename: file.vaultPath.split('/').pop() ?? file.vaultPath,
      sizeBytes: file.sizeBytes,
      externalRef: file.vaultPath,
    }));
    return {
      externalId: item.externalId,
      externalSource: this.id,
      externalUrl: pathToFileURL(fromVaultPath(vaultRoot, item.noteVaultPath)).href,
      title: item.title,
      body: item.body,
      labels: item.labels,
      assignee: null,
      state: item.state,
      stateCategory: item.closed ? 'closed' : 'open',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      alreadyImported,
      attachmentCount: fileAttachments.length + extractInlineImageUrls(item.body).length,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined,
      displayId: item.displayText || undefined,
      priority: item.priorityName ?? undefined,
      stateOrder: item.stateOrder ?? undefined,
    };
  }
}

/**
 * The file a reference names, only when it is one the vault walk could have
 * listed: a local path (no network host), inside a vault once links are
 * resolved, under no dot folder (`.obsidian`, `.trash`, `.git`), and a regular
 * file. The renderer hands the list back, so nothing about it is trusted.
 */
async function embeddedFilePath(reference: FileAttachmentRef): Promise<string | null> {
  let absolutePath: string;
  try {
    const url = new URL(reference.url);
    if (url.protocol !== 'file:' || url.host !== '') return null;
    absolutePath = fileURLToPath(url);
  } catch { // report-ok: a reference that is not a file URL is not one this adapter made; it counts as skipped
    return null;
  }
  const vaultRoot = findVaultRoot(path.dirname(absolutePath));
  if (!vaultRoot) return null;
  try {
    const [realFile, realVaultRoot] = await Promise.all([fs.promises.realpath(absolutePath), fs.promises.realpath(vaultRoot)]);
    const relative = path.relative(realVaultRoot, realFile);
    if (relative === '' || path.isAbsolute(relative)) return null;
    if (relative.split(path.sep).some((segment) => segment.startsWith('.'))) return null;
    const stats = await fs.promises.lstat(realFile);
    return stats.isFile() ? realFile : null;
  } catch { // report-ok: a file moved or deleted since the vault was read counts as a skipped attachment
    return null;
  }
}

async function readEmbeddedFile(reference: FileAttachmentRef): Promise<DownloadedAttachment | null> {
  const absolutePath = await embeddedFilePath(reference);
  if (!absolutePath) return null;
  try {
    const stats = await fs.promises.stat(absolutePath);
    if (stats.size > MAX_ATTACHMENT_SIZE) return null;
    const data = await fs.promises.readFile(absolutePath);
    return {
      filename: reference.filename,
      data: data.toString('base64'),
      mediaType: mediaTypeFromFilename(reference.filename),
      sizeBytes: data.length,
      sourceUrl: reference.url,
    };
  } catch { // report-ok: a file moved or locked since the vault was read counts as a skipped attachment
    return null;
  }
}

export class ObsidianNotesAdapter extends ObsidianAdapter {
  constructor() {
    super('obsidian_notes', 'notes');
  }
}

export class ObsidianChecklistAdapter extends ObsidianAdapter {
  constructor() {
    super('obsidian_checklist', 'checklist');
  }
}
