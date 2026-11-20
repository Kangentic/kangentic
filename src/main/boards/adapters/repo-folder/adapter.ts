import type {
  ExternalIssue,
  ExternalSource,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
  RepoFolderListing,
} from '../../../../shared/types';
import { RefusalError } from '../../../../shared/refusal';
import {
  type AdapterStatus,
  type BoardAdapter,
  type DownloadedAttachment,
  type PrerequisiteResult,
  type PreparedSource,
  type SourceProject,
  registerSourceUrlParser,
} from '../../shared';
import { lastChangeOf, readBranch, type BranchRead } from './branch-reader';
import {
  findFolder,
  folderItems,
  itemDescription,
  listImportableFolders,
  normalizeRepoFolder,
  type RepoFolderItem,
} from './folder-tree';

registerSourceUrlParser('repo_folder', {
  parse: (folder) => ({ repository: normalizeRepoFolder(folder) }),
  buildLabel: (repository) => repository,
});

/** A reconcile's fetch and its prune run back to back; one read of the branch serves both. */
const READ_REUSE_MS = 5_000;

/**
 * Above this many items, each item's date is its commit's rather than the last
 * commit that touched it: that read is one git process per item.
 */
const ITEM_DATE_LOOKUP_LIMIT = 50;

/** How many of those per-item date reads run at once. */
const ITEM_DATE_CONCURRENCY = 4;

/**
 * How many item dates are kept. A commit never changes, so an item's date at a
 * commit is read once and every later fetch of that commit spawns no git for it.
 */
const ITEM_DATE_CACHE_LIMIT = 2_000;

function requireProject(project: SourceProject | undefined): SourceProject {
  if (!project) throw new RefusalError('No project is open.');
  return project;
}

function missingFolder(folder: string, baseBranch: string): RefusalError {
  return new RefusalError(`No folder ${folder} on ${baseBranch}.`);
}

/**
 * Board adapter for a folder in the project's own repository, read from the
 * default branch (the newer of local and `origin`, never fetched, never the
 * working tree). Each direct child of the folder, file or folder, is a task;
 * the repository is the folder's repo-relative path. Read-only, no sign-in.
 */
export class RepoFolderAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'repo_folder';
  readonly displayName = 'Repository folder';
  readonly icon = 'folder-git';
  readonly status: AdapterStatus = 'stable';
  /** Each project's branch read for `READ_REUSE_MS` after it starts. */
  private readonly recentReads = new Map<string, Promise<BranchRead>>();
  /** Each item's last change at a commit, oldest first, capped at `ITEM_DATE_CACHE_LIMIT`. */
  private readonly itemDateCache = new Map<string, string | null>();

  /** No CLI beyond git and no sign-in. A missing folder is the fetch's refusal. */
  async checkPrerequisites(): Promise<PrerequisiteResult> {
    return { cliOk: true, authOk: true };
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return { available: true, authenticated: true };
  }

  /** A typed folder that is not on the default branch is refused before anything is saved. */
  async prepareSource(repository: string, project?: SourceProject): Promise<PreparedSource> {
    const sourceProject = requireProject(project);
    const { tree } = await this.read(sourceProject);
    if (!findFolder(tree, repository)) throw missingFolder(repository, sourceProject.baseBranch);
    return { label: repository, repository };
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
    project?: SourceProject,
  ): Promise<ImportFetchResult> {
    if (input.page > 1) return { issues: [], totalCount: 0, hasNextPage: false };
    const sourceProject = requireProject(project);
    const branch = await this.read(sourceProject);
    const items = this.itemsOf(branch, input.repository, sourceProject.baseBranch);
    const dates = await this.itemDates(sourceProject, branch, items);
    const alreadyImported = findAlreadyImported(this.id, items.map((item) => item.name));
    const issues = items.map((item, index) => this.toExternalIssue(item, dates[index], alreadyImported.has(item.name)));
    return { issues, totalCount: issues.length, hasNextPage: false };
  }

  /** Every current item, so an item moved out of the folder (archived) drops from the list. */
  async listExternalIds(input: { source: ExternalSource; repository: string }, project?: SourceProject): Promise<string[]> {
    const sourceProject = requireProject(project);
    const branch = await this.read(sourceProject);
    return this.itemsOf(branch, input.repository, sourceProject.baseBranch).map((item) => item.name);
  }

  /** The folders Browse offers, each with how many tasks it would import. */
  async listFolders(project: SourceProject): Promise<RepoFolderListing> {
    const { tree } = await this.read(project);
    return { baseBranch: project.baseBranch, folders: listImportableFolders(tree) };
  }

  /** A task's description lists paths and copies no file content, so there is nothing to download. */
  async downloadImages(): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return { attachments: [], skippedCount: 0 };
  }

  private itemsOf(branch: BranchRead, folder: string, baseBranch: string): RepoFolderItem[] {
    const node = findFolder(branch.tree, folder);
    if (!node) throw missingFolder(folder, baseBranch);
    return folderItems(node, folder);
  }

  /** Each item's last change, or the commit's date for all of them past the lookup limit. */
  private async itemDates(project: SourceProject, branch: BranchRead, items: RepoFolderItem[]): Promise<string[]> {
    if (items.length > ITEM_DATE_LOOKUP_LIMIT) return items.map(() => branch.committedAt);
    const dates: string[] = new Array<string>(items.length).fill(branch.committedAt);
    for (let start = 0; start < items.length; start += ITEM_DATE_CONCURRENCY) {
      const batch = items.slice(start, start + ITEM_DATE_CONCURRENCY);
      const answers = await Promise.all(batch.map((item) => this.itemDate(project, branch.commit, item.path)));
      answers.forEach((answer, offset) => {
        if (answer) dates[start + offset] = answer;
      });
    }
    return dates;
  }

  private async itemDate(project: SourceProject, commit: string, itemPath: string): Promise<string | null> {
    const key = `${project.path}\0${commit}\0${itemPath}`;
    if (this.itemDateCache.has(key)) return this.itemDateCache.get(key) ?? null;
    const answer = await lastChangeOf(project, commit, itemPath);
    this.itemDateCache.set(key, answer);
    if (this.itemDateCache.size > ITEM_DATE_CACHE_LIMIT) {
      const oldest = this.itemDateCache.keys().next().value;
      if (oldest !== undefined) this.itemDateCache.delete(oldest);
    }
    return answer;
  }

  private read(project: SourceProject): Promise<BranchRead> {
    const key = `${project.path}\0${project.baseBranch}`;
    const recent = this.recentReads.get(key);
    if (recent) return recent;
    const read = readBranch(project);
    this.recentReads.set(key, read);
    const forget = () => {
      // A newer read may have taken this project's slot; leave that one alone.
      if (this.recentReads.get(key) === read) this.recentReads.delete(key);
    };
    // The entry holds the branch's whole file list, so it is dropped once the window ends.
    setTimeout(forget, READ_REUSE_MS).unref();
    read.catch(forget); // report-ok: the caller awaits the same promise and gets the error; this only drops it from the reuse window
    return read;
  }

  private toExternalIssue(item: RepoFolderItem, changedAt: string, alreadyImported: boolean): ExternalIssue {
    return {
      externalId: item.name,
      externalSource: this.id,
      // No link: a file: URL names this computer, which is wrong for a remote project.
      externalUrl: '',
      title: item.name,
      body: itemDescription(item),
      labels: [],
      assignee: null,
      state: '',
      stateCategory: 'open',
      createdAt: changedAt,
      updatedAt: changedAt,
      alreadyImported,
      attachmentCount: 0,
      displayId: item.name,
    };
  }
}
