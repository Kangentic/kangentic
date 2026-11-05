import { promises as fsPromises, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Windows keeps every path as given. A relative one would resolve against this process's cwd. */
function staysAsGiven(candidatePath: string): boolean {
  return process.platform === 'win32' || !path.isAbsolute(candidatePath);
}

/**
 * A folder's path as a process running in it reads its cwd: every symlink
 * resolved, the way `getcwd` reports it. Claude files its trust entries and its
 * transcripts under that path, and macOS's temp folder sits behind a link
 * (`/var` is `/private/var`). A folder that is gone resolves through its nearest
 * existing parent, which covers a project just moved away from its old path.
 *
 * Unchanged on Windows: realpath there follows junctions and subst drives, and
 * Claude keys trust by the path as given.
 *
 * In a file of its own because the transcript locator runs in the retrieval
 * worker too, and this needs nothing but the file system.
 */
export async function physicalPath(resolvedPath: string): Promise<string> {
  if (staysAsGiven(resolvedPath)) return resolvedPath;
  const missingSegments: string[] = [];
  let existing = resolvedPath;
  for (;;) {
    try {
      return path.join(await fsPromises.realpath(existing), ...missingSegments);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolvedPath;
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * `physicalPath` for a caller that cannot wait, the spawn's command build. The
 * two must agree: one files a `~/.claude.json` entry the other looks up.
 * `fsPromises.realpath` is the native call too, so they resolve alike.
 */
export function physicalPathSync(resolvedPath: string): string {
  if (staysAsGiven(resolvedPath)) return resolvedPath;
  const missingSegments: string[] = [];
  let existing = resolvedPath;
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...missingSegments);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolvedPath;
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
