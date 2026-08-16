import fs from 'node:fs';
import { atomicWriteFileWithBackup } from '../../shared/relocation-utils';
import {
  antigravityLastConversationsPath,
  antigravitySettingsPath,
} from './data-paths';
import { normalizeForCompare, withAntigravityTrustLock } from './trust-manager';

/**
 * Migrate Antigravity's per-workspace state after a project (or worktree
 * cwd) moves from `oldPath` to `newPath`.
 *
 * Antigravity keys two things by absolute workspace path:
 * - `settings.json` `trustedWorkspaces` entries (trust; without migration
 *   the new location re-prompts - though `ensureTrust` on the next spawn
 *   self-heals that, migrating avoids both the stale old entry and the
 *   duplicate new one), and
 * - `cache/last_conversations.json` keys (what `agy -c` resumes; Kangentic
 *   itself resumes by explicit `--conversation <id>`, which works
 *   cross-directory, so this is continuity for the user's own `-c`).
 *
 * Conversation data itself (`conversations/<uuid>.db`, `brain/<uuid>/`) is
 * keyed by conversation id, not path, and needs no migration.
 *
 * Serialized on the same lock as the trust manager (both touch
 * settings.json). Every step is independently guarded and best-effort.
 */
export async function migrateAntigravityProjectData(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return withAntigravityTrustLock(() => {
    migrateTrustedWorkspaces(oldPath, newPath);
    migrateLastConversations(oldPath, newPath);
  });
}

function migrateTrustedWorkspaces(oldPath: string, newPath: string): void {
  const settingsPath = antigravitySettingsPath();
  const target = normalizeForCompare(oldPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const settings = parsed as Record<string, unknown>;
    const entries = Array.isArray(settings.trustedWorkspaces)
      ? settings.trustedWorkspaces.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (!entries.some((entry) => normalizeForCompare(entry) === target)) return;

    const migrated = entries
      .filter((entry) => normalizeForCompare(entry) !== target)
      .filter((entry) => normalizeForCompare(entry) !== normalizeForCompare(newPath));
    migrated.push(newPath);
    settings.trustedWorkspaces = migrated;
    atomicWriteFileWithBackup(settingsPath, JSON.stringify(settings, null, 2), {
      logTag: '[ANTIGRAVITY_RELOCATE]',
    });
  } catch (error) {
    // A missing settings file is normal (no Antigravity session ever spawned
    // on this machine); only log real read/parse failures.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[antigravity] Failed to migrate trustedWorkspaces', error);
    }
  }
}

function migrateLastConversations(oldPath: string, newPath: string): void {
  const cachePath = antigravityLastConversationsPath();
  const target = normalizeForCompare(oldPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const map = parsed as Record<string, unknown>;

    let changed = false;
    for (const key of Object.keys(map)) {
      if (normalizeForCompare(key) !== target) continue;
      const conversationId = map[key];
      delete map[key];
      // Written in native-separator form, matching how agy itself records
      // workspace keys (verified: Windows keys use backslashes).
      map[newPath] = conversationId;
      changed = true;
    }
    if (!changed) return;
    atomicWriteFileWithBackup(cachePath, JSON.stringify(map, null, 2), {
      logTag: '[ANTIGRAVITY_RELOCATE]',
    });
  } catch (error) {
    // Missing cache file is normal (no conversation yet) - only log real
    // write failures via the shared catch; a parse miss is silent.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[antigravity] Failed to migrate last_conversations', error);
    }
  }
}
