import fs from 'node:fs';
import path from 'node:path';

/**
 * Every project root this run has known, for the Sentry event redaction
 * (src/main/analytics/redact-event-paths.ts).
 *
 * The home-directory rewrite cannot reach a project on another drive, and a
 * project's folder name can name a client or employer. A spawn that failed on a
 * full disk sent one whole to Sentry, issue title included (DESKTOP-21), the same
 * gap DESKTOP-1Z hit through a guarded write.
 *
 * Fed from the project repository's writes (`create`, `updatePath`) and a boot
 * seed of the global projects list (`rememberRegisteredRoots`). It is never read
 * from the database at report time, because `beforeSend` can run before the
 * global database opens and after shutdown closes it, and `getGlobalDb()` would
 * open the file itself.
 *
 * Each project's repository folder is remembered too, when it is not the project
 * folder, because git names it in its own errors (`<repository>/.git/index.lock`).
 * That is the nearest folder at or above the project with a `.git`, and for a
 * `.git` file (a linked worktree or a submodule) the repository the file points
 * into.
 *
 * Add-only for the run. A report raised while a project is deleted or moved, or
 * after, still names its old path, so a root is never dropped.
 *
 * No app imports, so the database layer can feed it without depending on analytics.
 */

const projectRoots = new Set<string>();
const repositoryLookups = new Set<string>();
let repositoryLookupChain: Promise<void> = Promise.resolve();

/**
 * The repository a `.git` file points into, or null when the file names no git directory. Its
 * `gitdir:` line names `<common>/worktrees/<name>` for a linked worktree, whose `commondir` file
 * names the shared git directory, and `<repository>/.git/modules/<name>` for a submodule. Git
 * writes the shared directory's paths in its own errors (a ref lock), so the folder remembered is
 * the one above that directory's `.git` segment, or the shared directory itself when it has none
 * (a bare repository, or a `--separate-git-dir` checkout).
 */
async function repositoryFromGitFile(directory: string, contents: string): Promise<string | null> {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) return null;
  const gitDirectory = path.resolve(directory, match[1]);
  const commonDirectoryLine = await fs.promises
    .readFile(path.join(gitDirectory, 'commondir'), 'utf8')
    .catch(() => null);
  const commonDirectory = commonDirectoryLine
    ? path.resolve(gitDirectory, commonDirectoryLine.trim())
    : gitDirectory;
  // Single separators, so the kept segments rejoin into the same path (a UNC
  // path's leading `\\` included).
  const segments = commonDirectory.split(/[\\/]/);
  const dotGitIndex = segments.lastIndexOf('.git');
  if (dotGitIndex === -1) return commonDirectory;
  const repository = segments.slice(0, dotGitIndex).join(path.sep);
  // A `.git` at the POSIX filesystem root leaves nothing to remember.
  return repository.length > 0 ? repository : null;
}

/** The folders git may name for a project: the nearest one at or above it holding `.git`,
 *  and for a `.git` file the repository it points into. */
async function repositoryFoldersOf(projectPath: string): Promise<string[]> {
  let directory = path.resolve(projectPath);
  for (;;) {
    const dotGit = path.join(directory, '.git');
    const stats = await fs.promises.stat(dotGit).catch(() => null);
    if (stats?.isDirectory()) return [directory];
    if (stats?.isFile()) {
      const repository = await repositoryFromGitFile(directory, await fs.promises.readFile(dotGit, 'utf8'));
      return repository ? [directory, repository] : [directory];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}

export function rememberProjectRoots(paths: Iterable<string>): void {
  for (const projectPath of paths) {
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue;
    projectRoots.add(projectPath);
    if (!path.isAbsolute(projectPath) || repositoryLookups.has(projectPath)) continue;
    repositoryLookups.add(projectPath);
    // Async, so main never waits on a disk. One at a time, because a project on an
    // unreachable network share holds a libuv thread until the share times out, and
    // main's other async file work shares those threads.
    repositoryLookupChain = repositoryLookupChain
      .then(() => repositoryFoldersOf(projectPath))
      .then((folders) => {
        for (const folder of folders) projectRoots.add(folder);
      })
      .catch(() => {
        // A folder that cannot be read leaves the project's own root, which is already known.
      });
  }
}

export function knownProjectRoots(): string[] {
  return [...projectRoots];
}
