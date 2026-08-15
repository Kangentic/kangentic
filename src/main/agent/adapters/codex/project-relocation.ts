import * as fs from 'node:fs';
import * as path from 'node:path';
import { replacePathPrefix } from '../../../../shared/paths';
import { atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import {
  withCodexConfigLock,
  configTomlPath,
  parseHeaderLine,
  stripLongPathPrefix,
  applyLongPathPrefix,
  normalizeForCompare,
  type ParsedHeader,
} from './config-toml';

/**
 * Migrate Codex CLI's per-project trust entry when a Kangentic project is
 * relocated.
 *
 * Codex resolves `codex resume <id>` purely by session id (the codex-rs
 * `find_thread_path_by_id_str` falls back to a filename scan of
 * `~/.codex/sessions/`), so resume keeps working after a move and the rollout
 * JSONLs are deliberately NOT touched. The cwd recorded inside each rollout only
 * affects the cwd-filtered resume picker (which has an `--all` escape hatch), so
 * rewriting it would be invasive for little gain.
 *
 * The one thing that breaks is the per-project trust decision in
 * `~/.codex/config.toml`, stored as single-line table headers:
 *   [projects.'C:/Users/dev/proj']        trust_level = "trusted"
 *   [projects.'\\?\C:\Users\dev\proj']    (long-path prefixed variant)
 * After a move the old header no longer matches the new cwd, so Codex re-prompts
 * for trust. This migration rewrites those header paths line-by-line, preserving
 * the original quote character, long-path prefix, and separator style, without a
 * full TOML parser. A rewrite whose target table already exists is skipped (a
 * duplicate `[projects.'...']` table would make config.toml unparsable for
 * Codex itself).
 *
 * Best-effort and non-destructive under a serial lock; config.toml is backed up
 * and written atomically, and only matching header lines are touched.
 */
export async function migrateCodexProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  return withCodexConfigLock(() => migrateCodexProjectDataSync(oldProjectPath, newProjectPath));
}

function migrateCodexProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  let content: string;
  try {
    content = fs.readFileSync(configTomlPath(), 'utf-8');
  } catch {
    return; // No config.toml: nothing to migrate.
  }

  const lines = content.split('\n');

  // Pass 1: collect the normalized path of every existing project header so a
  // rewrite that collides with an existing table can be skipped.
  const existingHeaderPaths = new Set<string>();
  for (const line of lines) {
    const parsed = parseHeaderLine(line);
    if (parsed) existingHeaderPaths.add(normalizeForCompare(parsed.innerPath));
  }

  // Pass 2: rewrite matching headers.
  let changed = false;
  const rewrittenLines = lines.map((line) => {
    const parsed = parseHeaderLine(line);
    if (!parsed) return line;

    const compare = stripLongPathPrefix(parsed.innerPath);
    const rewritten = replacePathPrefix(compare, oldResolved, newResolved);
    if (!rewritten) return line;

    if (existingHeaderPaths.has(normalizeForCompare(applyLongPathPrefix(rewritten, parsed.hadLongPathPrefix)))) {
      return line; // Target table already exists; skipping avoids a duplicate TOML table.
    }

    const emitted = emitHeaderValue(rewritten, parsed);
    if (emitted === null) return line; // Cannot represent safely in the original quote style.
    changed = true;
    return `${parsed.prefix}${emitted}${parsed.suffix}`;
  });

  if (!changed) return;
  atomicWriteFileWithBackup(configTomlPath(), rewrittenLines.join('\n'), { logTag: '[CODEX_RELOCATE]' });
}

/**
 * Re-emit the rewritten path as a quoted TOML key, preserving the original
 * quote character, long-path prefix, and forward-vs-backslash style. Returns
 * null when the value cannot be represented in the original quote style.
 */
function emitHeaderValue(rewrittenNative: string, parsed: ParsedHeader): string | null {
  const strippedOriginal = stripLongPathPrefix(parsed.innerPath);
  const usesForwardSlashOnly =
    !parsed.hadLongPathPrefix && strippedOriginal.includes('/') && !strippedOriginal.includes('\\');

  let value = usesForwardSlashOnly ? rewrittenNative.replace(/\\/g, '/') : rewrittenNative;
  value = applyLongPathPrefix(value, parsed.hadLongPathPrefix);

  if (parsed.quote === "'") {
    if (value.includes("'")) return null; // Single-quoted TOML cannot contain a single quote.
    return `'${value}'`;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
