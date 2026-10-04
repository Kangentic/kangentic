/**
 * The directories a task's processes are allowed to be reaped in: its project
 * (which holds `.kangentic/worktrees/`, so it outlives a deleted worktree) and
 * its worktree. Each is kept as stored and as its native real path, because a
 * process reports whichever form it was started with: a junction, a `subst`
 * drive, `/tmp` against `/private/tmp`, or an 8.3 short name all differ from
 * the stored string.
 *
 * A directory that would admit unrelated processes is never a root: a
 * filesystem root, a drive root, or the user's home directory (a project
 * opened at home, where daemons such as a Gradle store live, would otherwise
 * stop the directory test from meaning anything).
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function comparable(directory: string): string {
  // The same prefix handling as reap-plan.ts's normalizeDirectory, so a
  // `\\?\UNC\server\share` root reads as the share root it is and is refused.
  const normalized = directory
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '');
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

/** Whether a directory may be a reap root (see the module comment). */
export function isUsableReapRoot(directory: string, homeDirectory: string = os.homedir()): boolean {
  if (!path.isAbsolute(directory)) return false;
  const normalized = comparable(directory);
  if (normalized === '' || /^[a-z]:$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized)) return false;
  return normalized !== comparable(homeDirectory);
}

/** Every usable form of the task's project and worktree directories. */
export async function resolveTaskDirectories(
  projectPath: string | null | undefined,
  worktreePath: string | null | undefined,
  homeDirectory: string = os.homedir(),
): Promise<string[]> {
  const stored = [projectPath, worktreePath].filter((directory): directory is string => (
    typeof directory === 'string' && directory.length > 0
  ));
  // Home has two forms as well (`/home` is a link to `/var/home` on some Linux
  // distributions), so a directory with ANY form matching either form of home
  // is dropped whole: keeping its other form would make home a root after all.
  const realHome = await fsPromises.realpath(homeDirectory).catch(() => homeDirectory);
  const homeForms = new Set([homeDirectory, realHome].map(comparable));
  const groups = await Promise.all(stored.map(async (directory) => (
    [directory, await fsPromises.realpath(directory).catch(() => directory)]
  )));
  const outsideHome = groups.filter((forms) => !forms.some((form) => homeForms.has(comparable(form))));
  return [...new Set(outsideHome.flat())].filter((directory) => isUsableReapRoot(directory, homeDirectory));
}
