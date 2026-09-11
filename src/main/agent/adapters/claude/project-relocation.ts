import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { toForwardSlash, replacePathPrefix } from '../../../../shared/paths';
import {
  collectRelocationPairs,
  renameOrMergeDirectory,
  atomicWriteFileWithBackup,
  type RelocationPathPair,
} from '../../shared/relocation-utils';
import { claudeProjectSlug } from './transcript-parser';
import { isClaudeJsonLockError, withClaudeJsonLock } from './claude-json-lock';

/**
 * Migrate Claude Code's per-project data when a Kangentic project is relocated.
 *
 * Claude Code keys two stores to the absolute project path, both living OUTSIDE
 * the project folder, so a move or rename orphans them (sessions then fail to
 * resume with "No conversation found with session ID"):
 *
 * 1. Transcripts + auto-memory under `~/.claude/projects/<slug>/`, where
 *    `<slug>` is derived from the cwd (see `claudeProjectSlug`).
 * 2. Per-project state in `~/.claude.json` under the top-level `projects`
 *    object, keyed by the absolute path (trust decision, allowed tools, MCP
 *    approvals, prompt history).
 *
 * Claude is spawned with cwd = the project root AND with cwd = each worktree
 * under `<project>/.kangentic/worktrees/`, so both stores hold one entry per
 * cwd. The worktrees move with the project folder, so we reconstruct their old
 * paths by listing the relocated folder; deleted worktrees that still have a
 * `~/.claude.json` key are caught by passing those keys as additional candidates.
 *
 * Safety: best-effort and non-destructive. Directories are renamed or merged
 * (never deleted); `~/.claude.json` is backed up to `~/.claude.json.kangentic-backup`
 * and written atomically before the original is replaced. Every step is wrapped
 * in try/catch so a partial failure degrades to today's behavior (orphaned
 * data), never to data loss.
 *
 * Concurrency caveat: a live Claude session in ANOTHER project or an external
 * terminal keeps `~/.claude.json` in memory and may overwrite our key rewrite
 * when it next saves. That cannot be detected without violating the adapter
 * boundary, and blocking relocation on unrelated sessions would be hostile, so
 * we proceed. The consequence is limited to a re-shown trust prompt and lost
 * prompt history for the relocated project; session resume still works because
 * the transcript directory rename is independent of `~/.claude.json`. The
 * backup mitigates the rest. The lock (claude-json-lock.ts) serializes
 * Kangentic's own writers AND takes Claude's `~/.claude.json.lock`, so a CLI
 * write in flight at this moment is waited for rather than overwritten; the
 * in-memory state of a session that saves later is what the caveat above is
 * about. A lock held past its budget skips the whole migration (Claude's own
 * final-ELOCKED policy), which degrades to the orphaned-data behavior.
 */
export async function migrateClaudeProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  try {
    await withClaudeJsonLock(() => migrateClaudeProjectDataSync(oldProjectPath, newProjectPath));
  } catch (error) {
    if (!isClaudeJsonLockError(error)) throw error;
    console.warn(`[CLAUDE_RELOCATE] Skipping the ~/.claude.json migration; ${error.message}`);
  }
}

function migrateClaudeProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const pairs = collectRelocationPairs(oldResolved, newResolved, readClaudeJsonProjectKeys());
  migrateTranscriptDirectories(pairs);
  rewriteClaudeJson(oldResolved, newResolved);
}

/**
 * Read the `~/.claude.json` projects keys so worktrees deleted from disk (whose
 * keys/transcripts persist) are still migrated. Returns [] when the file is
 * missing or unparsable.
 */
function readClaudeJsonProjectKeys(): string[] {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    const projects = data.projects;
    if (projects && typeof projects === 'object') {
      return Object.keys(projects);
    }
  } catch {
    // Missing or unparsable ~/.claude.json: keys handled (or skipped) later.
  }
  return [];
}

/**
 * Rename each pair's transcript directory under `~/.claude/projects/` from the
 * old slug to the new slug. When the target already exists (the user opened
 * Claude at the new location before relocating in Kangentic), entries are merged
 * in rather than skipped, so old transcripts are never orphaned.
 */
function migrateTranscriptDirectories(pairs: RelocationPathPair[]): void {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

  for (const pair of pairs) {
    try {
      const sourceDir = resolveSourceTranscriptDir(projectsRoot, pair.oldAbsolute);
      if (!sourceDir) continue; // No transcripts for this cwd; common, skip silently.
      const targetDir = path.join(projectsRoot, claudeProjectSlug(pair.newAbsolute));
      renameOrMergeDirectory(sourceDir, targetDir);
    } catch (err) {
      console.warn(`[CLAUDE_RELOCATE] Failed to migrate transcripts for ${pair.oldAbsolute}:`, err);
    }
  }
}

/**
 * Find the existing transcript directory for an old cwd. The slug is
 * separator-agnostic for the common case, but a path long enough to be
 * truncated carries a hash of the original string whose separator form (native
 * vs forward-slash) we cannot know, so probe both candidates.
 */
function resolveSourceTranscriptDir(projectsRoot: string, oldAbsolute: string): string | null {
  const candidates = [
    path.join(projectsRoot, claudeProjectSlug(oldAbsolute)),
    path.join(projectsRoot, claudeProjectSlug(toForwardSlash(oldAbsolute))),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Rewrite `~/.claude.json` projects keys from old paths to new paths, backing
 * the file up first and writing atomically. Keys are re-emitted in forward-slash
 * form (Claude's convention on all platforms) with their values carried verbatim.
 */
function rewriteClaudeJson(oldResolved: string, newResolved: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return; // Missing or unparsable: leave it untouched. Transcripts already moved.
  }

  const projects = data.projects;
  if (!projects || typeof projects !== 'object') return;
  const projectEntries = projects as Record<string, unknown>;

  // Compute rewrites first; if nothing matches, do not touch the file at all.
  const rewrites = new Map<string, string>();
  for (const key of Object.keys(projectEntries)) {
    const rewritten = replacePathPrefix(key, oldResolved, newResolved);
    if (rewritten) rewrites.set(key, toForwardSlash(rewritten));
  }
  if (rewrites.size === 0) return;

  // Rebuild projects preserving entry order. When a destination key already
  // exists (Claude already ran at the new path), keep the fresher destination
  // value and drop the dead old key.
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projectEntries)) {
    const target = rewrites.get(key);
    if (!target) {
      if (!(key in rebuilt)) rebuilt[key] = value;
      continue;
    }
    if (target in projectEntries || target in rebuilt) continue; // Destination already present; keep it.
    rebuilt[target] = value;
  }
  data.projects = rebuilt;

  atomicWriteFileWithBackup(claudeJsonPath, JSON.stringify(data, null, 2), { logTag: '[CLAUDE_RELOCATE]' });
}
