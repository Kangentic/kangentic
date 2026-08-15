import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveForwardSlash } from '../../../../shared/paths';
import { createSerialLock } from '../../shared/relocation-utils';

// Module-level promise chain serializing all ~/.gemini/trustedFolders.json
// access. Prevents concurrent read-modify-write races when multiple tasks
// are spawned simultaneously.
export const withGeminiTrustLock = createSerialLock();

/** Trust levels Gemini persists. We only ever write TRUST_FOLDER ourselves. */
const USER_MANAGED_LEVELS = new Set(['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST']);

/**
 * Pre-populate Gemini CLI's trusted-folders entry for a worktree path.
 *
 * This is load-bearing for MCP, not just a prompt-skip convenience. Measured
 * against gemini 0.54.4: in an untrusted folder `gemini mcp list` reports
 * "MCP servers are configured but disabled because this folder is untrusted"
 * and suppresses user-level servers too, so the `mcpServers.kangentic` entry
 * the command builder writes would be silently inert.
 *
 * Gemini stores decisions in ~/.gemini/trustedFolders.json as a flat object
 * mapping absolute paths to a trust-level string. We only ever add
 * TRUST_FOLDER; TRUST_PARENT and DO_NOT_TRUST are user-managed values we
 * detect and leave alone, so an explicit deny is never overridden.
 *
 * An explicit deny is never overridden, at the path itself or above it: a
 * `DO_NOT_TRUST` recorded on the repo suppresses approval for every worktree
 * Kangentic creates beneath it. Codex's sibling makes the same check against
 * its project root.
 *
 * Two deliberate differences from the sibling Qwen implementation:
 *
 * 1. No `security.folderTrust.enabled` gate. Qwen skips when that flag is
 *    unset, on the assumption that folder trust is off by default. Gemini
 *    0.54.4 enforces trust with the flag unset (verified), so gating here
 *    would make the MCP wiring a no-op for most users.
 * 2. An ancestor check. Trust is inherited by descendants, and Kangentic
 *    creates a worktree per task, so writing one key per worktree would bloat
 *    the user's home config without changing behavior. When any ancestor is
 *    already trusted we write nothing.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  return withGeminiTrustLock(() => ensureWorktreeTrustSync(worktreePath));
}

function ensureWorktreeTrustSync(worktreePath: string): void {
  const geminiDir = path.join(os.homedir(), '.gemini');
  const trustedFoldersPath = path.join(geminiDir, 'trustedFolders.json');

  const resolvedPath = resolveForwardSlash(worktreePath);

  let entries: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath, 'utf-8'));
    entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    entries = {};
  }

  if (USER_MANAGED_LEVELS.has(String(entries[resolvedPath]))) return;
  // An explicit deny on an ancestor covers everything beneath it. Without
  // this, trusting a per-task worktree would silently overrule a DO_NOT_TRUST
  // the user recorded on the repo it was created from. Codex's sibling makes
  // the same check against its project root.
  if (hasDenyingAncestor(entries, resolvedPath)) return;
  if (hasTrustedAncestor(entries, resolvedPath)) return;

  entries[resolvedPath] = 'TRUST_FOLDER';

  try {
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(trustedFoldersPath, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (error) {
    // Best-effort: a failure here only means the user sees Gemini's trust
    // prompt (and its MCP servers stay disabled until they answer). Both
    // spawn chokepoints await ensureTrust unguarded, so it must never throw
    // and abort the spawn.
    console.error('[gemini] Failed to pre-approve folder trust', error);
  }
}

/**
 * Drop the trust entry for a worktree Kangentic has just deleted.
 *
 * Symmetric with Codex's `removeWorktreeTrust`, and needed for the same
 * reason: when no ancestor is already trusted, `ensureWorktreeTrust` writes
 * one key per task worktree, so without this the file grows by one dead entry
 * per task forever. (Codex's equivalent leak reached 473 entries on one
 * machine before it was noticed.)
 *
 * Only an entry we could have written ourselves is removed. `TRUST_PARENT`
 * and `DO_NOT_TRUST` are user decisions and are left in place even though the
 * directory is gone, so a later worktree at the same path still honors them.
 */
export async function removeWorktreeTrust(worktreePath: string): Promise<void> {
  return withGeminiTrustLock(() => removeWorktreeTrustSync(worktreePath));
}

function removeWorktreeTrustSync(worktreePath: string): void {
  const geminiDir = path.join(os.homedir(), '.gemini');
  const trustedFoldersPath = path.join(geminiDir, 'trustedFolders.json');
  const resolvedPath = resolveForwardSlash(worktreePath);

  let entries: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    entries = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  // Keys are stored in mixed styles, so match on the normalized form rather
  // than the raw string, the same way the ancestor checks below do.
  const target = normalizeForCompare(resolvedPath);
  const doomed = Object.keys(entries).filter(
    (key) => entries[key] === 'TRUST_FOLDER' && normalizeForCompare(key) === target,
  );
  if (doomed.length === 0) return;

  for (const key of doomed) delete entries[key];

  try {
    fs.writeFileSync(trustedFoldersPath, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (error) {
    // Best-effort: the worktree is already gone, so a failure only leaves a
    // stale entry behind. It must never fail the cleanup.
    console.error('[gemini] Failed to drop folder trust for a removed worktree', error);
  }
}

/**
 * Fold a stored key or a lookup path into a comparable form.
 *
 * Keys are stored in mixed styles (native backslashes from one code path,
 * forward slashes from another), so separators and any trailing slash are
 * normalized on both sides. Case is folded ONLY on Windows: POSIX paths are
 * case-sensitive, so `/home/dev/Repo` and `/home/dev/repo` are genuinely
 * different directories there and must not collapse into one. Same gate as
 * `codex/config-toml.ts`'s `normalizeForCompare` and this adapter's own
 * `project-relocation.ts` `mirrorPathStyle`.
 */
function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when `ancestorKey` is `resolvedPath` itself or a directory above it. */
function covers(ancestorKey: string, resolvedPath: string): boolean {
  const target = normalizeForCompare(resolvedPath);
  const ancestor = normalizeForCompare(ancestorKey);
  // The trailing-separator boundary keeps `/repo-backup` from matching `/repo`.
  return target === ancestor || target.startsWith(`${ancestor}/`);
}

/**
 * True when an existing TRUST_FOLDER entry already covers `resolvedPath`
 * through inheritance, so writing a per-worktree key would add nothing.
 */
function hasTrustedAncestor(
  entries: Record<string, unknown>,
  resolvedPath: string,
): boolean {
  for (const [key, level] of Object.entries(entries)) {
    if (level !== 'TRUST_FOLDER') continue;
    if (covers(key, resolvedPath)) return true;
  }
  return false;
}

/**
 * True when the user explicitly denied trust at or above `resolvedPath`.
 * Kangentic never overrules that, even for a worktree it created itself.
 */
function hasDenyingAncestor(
  entries: Record<string, unknown>,
  resolvedPath: string,
): boolean {
  for (const [key, level] of Object.entries(entries)) {
    if (level !== 'DO_NOT_TRUST') continue;
    if (covers(key, resolvedPath)) return true;
  }
  return false;
}
