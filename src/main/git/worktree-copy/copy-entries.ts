import path from 'node:path';
import type { Stats } from 'node:fs';
import fs from '../original-fs';
import { hasLinkOnPath, isLinkEntry } from '../link-check';
import { WorktreeCopyLimitError } from '../worktree-errors';
import {
  PRUNED_FOLDER_NAMES,
  absolutePath,
  globBaseSegments,
  globMaxDepth,
  hasGlobMagic,
  isAtOrUnder,
  isClaudePath,
  normalizeEntry,
} from './entry-path';

/**
 * Expand a `git.copyFiles` list against the project folder and copy it into a
 * worktree, keeping relative paths. Runs in the `kangentic-worktree-copy`
 * utility process, and inline only when that process cannot run
 * (`worktree-copy-client.ts`). `original-fs`, because a copied folder can hold
 * an `.asar`, which the patched `fs` opens and pins (`original-fs.ts`).
 *
 * The whole list expands before the first byte moves, so a list over a limit
 * fails the start with nothing copied. Measured on Windows from a real npm
 * install to a temp folder: 20,000 files and 784 MB took 6.2 s at 8 at a time
 * (3,207 files a second), and a walk reads 22,645 entries in 0.33 s, so a task
 * start pays seconds at most for what these limits allow. `path.matchesGlob`
 * adds 0.4 to 1.4 s over a whole walk limit, measured on Node 24. Re-checking
 * those 20,000 files by size and modified time took 0.39 s, which is what a
 * spare's claim pays for the second pass instead of a second copy.
 */
export const COPY_LIMITS = { files: 20_000, bytes: 2 * 1024 * 1024 * 1024, walkedEntries: 200_000 };

export type CopyLimits = typeof COPY_LIMITS;

/** Files in flight at once. Measured beside the numbers above: 1,017 files a second one at a time, 3,207 at 8. */
const COPY_CONCURRENCY = 8;
/** `lstat`s in flight per directory. */
const LSTAT_BATCH_SIZE = 64;
/** A file set to its source's times reads back within this of them. */
const MODIFIED_TIME_TOLERANCE_MS = 1;

export interface CopyEntriesRequest {
  projectPath: string;
  worktreePath: string;
  entries: string[];
  /** Folders a link fills in the worktree (`linkedFoldersOf`). Nothing is read from or written under one. */
  linkedFolders: string[];
}

export interface CopyEntriesResult {
  copied: number;
  /** Files whose destination already matched, as on a spare's claim. */
  unchanged: number;
  /** Links in a copied folder left out: one absolute or leaving the folder, or one this machine refused to make. */
  skippedLinks: number;
}

interface PlannedLink {
  relative: string;
  target: string;
}

interface CopyPlan {
  files: Map<string, Stats>;
  directories: Set<string>;
  links: PlannedLink[];
  bytes: number;
  walked: number;
  skippedLinks: number;
}

interface ListedEntry {
  name: string;
  stats: Stats;
  isLink: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** True for a path a copy skips instead of failing the start: it left, or nothing here may read it. */
function isUnreachable(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

class CopyPlanner {
  readonly plan: CopyPlan = { files: new Map(), directories: new Set(), links: [], bytes: 0, walked: 0, skippedLinks: 0 };

  constructor(
    private readonly request: CopyEntriesRequest,
    private readonly limits: CopyLimits,
    private readonly signal?: AbortSignal,
  ) {}

  async addEntry(rawEntry: string): Promise<void> {
    const entry = normalizeEntry(rawEntry);
    if (!entry) {
      console.warn(`[WORKTREE] Skipped a copy entry outside the project: ${rawEntry}`);
      return;
    }
    if (hasGlobMagic(entry) && !(await this.existsAsNamed(entry))) await this.addGlob(entry);
    else await this.addLiteral(entry);
  }

  /** A path that exists under its own name is that path: `app/[id]/page.tsx` does not match itself as a glob. */
  private async existsAsNamed(entry: string): Promise<boolean> {
    try {
      await fs.promises.lstat(absolutePath(this.request.projectPath, entry));
      return true;
    } catch {
      return false;
    }
  }

  private isLinked(relative: string): boolean {
    return this.request.linkedFolders.some((folder) => isAtOrUnder(relative, folder));
  }

  private async addLiteral(entry: string): Promise<void> {
    if (isClaudePath(entry) || this.isLinked(entry)) return;
    const source = absolutePath(this.request.projectPath, entry);
    let stats: Stats;
    try {
      stats = await fs.promises.lstat(source);
      if (await isLinkEntry(source, stats)) {
        // A file an entry names through a link is that file, as it always was.
        // A folder behind a link is never entered.
        stats = await fs.promises.stat(source);
        if (stats.isDirectory()) return;
      }
    } catch (error) {
      if (isUnreachable(error)) return;
      throw error;
    }
    if (stats.isDirectory()) {
      if (!(await hasLinkOnPath(this.request.projectPath, path.posix.dirname(entry)))) await this.addTree(entry, entry);
    } else if (stats.isFile()) {
      this.addFile(entry, stats, entry);
    }
  }

  private async addGlob(glob: string): Promise<void> {
    const base = globBaseSegments(glob).join('/');
    if (await hasLinkOnPath(this.request.projectPath, base)) return;
    const maxDepth = globMaxDepth(glob);
    const pending = [base];
    while (pending.length > 0) {
      const directory = pending.pop() ?? '';
      for (const child of await this.listDirectory(directory, glob)) {
        const relative = joinRelative(directory, child.name);
        if (this.isSkipped(child.name, relative)) continue;
        // A link a glob reaches names something elsewhere, so it stays out.
        if (child.isLink) continue;
        const matches = path.matchesGlob(relative, glob);
        if (child.stats.isDirectory()) {
          if (matches) await this.addTree(relative, glob);
          else if (maxDepth === null || relative.split('/').length < maxDepth) pending.push(relative);
        } else if (matches && child.stats.isFile()) {
          this.addFile(relative, child.stats, glob);
        }
      }
    }
  }

  private async addTree(root: string, entry: string): Promise<void> {
    this.plan.directories.add(root);
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop() ?? '';
      for (const child of await this.listDirectory(directory, entry)) {
        const relative = joinRelative(directory, child.name);
        if (this.isSkipped(child.name, relative)) continue;
        if (child.isLink) {
          await this.addLink(relative, root);
        } else if (child.stats.isDirectory()) {
          this.plan.directories.add(relative);
          pending.push(relative);
        } else if (child.stats.isFile()) {
          this.addFile(relative, child.stats, entry);
        }
      }
    }
  }

  private isSkipped(name: string, relative: string): boolean {
    return PRUNED_FOLDER_NAMES.has(name.toLowerCase()) || isClaudePath(relative) || this.isLinked(relative);
  }

  private async listDirectory(relative: string, entry: string): Promise<ListedEntry[]> {
    this.signal?.throwIfAborted();
    const directory = absolutePath(this.request.projectPath, relative);
    let names: string[];
    try {
      names = await fs.promises.readdir(directory);
    } catch (error) {
      if (isUnreachable(error)) return [];
      throw error;
    }
    this.plan.walked += names.length;
    if (this.plan.walked > this.limits.walkedEntries) {
      throw new WorktreeCopyLimitError(`${entry} has over ${this.limits.walkedEntries.toLocaleString('en-US')} entries to search`);
    }
    const listed: ListedEntry[] = [];
    for (let start = 0; start < names.length; start += LSTAT_BATCH_SIZE) {
      const batch = await Promise.all(names.slice(start, start + LSTAT_BATCH_SIZE).map(async (name): Promise<ListedEntry | null> => {
        const childPath = path.join(directory, name);
        try {
          const stats = await fs.promises.lstat(childPath);
          return { name, stats, isLink: await isLinkEntry(childPath, stats) };
        } catch (error) {
          if (isUnreachable(error)) return null;
          throw error;
        }
      }));
      for (const child of batch) {
        if (child) listed.push(child);
      }
    }
    return listed;
  }

  private addFile(relative: string, stats: Stats, entry: string): void {
    if (this.plan.files.has(relative)) return;
    this.plan.files.set(relative, stats);
    this.plan.bytes += stats.size;
    if (this.plan.files.size > this.limits.files) {
      throw new WorktreeCopyLimitError(`${entry} has over ${this.limits.files.toLocaleString('en-US')} files`);
    }
    if (this.plan.bytes > this.limits.bytes) {
      throw new WorktreeCopyLimitError(`${entry} is over ${this.limits.bytes / (1024 * 1024 * 1024)} GiB`);
    }
  }

  /**
   * Only a relative link that stays inside the folder being copied means the
   * same thing in the copy. Any other would reach back into the project.
   */
  private async addLink(relative: string, root: string): Promise<void> {
    const source = absolutePath(this.request.projectPath, relative);
    const target = await fs.promises.readlink(source).catch(() => null);
    if (target === null || path.isAbsolute(target)
      || !isPathInside(path.resolve(path.dirname(source), target), absolutePath(this.request.projectPath, root))) {
      this.plan.skippedLinks += 1;
      return;
    }
    this.plan.links.push({ relative, target });
  }
}

/**
 * Run `work` over `items`, `COPY_CONCURRENCY` at a time. Resolves or rejects
 * only once nothing is still running, so a failure or an abort leaves no write
 * in flight behind the caller.
 */
async function forEachConcurrently<Item>(items: Item[], work: (item: Item) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        signal?.throwIfAborted();
        await work(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }));
  if (failed) throw failure;
}

class WorktreeWriter {
  /** One promise per folder, so a second file waits for the first's `mkdir`. */
  private readonly directories = new Map<string, Promise<boolean>>();

  constructor(private readonly worktreePath: string) {}

  /** Make the folder under the worktree. False when a link or a file holds its path: nothing goes through one. */
  ensureDirectory(relative: string): Promise<boolean> {
    if (relative === '' || relative === '.') return Promise.resolve(true);
    let made = this.directories.get(relative);
    if (!made) {
      made = this.makeDirectory(relative);
      this.directories.set(relative, made);
    }
    return made;
  }

  private async makeDirectory(relative: string): Promise<boolean> {
    if (!(await this.ensureDirectory(path.posix.dirname(relative)))) return false;
    const destination = absolutePath(this.worktreePath, relative);
    const existing = await this.lstatIfPresent(destination);
    if (existing) return existing.isDirectory() && !(await isLinkEntry(destination, existing));
    try {
      await fs.promises.mkdir(destination);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    return true;
  }

  async lstatIfPresent(target: string): Promise<Stats | null> {
    try {
      return await fs.promises.lstat(target);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }
}

async function copyFile(
  request: CopyEntriesRequest,
  writer: WorktreeWriter,
  relative: string,
  stats: Stats,
): Promise<'copied' | 'unchanged' | 'skipped'> {
  if (!(await writer.ensureDirectory(path.posix.dirname(relative)))) return 'skipped';
  const source = absolutePath(request.projectPath, relative);
  const destination = absolutePath(request.worktreePath, relative);
  const existing = await writer.lstatIfPresent(destination);
  if (existing) {
    if (!existing.isFile()) return 'skipped';
    if (existing.size === stats.size && Math.abs(existing.mtimeMs - stats.mtimeMs) <= MODIFIED_TIME_TOLERANCE_MS) return 'unchanged';
    // The first copy kept the source's read-only bit, and a copy over it fails with EPERM.
    if (!(existing.mode & 0o200)) await fs.promises.unlink(destination);
  }
  try {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE);
  } catch (error) {
    // A cache folder changes while it is read. A file that left is not a failure.
    if (errorCode(error) === 'ENOENT') return 'skipped';
    throw error;
  }
  await fs.promises.utimes(destination, stats.atime, stats.mtime);
  return 'copied';
}

async function makeLink(request: CopyEntriesRequest, writer: WorktreeWriter, link: PlannedLink): Promise<boolean> {
  if (!(await writer.ensureDirectory(path.posix.dirname(link.relative)))) return false;
  const destination = absolutePath(request.worktreePath, link.relative);
  if (await writer.lstatIfPresent(destination)) return true;
  try {
    const resolved = path.resolve(path.dirname(absolutePath(request.projectPath, link.relative)), link.target);
    const isDirectory = (await fs.promises.stat(resolved).catch(() => null))?.isDirectory() ?? false;
    await fs.promises.symlink(link.target, destination, isDirectory ? 'dir' : 'file');
    return true;
  } catch {
    // Windows refuses a relative symlink without Developer Mode.
    return false;
  }
}

export async function copyEntries(
  request: CopyEntriesRequest,
  signal?: AbortSignal,
  limits: CopyLimits = COPY_LIMITS,
): Promise<CopyEntriesResult> {
  const planner = new CopyPlanner(request, limits, signal);
  for (const entry of request.entries) await planner.addEntry(entry);
  const { plan } = planner;

  const writer = new WorktreeWriter(request.worktreePath);
  await forEachConcurrently([...plan.directories], async (directory) => {
    await writer.ensureDirectory(directory);
  }, signal);

  const result: CopyEntriesResult = { copied: 0, unchanged: 0, skippedLinks: plan.skippedLinks };
  await forEachConcurrently([...plan.files], async ([relative, stats]) => {
    const outcome = await copyFile(request, writer, relative, stats);
    if (outcome === 'copied') result.copied += 1;
    else if (outcome === 'unchanged') result.unchanged += 1;
  }, signal);
  await forEachConcurrently(plan.links, async (link) => {
    if (!(await makeLink(request, writer, link))) result.skippedLinks += 1;
  }, signal);
  return result;
}
