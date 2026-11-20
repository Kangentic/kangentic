import { RefusalError } from '../../../../shared/refusal';
import type { RepoFolderEntry } from '../../../../shared/types';

/**
 * The files of one commit as folders, built from `git ls-tree -r --name-only`.
 * Git tracks no empty folder, so every folder here holds at least one file
 * somewhere below it.
 */
export interface FolderNode {
  /** Names of the files directly in this folder. */
  files: string[];
  folders: Map<string, FolderNode>;
}

/** One direct child of a source's folder that imports as a task. */
export interface RepoFolderItem {
  /** The child's own name: the task's title and its id. */
  name: string;
  kind: 'file' | 'folder';
  /** Repo-relative path of the child, no trailing slash. */
  path: string;
  /**
   * What the task's description lists: a folder's top-level files and
   * subfolders (subfolders end in `/`), or a file's own path. Repo-relative.
   */
  contents: string[];
}

function emptyNode(): FolderNode {
  return { files: [], folders: new Map() };
}

/** Build the folder tree from repo-relative, `/`-separated file paths. */
export function buildFolderTree(filePaths: readonly string[]): FolderNode {
  const root = emptyNode();
  for (const filePath of filePaths) {
    if (!filePath) continue;
    const segments = filePath.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      let child = node.folders.get(segment);
      if (!child) {
        child = emptyNode();
        node.folders.set(segment, child);
      }
      node = child;
    }
    node.files.push(segments[segments.length - 1]);
  }
  return root;
}

/**
 * The typed or picked folder as a repo-relative path: `/` separators, no
 * leading `./` or `/`, no trailing `/`. A blank folder, or one that climbs out
 * of the repository, is refused.
 */
export function normalizeRepoFolder(folder: string): string {
  const segments = folder
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new RefusalError('Name a folder in the repository.');
  if (segments.includes('..')) throw new RefusalError(`Not a folder in the repository: ${folder.trim()}`);
  return segments.join('/');
}

/** The node at a repo-relative folder path, or null when the commit has no such folder. */
export function findFolder(root: FolderNode, folderPath: string): FolderNode | null {
  let node: FolderNode | undefined = root;
  for (const segment of folderPath.split('/')) {
    node = node.folders.get(segment);
    if (!node) return null;
  }
  return node;
}

/**
 * A dot-file or dot-folder, or a README (`README`, `README.md`,
 * `readme.en.md`): never a task of its own. A name that only starts with
 * "readme" (`readme-assets/`) is an item like any other.
 */
function isSkippedName(name: string): boolean {
  return name.startsWith('.') || /^readme(\.|$)/i.test(name);
}

function joinPath(folderPath: string, name: string): string {
  return folderPath ? `${folderPath}/${name}` : name;
}

/** Code-unit order, so the listing does not change with the machine's locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A child folder's top-level files that are not dot-files: none means it imports nothing. */
function visibleFilesOf(child: FolderNode): string[] {
  return child.files.filter((fileName) => !fileName.startsWith('.'));
}

/**
 * The direct children of `node` that import as tasks. A file counts unless it is
 * a dot-file or a README. A folder counts only when it holds a top-level file
 * that is not a dot-file, so an `archive/` of subfolders and a `.gitkeep` drops
 * out. The one classifier Browse's counts and the Import list both use.
 */
export function folderItems(node: FolderNode, folderPath: string): RepoFolderItem[] {
  const items: RepoFolderItem[] = [];
  for (const [name, child] of node.folders) {
    if (isSkippedName(name)) continue;
    const visibleFiles = visibleFilesOf(child);
    if (visibleFiles.length === 0) continue;
    const childPath = joinPath(folderPath, name);
    const subfolders = [...child.folders.keys()].filter((subfolder) => !subfolder.startsWith('.'));
    items.push({
      name,
      kind: 'folder',
      path: childPath,
      contents: [
        ...visibleFiles.sort(compareText).map((fileName) => joinPath(childPath, fileName)),
        ...subfolders.sort(compareText).map((subfolder) => `${joinPath(childPath, subfolder)}/`),
      ],
    });
  }
  for (const fileName of node.files) {
    if (isSkippedName(fileName)) continue;
    const filePath = joinPath(folderPath, fileName);
    items.push({ name: fileName, kind: 'file', path: filePath, contents: [filePath] });
  }
  return items.sort((itemA, itemB) => compareText(itemA.name, itemB.name));
}

/** How many of `node`'s children `folderItems` would list, without building their contents. */
function countFolderItems(node: FolderNode): number {
  let count = 0;
  for (const [name, child] of node.folders) {
    if (!isSkippedName(name) && visibleFilesOf(child).length > 0) count += 1;
  }
  for (const fileName of node.files) {
    if (!isSkippedName(fileName)) count += 1;
  }
  return count;
}

/**
 * Every folder of the tree that would import at least one task, with its count,
 * sorted by path. Folders under a dot-folder (`.github`, `.claude`) are left out
 * of the list; a typed path still reaches them.
 */
export function listImportableFolders(root: FolderNode): RepoFolderEntry[] {
  const entries: RepoFolderEntry[] = [];
  const visit = (node: FolderNode, folderPath: string) => {
    for (const [name, child] of node.folders) {
      if (name.startsWith('.')) continue;
      const childPath = joinPath(folderPath, name);
      const itemCount = countFolderItems(child);
      if (itemCount > 0) entries.push({ path: childPath, itemCount });
      visit(child, childPath);
    }
  };
  visit(root, '');
  return entries.sort((entryA, entryB) => compareText(entryA.path, entryB.path));
}

/** A task description that lists the item's paths, one per line. */
export function itemDescription(item: RepoFolderItem): string {
  return item.contents.map((contentPath) => `- ${contentPath}`).join('\n');
}
