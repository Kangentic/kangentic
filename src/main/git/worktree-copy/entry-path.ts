import path from 'node:path';

/**
 * What an entry of `git.copyFiles` or `git.linkFolders` may name. Pure, so the
 * worker, main and the tests read one definition. Every relative path here is
 * forward-slashed, on every platform, as the glob matcher wants.
 */

/** Folders no entry may reach, at any depth. */
const REFUSED_SEGMENTS = new Set(['.git', '.kangentic']);

/** Folders a walk never enters, at any depth. An entry may still name `node_modules` itself. */
export const PRUNED_FOLDER_NAMES: ReadonlySet<string> = new Set(['.git', '.kangentic', 'node_modules']);

const GLOB_MAGIC = /[*?[{]|[!+@]\(/;

/** A forward-slashed relative path on this platform, under `root`. */
export function absolutePath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

/**
 * The entry as a forward-slashed path relative to the project, or null for one
 * that cannot be: empty, absolute, climbing out with `..`, or reaching into
 * `.git` or `.kangentic`, where `**` would otherwise walk every other worktree.
 * A drive-relative `C:foo` is absolute for this purpose. Windows drops a
 * segment's trailing dots and spaces, so `.git.` reaches `.git` and is refused.
 */
export function normalizeEntry(entry: string): string | null {
  const slashed = entry.trim().replaceAll('\\', '/').replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '');
  if (!slashed || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const segments = slashed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (REFUSED_SEGMENTS.has(segment.toLowerCase().replace(/[. ]+$/, ''))) return null;
  }
  return slashed;
}

export function hasGlobMagic(entry: string): boolean {
  return GLOB_MAGIC.test(entry);
}

/** The folders ahead of a glob's first magic segment: where its walk starts. Empty for the project root. */
export function globBaseSegments(glob: string): string[] {
  const segments = glob.split('/');
  const firstMagic = segments.findIndex((segment) => hasGlobMagic(segment));
  return firstMagic === -1 ? segments : segments.slice(0, firstMagic);
}

/** How deep under the project a glob can match, or null when `**` lets it match at any depth. */
export function globMaxDepth(glob: string): number | null {
  const segments = glob.split('/');
  return segments.some((segment) => segment.includes('**')) ? null : segments.length;
}

/** True for `folder` or anything under it. Case-insensitive, the safe direction on every platform. */
export function isAtOrUnder(relative: string, folder: string): boolean {
  const relativeLower = relative.toLowerCase();
  const folderLower = folder.toLowerCase();
  return relativeLower === folderLower || relativeLower.startsWith(`${folderLower}/`);
}

/**
 * Hooks reach an agent through `--settings`, and sparse-checkout keeps
 * `.claude/` apart, so nothing under the root's `.claude` is ever copied.
 */
export function isClaudePath(relative: string): boolean {
  return isAtOrUnder(relative, '.claude');
}

/**
 * The folders a link fills in a worktree. A copy never walks one and never
 * writes under one: a write there lands in the main checkout.
 */
export function linkedFoldersOf(setup: { linkNodeModules?: boolean; linkFolders?: string[] }): string[] {
  const folders = (setup.linkNodeModules ?? true) ? ['node_modules'] : [];
  for (const entry of setup.linkFolders ?? []) {
    const folder = normalizeEntry(entry);
    if (folder) folders.push(folder);
  }
  return folders;
}
