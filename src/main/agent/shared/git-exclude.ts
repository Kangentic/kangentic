import fs from 'node:fs';
import path from 'node:path';

/**
 * Hide Kangentic-written agent runtime files from git.
 *
 * Several agent CLIs have no per-spawn settings flag, so their event hooks
 * and MCP wiring (sometimes carrying the per-launch `X-Kangentic-Token`)
 * must live in the WORKSPACE (`.agents/`, `.gemini/`, `.qwen/`, `.factory/`,
 * `.grok/`, ...). During a live session those files show up as untracked in
 * `git status` - polluting the Changes pane and, far worse, riding along
 * with any `git add -A` an agent runs, which would land the token in git
 * history.
 *
 * `.git/info/exclude` is the local, never-committed ignore file, and for a
 * worktree it resolves to the repository's COMMON git dir, so one seeding
 * covers every worktree of the repo. Ignore rules only affect UNTRACKED
 * files, which gives exactly the wanted semantics: files Kangentic created
 * vanish from status and `add -A`, while a user's own TRACKED files keep
 * their normal git visibility. The created-by-us carve-out for shared-name
 * files (a settings file the user may own and commit) is caller-side
 * policy: an adapter excludes such a file only when Kangentic is about to
 * create it, checked with `fs.existsSync` BEFORE its write.
 */

const EXCLUDE_MARKER = '# kangentic: agent runtime files (local ignore, safe to remove)';

// Any prior Kangentic marker line (including the legacy adapter-branded
// "# kangentic: antigravity adapter runtime files ..." one) counts as
// "marker already present", so re-seeding never stacks a second marker.
const EXCLUDE_MARKER_PREFIX = '# kangentic:';

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

    const hasMarker = [...existingLines].some((line) => line.startsWith(EXCLUDE_MARKER_PREFIX));
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const needsNewline = existing.length > 0 && !existing.endsWith('\n');
    const block = (hasMarker ? [] : [EXCLUDE_MARKER])
      .concat(missing)
      .join('\n');
    fs.appendFileSync(excludePath, `${needsNewline ? '\n' : ''}${block}\n`);
  } catch (error) {
    console.error('[git-exclude] Failed to seed .git/info/exclude', error);
  }
}
