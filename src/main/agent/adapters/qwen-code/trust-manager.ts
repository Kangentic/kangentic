import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveForwardSlash } from '../../../../shared/paths';

// Module-level promise chain serializing all ~/.qwen/trustedFolders.json
// access. Prevents concurrent read-modify-write races when multiple tasks
// are spawned simultaneously.
let qwenTrustLock: Promise<unknown> = Promise.resolve();

function withQwenTrustLock<T>(operation: () => T): Promise<T> {
  const previous = qwenTrustLock;
  const result = previous.then(operation, () => operation());
  qwenTrustLock = result.catch(() => {});
  return result;
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
  const qwenDir = path.join(os.homedir(), '.qwen');
  const settingsPath = path.join(qwenDir, 'settings.json');
  const trustedFoldersPath = path.join(qwenDir, 'trustedFolders.json');

  if (!isFolderTrustEnabled(settingsPath)) return;

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

  const existing = entries[resolvedPath];
  if (existing === 'TRUST_FOLDER' || existing === 'TRUST_PARENT' || existing === 'DO_NOT_TRUST') {
    return;
  }

  entries[resolvedPath] = 'TRUST_FOLDER';

  fs.mkdirSync(qwenDir, { recursive: true });
  fs.writeFileSync(trustedFoldersPath, JSON.stringify(entries, null, 2), 'utf-8');
}

function isFolderTrustEnabled(settingsPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
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
