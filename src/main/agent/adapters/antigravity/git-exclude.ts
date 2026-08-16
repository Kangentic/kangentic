import fs from 'node:fs';
import path from 'node:path';

/**
 * Hide Antigravity's Kangentic-written runtime files from git.
 *
 * The agy CLI has no per-spawn settings flag, so the event hooks and the MCP
 * plugin (which carries the per-launch `X-Kangentic-Token`) must live in the
 * WORKSPACE at `.agents/`. During a live session they therefore show up as
 * untracked files in `git status` - polluting the Changes pane and, far
 * worse, riding along with any `git add -A` an agent runs, which would land
 * the token in git history.
 *
 * `.git/info/exclude` is the local, never-committed ignore file, and for a
 * worktree it resolves to the repository's COMMON git dir, so one seeding
 * covers every worktree of the repo. Ignore rules only affect UNTRACKED
 * files, which gives exactly the wanted semantics: files Kangentic created
 * vanish from status and `add -A`, while a user's own TRACKED `.agents`
 * customizations keep their normal git visibility.
 */

const EXCLUDE_MARKER = '# kangentic: antigravity adapter runtime files (local ignore, safe to remove)';

/**
 * Resolve the directory whose `info/exclude` this checkout reads, following
 * the worktree indirection: a worktree's `.git` is a FILE with a
 * `gitdir: <path>` line, and that gitdir's `commondir` file points at the
 * repository's shared `.git`. Returns null when `directory` is not a git
 * checkout (spawns outside a repo simply skip the exclude seeding).
 */
export function resolveGitCommonDir(directory: string): string | null {
  const dotGit = path.join(directory, '.git');
  let gitDir: string;
  try {
    const stats = fs.statSync(dotGit);
    if (stats.isDirectory()) {
      gitDir = dotGit;
    } else {
      const match = fs.readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!match) return null;
      gitDir = path.resolve(directory, match[1].trim());
    }
  } catch {
    return null;
  }

  try {
    const commonDirPointer = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirPointer)) {
      const pointer = fs.readFileSync(commonDirPointer, 'utf-8').trim();
      return path.resolve(gitDir, pointer);
    }
  } catch {
    // Unreadable pointer - fall through to the gitdir itself.
  }
  return gitDir;
}

/**
 * Append `patterns` to the checkout's `.git/info/exclude` under a marker
 * comment, skipping ones already present. Best-effort and never throws: a
 * failure only means the runtime files stay visible in git status, exactly
 * the pre-seeding behavior.
 */
export function ensureLocalGitExcludes(directory: string, patterns: string[]): void {
  try {
    const commonDir = resolveGitCommonDir(directory);
    if (!commonDir) return;

    const excludePath = path.join(commonDir, 'info', 'exclude');
    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf-8');
    } catch {
      // No exclude file yet.
    }

    const existingLines = new Set(existing.split('\n').map((line) => line.trim()));
    const missing = patterns.filter((pattern) => !existingLines.has(pattern));
    if (missing.length === 0) return;

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const needsNewline = existing.length > 0 && !existing.endsWith('\n');
    const block = (existingLines.has(EXCLUDE_MARKER) ? [] : [EXCLUDE_MARKER])
      .concat(missing)
      .join('\n');
    fs.appendFileSync(excludePath, `${needsNewline ? '\n' : ''}${block}\n`);
  } catch (error) {
    console.error('[antigravity] Failed to seed .git/info/exclude', error);
  }
}
