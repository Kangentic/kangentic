import fs from 'node:fs';
import path from 'node:path';
import { collectRelocationPairs, renameOrMergeDirectory, atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import { grokHomeDir, cwdToSessionsDirName } from './session-paths';
import { normalizeForCompare } from './trust-manager';

/**
 * Migrate Grok Build's per-project data when a Kangentic project (or a
 * single task worktree) is relocated.
 *
 * Two path-keyed stores live OUTSIDE the project folder:
 *
 * 1. `~/.grok/sessions/<encodeURIComponent(cwd)>/` - the per-cwd session
 *    store. Renaming the encoded directory keeps `--resume`, the telemetry
 *    tail, and the transcript parser pointed at the moved data (the Droid
 *    slug-rename precedent).
 * 2. `~/.grok/trusted_folders.toml` - folder-trust entries keyed by the
 *    absolute path. Header paths under the old location are rewritten so
 *    the relocated project keeps its trust decision (the Codex
 *    `[projects.'...']` precedent).
 *
 * Best-effort and non-destructive throughout: directories are renamed or
 * merged (never deleted), the TOML rewrite goes through backup + rename,
 * and every pair is guarded so a partial failure never blocks relocation.
 */
export async function migrateGrokProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  const sessionsRoot = path.join(grokHomeDir(), 'sessions');
  const pairs = collectRelocationPairs(oldProjectPath, newProjectPath);

  for (const pair of pairs) {
    try {
      renameOrMergeDirectory(
        path.join(sessionsRoot, cwdToSessionsDirName(pair.oldAbsolute)),
        path.join(sessionsRoot, cwdToSessionsDirName(pair.newAbsolute)),
      );
    } catch (err) {
      console.warn(`[GROK_RELOCATE] Failed to migrate sessions for ${pair.oldAbsolute}:`, err);
    }
  }

  try {
    rewriteTrustedFolderPaths(pairs);
  } catch (err) {
    console.warn('[GROK_RELOCATE] Failed to rewrite trusted_folders.toml:', err);
  }
}

function rewriteTrustedFolderPaths(
  pairs: Array<{ oldAbsolute: string; newAbsolute: string }>,
): void {
  const storePath = path.join(grokHomeDir(), 'trusted_folders.toml');
  let content: string;
  try {
    content = fs.readFileSync(storePath, 'utf-8');
  } catch {
    return;
  }

  let changed = false;
  const rewritten = content.split('\n').map((line) => {
    // Accept BOTH TOML key quote styles, matching trust-manager.ts's
    // parseHeaderLine - grok itself writes single-quoted literals, but a
    // double-quoted entry is legal TOML and must not be silently left
    // pointing at the old path.
    const match = line.match(/^(\s*\[folders\.)(?:'([^']+)'|"([^"]+)")(\]\s*)$/);
    if (!match) return line;
    const headerPath = match[2] ?? match[3];
    for (const pair of pairs) {
      if (pathsEqual(headerPath, pair.oldAbsolute)) {
        // A path containing a single quote cannot be a TOML literal key.
        if (pair.newAbsolute.includes("'")) return line;
        changed = true;
        // Always rewrite as a single-quoted literal: the new path is
        // emitted raw, and a basic (double-quoted) string would need
        // backslash escaping on Windows paths.
        return `${match[1]}'${path.resolve(pair.newAbsolute)}'${match[4]}`;
      }
    }
    return line;
  });

  if (!changed) return;
  atomicWriteFileWithBackup(storePath, rewritten.join('\n'), { logTag: '[GROK_RELOCATE]' });
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}
