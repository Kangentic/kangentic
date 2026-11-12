import fs from 'node:fs';
import path from 'node:path';
import { resolveGitCommonDir, resolveGitDir } from '../../shared/git-exclude';
import { claudeProjectSlug } from './transcript-parser';

/**
 * An account session's auto memory folder, named by its real path in the default home (task #1070).
 *
 * Claude keeps a project's auto memory in `<config dir>/projects/<project>/memory/`, and its docs
 * exempt Markdown there from the protected-path prompt. In an account folder that path runs through
 * the `projects` link into `~/.claude`, and Claude checks a Write where it lands too: measured on
 * 2.1.322, every memory Write through the link prompted ("a sensitive file") in default and
 * acceptEdits mode. With `autoMemoryDirectory` naming the same folder by its real path, the Write
 * went through with no prompt, so memory stays one folder that every account writes.
 *
 * `<project>` is Claude's slug of the main checkout's folder: measured for a worktree and for a
 * folder inside a repository, both named after the folder holding the shared `.git`, for a
 * separate git directory after the checkout, and outside git after the session's folder itself.
 */

/**
 * The folder Claude names a session's auto memory after, or null when it cannot be told. A checkout
 * whose git directory sits apart (`git init --separate-git-dir`) is named after itself, measured.
 * A linked worktree of such a repository has no `.git` folder to find its main checkout by, and was
 * not measured.
 */
export function claudeMemoryProjectFolder(cwd: string): string | null {
  let directory = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(directory, '.git'))) {
      const commonDirectory = resolveGitCommonDir(directory);
      if (!commonDirectory) return null;
      if (path.basename(commonDirectory) === '.git') return path.dirname(commonDirectory);
      // The common directory is the checkout's own git directory only when it is not a worktree's.
      const gitDirectory = resolveGitDir(directory);
      const isLinkedWorktree = gitDirectory !== null && fs.existsSync(path.join(gitDirectory, 'commondir'));
      return isLinkedWorktree ? null : directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(cwd);
    directory = parent;
  }
}

/** True when the settings file at `settingsPath` sets `autoMemoryDirectory` itself. */
function namesOwnMemoryFolder(settingsPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && 'autoMemoryDirectory' in parsed;
  } catch {
    return false;
  }
}

/**
 * The `autoMemoryDirectory` an account session's `--settings` sets, or null to set none: the
 * session runs on the agent's own home, the user named a folder of their own (in the account's
 * copy of their settings, or the project's), or the folder cannot be told.
 */
export function accountAutoMemoryDirectory(input: {
  /** The account folder the session runs on (`CLAUDE_CONFIG_DIR`), or null for the agent's own home. */
  accountFolder: string | null;
  defaultHome: string;
  cwd: string;
  /** The project and local settings the session file starts from. */
  baseSettings: Record<string, unknown>;
}): string | null {
  if (!input.accountFolder) return null;
  if ('autoMemoryDirectory' in input.baseSettings) return null;
  if (namesOwnMemoryFolder(path.join(input.accountFolder, 'settings.json'))) return null;
  const projectFolder = claudeMemoryProjectFolder(input.cwd);
  if (!projectFolder) return null;
  return path.join(input.defaultHome, 'projects', claudeProjectSlug(projectFolder), 'memory');
}
