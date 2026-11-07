import path from 'node:path';
import type { Stats } from 'node:fs';
import fs from './original-fs';

/**
 * True for a symlink, and on Windows for a junction. Windows `lstat` can call
 * a junction a directory, so a `readlink` probe decides there, as
 * `isJunction` in `node-modules-link.ts` does. Unlike that one it fails
 * closed: only EINVAL (libuv's answer for a directory that is not a reparse
 * point) means a real directory. Any other error leaves the caller unable to
 * tell, and entering a junction reaches what it points at, so it throws.
 */
export async function isLinkEntry(entryPath: string, stats: Stats): Promise<boolean> {
  if (stats.isSymbolicLink()) return true;
  if (process.platform !== 'win32' || !stats.isDirectory()) return false;
  try {
    await fs.promises.readlink(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EINVAL') return false;
    throw error;
  }
}

/** False when `target` is gone or plainly not a link. Anything it cannot tell reads as a link. Never throws. */
export async function mayBeLink(target: string): Promise<boolean> {
  try {
    return await isLinkEntry(target, await fs.promises.lstat(target));
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
  }
}

/** True when a segment of the forward-slashed `relative` under `root` may be a link. Never throws. */
export async function hasLinkOnPath(root: string, relative: string): Promise<boolean> {
  let current = root;
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    current = path.join(current, segment);
    if (await mayBeLink(current)) return true;
  }
  return false;
}
