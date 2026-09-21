import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveForwardSlash, isSamePath } from '../../../../shared/paths';
import { createSerialLock, atomicWriteFileWithBackup } from '../../shared/relocation-utils';

// Module-level promise chain serializing all ~/.qwen/trustedFolders.json
// access. Prevents concurrent read-modify-write races when multiple tasks
// are spawned simultaneously.
// Exported so the relocation migration rewrites trustedFolders.json under the
// same lock as ensureWorktreeTrust, preventing a concurrent spawn from racing
// the key rewrite.
export const withQwenTrustLock = createSerialLock();

/** The only trust level Kangentic ever writes, and so the only one it removes. */
const KANGENTIC_TRUST_LEVEL = 'TRUST_FOLDER';

const qwenDir = (): string => path.join(os.homedir(), '.qwen');
const settingsPath = (): string => path.join(qwenDir(), 'settings.json');
const trustedFoldersPath = (): string => path.join(qwenDir(), 'trustedFolders.json');

/**
 * Read `~/.qwen/trustedFolders.json` as a flat path-to-trust-level map.
 * Returns null when the file is missing, unparsable, or not a plain object.
 */
function readTrustedFolders(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Pre-populate Qwen Code's trusted-folders entry for a worktree path so
 * the trust prompt is skipped when spawning an agent.
 *
 * Qwen Code (inheriting from upstream Gemini CLI) stores per-folder trust
 * decisions in ~/.qwen/trustedFolders.json as a flat object mapping
 * absolute forward-slashed paths to one of three trust-level strings:
 * "TRUST_FOLDER", "TRUST_PARENT", or "DO_NOT_TRUST". We only ever write
 * "TRUST_FOLDER" ourselves; the other two are user-managed values we
 * detect and leave alone (no downgrade, no override of an explicit deny).
 *
 * The feature is gated on the security.folderTrust.enabled flag in
 * ~/.qwen/settings.json. When disabled (the upstream default), Qwen
 * implicitly trusts every folder and writing trustedFolders.json would
 * be needless clutter in the user's home directory - so we skip.
 */
export async function ensureWorktreeTrust(worktreePath: string): Promise<void> {
  return withQwenTrustLock(() => ensureWorktreeTrustSync(worktreePath));
}

function ensureWorktreeTrustSync(worktreePath: string): void {
  if (!isFolderTrustEnabled()) return;

  const resolvedPath = resolveForwardSlash(worktreePath);
  const entries = readTrustedFolders() ?? {};

  const existing = entries[resolvedPath];
  if (existing === 'TRUST_FOLDER' || existing === 'TRUST_PARENT' || existing === 'DO_NOT_TRUST') {
    return;
  }

  entries[resolvedPath] = KANGENTIC_TRUST_LEVEL;

  // sync-write-ok: this must throw, not degrade - a swallowed failure here
  // would spawn Qwen into a folder-trust prompt neither the CLI nor the user
  // is ready for. ensureTrust's caller (the spawn preamble) already reports
  // and notifies (notifySpawnBlocked) on throw.
  fs.mkdirSync(qwenDir(), { recursive: true });
  // sync-write-ok: same reason as the mkdir above.
  fs.writeFileSync(trustedFoldersPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Drop the trust entry for a worktree Kangentic has just deleted.
 *
 * Symmetric with the Gemini, Codex, Grok, and Antigravity removals, and needed
 * for the same reason. Qwen's `ensureWorktreeTrust` has no ancestor check, so
 * with folder trust enabled it records one key per task worktree; without this
 * the file grows by a dead entry per task forever. (Codex's equivalent leak
 * reached 473 entries on one machine before anyone noticed.)
 *
 * Two deliberate asymmetries with `ensureWorktreeTrust`:
 *
 * 1. No `security.folderTrust.enabled` gate. That flag lives in a separate,
 *    user-editable file the Qwen CLI also writes, so gating the reap on it
 *    would make cleanup of an entry depend on something unrelated to that
 *    entry: a user who spawns with the flag on and later turns it off would
 *    leak every key they already have, permanently. With the flag off there is
 *    normally no file at all, so running ungated costs one failed read.
 * 2. It never throws. `ensureWorktreeTrust` must throw (a failed pre-spawn
 *    write drops the agent into a blocking trust prompt), but by the time this
 *    runs the worktree is already gone and a failure only leaves a stale entry
 *    behind, so it must never fail the cleanup.
 *
 * Only an entry Kangentic could have written itself is removed. `TRUST_PARENT`
 * and `DO_NOT_TRUST` are user decisions and stay in place even though the
 * directory is gone, so a later worktree at the same path still honors them.
 */
export async function removeWorktreeTrust(worktreePath: string): Promise<void> {
  return withQwenTrustLock(() => removeWorktreeTrustSync(worktreePath));
}

function removeWorktreeTrustSync(worktreePath: string): void {
  const entries = readTrustedFolders();
  if (!entries) return;

  // Match on the resolved location rather than the raw string: this adapter's
  // own relocation pass rewrites arbitrary keys and Qwen's CLI writes its own,
  // so the file holds mixed separator styles. `isSamePath` resolves both sides
  // and folds case on Windows only. The `isAbsolute` guard stops a bare
  // relative key from a hand-edited file ("3") resolving against the process
  // cwd and matching by accident. It does not stop a driveless absolute key
  // ("/repo/x"), which Windows counts as absolute and resolves against the
  // cwd's drive, but such a key is inert to Qwen there anyway.
  const doomed = Object.keys(entries).filter(
    (key) => entries[key] === KANGENTIC_TRUST_LEVEL
      && path.isAbsolute(key)
      && isSamePath(key, worktreePath),
  );
  if (doomed.length === 0) return;

  for (const key of doomed) delete entries[key];

  // Never throws: returns false and logs when the backup or the write fails,
  // leaving the original file untouched.
  atomicWriteFileWithBackup(
    trustedFoldersPath(),
    JSON.stringify(entries, null, 2),
    { logTag: '[QWEN_TRUST]' },
  );
}

function isFolderTrustEnabled(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const security = (parsed as Record<string, unknown>).security;
    if (!security || typeof security !== 'object' || Array.isArray(security)) return false;
    const folderTrust = (security as Record<string, unknown>).folderTrust;
    if (!folderTrust || typeof folderTrust !== 'object' || Array.isArray(folderTrust)) return false;
    return (folderTrust as Record<string, unknown>).enabled === true;
  } catch {
    return false;
  }
}
