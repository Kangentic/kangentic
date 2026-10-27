import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveForwardSlash, isSamePath } from '../../../../shared/paths';
import { createSerialLock, atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import { cliPathForTarget, type CliPlace } from '../../shared/cli-target';
import { qwenHomeDir } from './qwen-home';

// Module-level promise chain serializing all ~/.qwen/trustedFolders.json
// access. Prevents concurrent read-modify-write races when multiple tasks
// are spawned simultaneously.
// Exported so the relocation migration rewrites trustedFolders.json under the
// same lock as ensureWorktreeTrust, preventing a concurrent spawn from racing
// the key rewrite.
export const withQwenTrustLock = createSerialLock();

/** The only trust level Kangentic ever writes, and so the only one it removes. */
const KANGENTIC_TRUST_LEVEL = 'TRUST_FOLDER';

// `place`: a Qwen installed in a WSL distro reads the distro's own files.
const settingsPath = (place: CliPlace | null): string => path.join(qwenHomeDir(place), 'settings.json');
const trustedFoldersPath = (place: CliPlace | null): string => path.join(qwenHomeDir(place), 'trustedFolders.json');

/**
 * The key Qwen records a folder under: the absolute forward-slashed path, as
 * the distro sees it for a Qwen in a WSL distro (`/mnt/c/...`).
 */
function trustKeyOf(folderPath: string, place: CliPlace | null): string {
  return place ? cliPathForTarget(path.resolve(folderPath), place) : resolveForwardSlash(folderPath);
}

/**
 * Read `~/.qwen/trustedFolders.json` as a flat path-to-trust-level map.
 * Returns null when the file is missing, unparsable, or not a plain object.
 */
function readTrustedFolders(place: CliPlace | null): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath(place), 'utf-8')) as unknown;
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
 *
 * A Qwen in a WSL distro (`place`) reads the flag and the trusted folders from
 * the distro's Qwen directory, keyed by the path the distro sees.
 */
export async function ensureWorktreeTrust(worktreePath: string, place: CliPlace | null = null): Promise<void> {
  return withQwenTrustLock(() => ensureWorktreeTrustSync(worktreePath, place));
}

function ensureWorktreeTrustSync(worktreePath: string, place: CliPlace | null): void {
  if (!isFolderTrustEnabled(place)) return;

  const resolvedPath = trustKeyOf(worktreePath, place);
  const entries = readTrustedFolders(place) ?? {};

  const existing = entries[resolvedPath];
  if (existing === 'TRUST_FOLDER' || existing === 'TRUST_PARENT' || existing === 'DO_NOT_TRUST') {
    return;
  }

  entries[resolvedPath] = KANGENTIC_TRUST_LEVEL;

  // sync-write-ok: this must throw, not degrade - a swallowed failure here
  // would spawn Qwen into a folder-trust prompt neither the CLI nor the user
  // is ready for. ensureTrust's caller (the spawn preamble) already reports
  // and notifies (notifySpawnBlocked) on throw.
  fs.mkdirSync(qwenHomeDir(place), { recursive: true });
  // sync-write-ok: same reason as the mkdir above.
  fs.writeFileSync(trustedFoldersPath(place), JSON.stringify(entries, null, 2), 'utf-8');
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
 *
 * For a Qwen in a WSL distro (`place`), the entry is the one its trust step
 * wrote in the distro's file, matched by the exact key it wrote (a Linux path
 * is case-sensitive, so no Windows comparison applies).
 */
export async function removeWorktreeTrust(worktreePath: string, place: CliPlace | null = null): Promise<void> {
  return withQwenTrustLock(() => removeWorktreeTrustSync(worktreePath, place));
}

function removeWorktreeTrustSync(worktreePath: string, place: CliPlace | null): void {
  const entries = readTrustedFolders(place);
  if (!entries) return;
  const distroKey = place ? trustKeyOf(worktreePath, place).replace(/\/+$/, '') : null;

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
      && (distroKey !== null
        ? key.replace(/\/+$/, '') === distroKey
        : path.isAbsolute(key) && isSamePath(key, worktreePath)),
  );
  if (doomed.length === 0) return;

  for (const key of doomed) delete entries[key];

  // Never throws: returns false and logs when the backup or the write fails,
  // leaving the original file untouched.
  atomicWriteFileWithBackup(
    trustedFoldersPath(place),
    JSON.stringify(entries, null, 2),
    { logTag: '[QWEN_TRUST]' },
  );
}

function isFolderTrustEnabled(place: CliPlace | null): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(place), 'utf-8'));
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
