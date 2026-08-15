import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import {
  withCodexConfigLock,
  configTomlPath,
  readTrustLevel,
  parseHeaderLine,
  normalizeForCompare,
} from './config-toml';

/**
 * Pre-approve Codex's per-directory trust for a spawn directory, so a
 * Kangentic-launched session does not stop on
 * "Do you trust the contents of this directory?".
 *
 * Codex records the decision in `~/.codex/config.toml`:
 *
 *   [projects.'C:\Users\dev\proj']
 *   trust_level = "trusted"
 *
 * Measured against codex-cli 0.141.0, and this is why the pre-approval has
 * to exist rather than relying on the user answering once:
 *
 * - Trust is keyed on the GIT REPO ROOT, and it is NOT inherited by nested
 *   repositories. Trusting a parent directory does nothing for a repo
 *   inside it.
 * - Every Kangentic task gets its own git worktree, and a worktree is its
 *   own repo root. So accepting the prompt records only THAT worktree, and
 *   the next task prompts again. There is no answer the user can give once
 *   that covers future tasks.
 * - The per-invocation `-c` override does not work here: trust is resolved
 *   before config overrides are applied (verified with a project-local
 *   `.codex/config.toml` marker, which stayed unloaded under
 *   `-c projects.'<path>'.trust_level=trusted`). A file write is the only
 *   mechanism Codex offers.
 *
 * This mirrors what Kangentic already does for Claude
 * (`hasTrustDialogAccepted` in `~/.claude.json`), Gemini, and Qwen
 * (`trustedFolders.json`). The trust boundary is Kangentic itself: the user
 * opened this project, and the directory being approved is a worktree
 * Kangentic created from it.
 *
 * The one thing it will not do is overrule the user. An explicit
 * `trust_level` already recorded for the directory is left alone (so a
 * deliberate `"untrusted"` stays), and a project root explicitly marked
 * `"untrusted"` suppresses approval for the worktrees under it.
 */
export async function ensureWorktreeTrust(workingDirectory: string): Promise<void> {
  return withCodexConfigLock(() => ensureWorktreeTrustSync(workingDirectory));
}

/**
 * Recover the owning project root from a Kangentic worktree path, which
 * always lives at `<projectRoot>/.kangentic/worktrees/<slug>`. Returns null
 * for a spawn directly in the project root. Same marker Claude's
 * trust-manager uses to find the parent entry.
 */
function projectRootForWorktree(resolvedPath: string): string | null {
  const marker = `${path.sep}.kangentic${path.sep}worktrees${path.sep}`;
  const markerIndex = resolvedPath.indexOf(marker);
  return markerIndex === -1 ? null : resolvedPath.substring(0, markerIndex);
}

/**
 * Drop the trust table for a worktree Kangentic has just deleted.
 *
 * Trust is keyed per directory and cannot be inherited, so without this a
 * project accumulates one dead `[projects.'...']` table per task, forever.
 * (One developer machine had 473 such entries before this existed.)
 *
 * Only a table whose sole key is `trust_level` is removed: anything else in
 * there was put there by the user or a future Codex, and is left alone even
 * though the directory is gone.
 */
export async function removeWorktreeTrust(worktreePath: string): Promise<void> {
  return withCodexConfigLock(() => removeWorktreeTrustSync(worktreePath));
}

function removeWorktreeTrustSync(worktreePath: string): void {
  const tomlPath = configTomlPath();
  const target = normalizeForCompare(path.resolve(worktreePath));

  let content: string;
  try {
    content = fs.readFileSync(tomlPath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  let removed = false;
  let index = 0;

  while (index < lines.length) {
    const header = parseHeaderLine(lines[index]);
    if (!header || normalizeForCompare(header.innerPath) !== target) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    // Collect the table body: everything up to the next table header.
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^\s*\[/.test(lines[cursor])) {
      body.push(lines[cursor]);
      cursor += 1;
    }

    const meaningful = body.filter((line) => line.trim().length > 0);
    const trustOnly = meaningful.length === 1 && /^\s*trust_level\s*=/.test(meaningful[0]);
    if (!trustOnly) {
      kept.push(lines[index], ...body);
    } else {
      removed = true;
      // The table's own body (including any blank lines trailing it) is
      // already dropped with it. `ensureWorktreeTrustSync` also writes a blank
      // separator line ahead of each table it appends, so drop that one line
      // too. Scoped to the single line before this header: a global blank-run
      // collapse would reflow spacing the user chose elsewhere in the file.
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    }
    index = cursor;
  }

  if (!removed) return;

  // Full-file rewrite of a config the user owns, so it goes through the same
  // backup + temp-file + rename helper `project-relocation.ts` uses on this
  // exact file. A plain writeFileSync interrupted by a crash or a force-kill
  // would truncate every project's trust, not just the worktree being dropped.
  atomicWriteFileWithBackup(tomlPath, kept.join('\n'), { logTag: '[CODEX_TRUST]' });
}

function ensureWorktreeTrustSync(workingDirectory: string): void {
  const tomlPath = configTomlPath();
  const resolvedPath = path.resolve(workingDirectory);
  const projectRoot = projectRootForWorktree(resolvedPath);

  let content: string;
  try {
    content = fs.readFileSync(tomlPath, 'utf-8');
  } catch {
    content = '';
  }
  const lines = content.split('\n');

  // Never overwrite a decision Codex or the user already recorded, in
  // either direction.
  if (readTrustLevel(lines, resolvedPath) !== null) return;

  // Respect a project-level deny: if the user marked the repo this worktree
  // came from as untrusted, do not quietly trust its worktrees.
  if (projectRoot && readTrustLevel(lines, projectRoot) === 'untrusted') return;

  // Single-quoted TOML literal: paths never contain a single quote on
  // Windows or macOS, and a literal string needs no backslash escaping.
  // A path that does contain one cannot be represented this way, and
  // reserializing the user's file to fix that is not worth the risk.
  if (resolvedPath.includes("'")) return;

  const table = `[projects.'${resolvedPath}']\ntrust_level = "trusted"\n`;
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';

  try {
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.appendFileSync(tomlPath, `${separator}\n${table}`, 'utf-8');
  } catch (error) {
    // Best-effort: a failure here only means the user sees Codex's trust
    // prompt, which is recoverable. It must never block the spawn.
    console.error('[codex] Failed to pre-approve directory trust', error);
  }
}
