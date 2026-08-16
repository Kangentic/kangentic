import fs from 'node:fs';
import path from 'node:path';
import { createSerialLock } from '../../shared/relocation-utils';
import { antigravitySettingsPath } from './data-paths';

// Module-level promise chain serializing all settings.json access. Prevents
// concurrent read-modify-write races when multiple tasks spawn at once, and
// is shared with project-relocation.ts (same file).
export const withAntigravityTrustLock = createSerialLock();

/**
 * Antigravity stores workspace trust as a flat `trustedWorkspaces: string[]`
 * of absolute paths inside its own settings file
 * (`~/.gemini/antigravity-cli/settings.json`) - NOT Gemini's
 * trustedFolders.json, and with no per-entry trust level. Verified against
 * agy 1.1.13: a pre-seeded entry skips the TUI's workspace trust
 * confirmation ("Do you trust the contents of this project?"), which
 * otherwise blocks an automated spawn on a keystroke Kangentic never sends.
 *
 * Trust is EXACT-PATH, not inherited: agy prompted for a task worktree even
 * though the repository root above it was already trusted (observed live in
 * the preview E2E run), so unlike the Gemini trust manager there is no
 * ancestor-coverage skip - every spawn cwd gets its own entry, and
 * removeWorkspaceTrust / onWorktreeRemoved reap them per worktree.
 */
export async function ensureWorkspaceTrust(workspacePath: string): Promise<void> {
  return withAntigravityTrustLock(() => ensureWorkspaceTrustSync(workspacePath));
}

function ensureWorkspaceTrustSync(workspacePath: string): void {
  const settingsPath = antigravitySettingsPath();
  const settings = readSettings(settingsPath);
  const entries = readTrustedWorkspaces(settings);

  const target = normalizeForCompare(workspacePath);
  if (entries.some((entry) => normalizeForCompare(entry) === target)) return;

  // Store the path in the CLI's own style (native separators, as agy itself
  // writes them) so its normalize-and-compare lookup matches.
  settings.trustedWorkspaces = [...entries, workspacePath];

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    // Best-effort: a failure only means the user answers agy's trust prompt
    // themselves. Both spawn chokepoints await ensureTrust unguarded, so this
    // must never throw and abort the spawn.
    console.error('[antigravity] Failed to pre-approve workspace trust', error);
  }
}

/**
 * Drop the trust entry for a worktree Kangentic has just deleted, so
 * `trustedWorkspaces` does not grow one dead entry per task forever (the
 * Codex config.toml leak reached 473 entries before it was noticed). Only an
 * exact-path entry is removed - an ancestor entry also covering other
 * directories is left alone.
 */
export async function removeWorkspaceTrust(workspacePath: string): Promise<void> {
  return withAntigravityTrustLock(() => removeWorkspaceTrustSync(workspacePath));
}

function removeWorkspaceTrustSync(workspacePath: string): void {
  const settingsPath = antigravitySettingsPath();
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const entries = readTrustedWorkspaces(settings);
  const target = normalizeForCompare(workspacePath);
  const kept = entries.filter((entry) => normalizeForCompare(entry) !== target);
  if (kept.length === entries.length) return;

  settings.trustedWorkspaces = kept;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    // Best-effort: the worktree is already gone, a failure only leaves a
    // stale entry behind.
    console.error('[antigravity] Failed to drop workspace trust for a removed worktree', error);
  }
}

function readSettings(settingsPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable - start fresh; agy tolerates extra keys it did
    // not write, and preserves ours.
  }
  return {};
}

function readTrustedWorkspaces(settings: Record<string, unknown>): string[] {
  const value = settings.trustedWorkspaces;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Fold a stored entry or lookup path into a comparable form: separators and
 * trailing slashes normalized always, case folded ONLY on Windows (POSIX
 * paths are case-sensitive). Same policy as the Gemini trust manager.
 */
export function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
