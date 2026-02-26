import fs from 'node:fs';
import path from 'node:path';

/**
 * Identify a hook entry injected by Kangentic.
 * Matches BOTH `activity-bridge` AND `.kangentic` in the command string
 * to ensure we never touch user-defined hooks.
 */
function isKangenticHook(h: any): boolean {
  return (
    typeof h.command === 'string'
    && h.command.includes('activity-bridge')
    && h.command.includes('.kangentic')
  );
}

/**
 * Filter out Kangentic-injected entries from a hook event array.
 * Returns only entries that are NOT ours.
 */
function filterOurHooks(entries: any[] | undefined): any[] {
  return (entries || []).filter(
    (e: any) => !e?.hooks?.some?.(isKangenticHook),
  );
}

/**
 * Return the path to `.claude/settings.local.json` for the given directory.
 */
function settingsLocalPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.local.json');
}

/**
 * Read and parse `.claude/settings.local.json`. Returns `null` if the
 * file doesn't exist or can't be parsed.
 */
function readSettingsLocal(dir: string): Record<string, any> | null {
  const p = settingsLocalPath(dir);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Inject Kangentic activity hooks into `<cwd>/.claude/settings.local.json`.
 * Replaces any stale entries from previous sessions while preserving all
 * user-defined hooks and settings.
 */
export function injectActivityHooks(
  cwd: string,
  activityBridge: string,
  activityPath: string,
): void {
  const localSettingsDir = path.join(cwd, '.claude');
  fs.mkdirSync(localSettingsDir, { recursive: true });
  const p = settingsLocalPath(cwd);

  let settings: Record<string, any> = {};
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // Doesn't exist or malformed — start fresh
  }

  const existingHooks = settings.hooks || {};

  settings.hooks = {
    ...existingHooks,
    UserPromptSubmit: [
      ...filterOurHooks(existingHooks.UserPromptSubmit),
      { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" thinking` }] },
    ],
    Stop: [
      ...filterOurHooks(existingHooks.Stop),
      { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
    ],
  };

  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

/**
 * Strip Kangentic activity-bridge hook entries from `.claude/settings.local.json`
 * at the given directory. Preserves all other user hooks and settings.
 *
 * Safety guarantees:
 * - Only removes entries matching BOTH `activity-bridge` AND `.kangentic`
 * - Backs up the original file before any modification
 * - Validates the result is valid JSON before writing
 * - Restores from backup on any error
 * - If the file becomes empty `{}`, deletes it (and the backup)
 */
export function stripActivityHooks(dir: string): void {
  const p = settingsLocalPath(dir);
  if (!fs.existsSync(p)) return;

  const backupPath = p + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const settings = JSON.parse(raw);
    if (!settings.hooks || typeof settings.hooks !== 'object') return;

    let changed = false;
    for (const key of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[key])) continue;
      const before = settings.hooks[key].length;
      settings.hooks[key] = filterOurHooks(settings.hooks[key]);
      if (settings.hooks[key].length !== before) changed = true;
      if (settings.hooks[key].length === 0) delete settings.hooks[key];
    }

    if (!changed) return;

    // Back up original before writing any changes
    fs.copyFileSync(p, backupPath);
    backedUp = true;

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (Object.keys(settings).length === 0) {
      fs.unlinkSync(p);
      // Remove the .claude/ directory if it's now empty (we may have created it)
      try { fs.rmdirSync(path.dirname(p)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(settings, null, 2);
      JSON.parse(output); // verify round-trip integrity
      fs.writeFileSync(p, output);
    }

    // Success — remove backup
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (err) {
    // Restore from backup if anything went wrong
    if (backedUp) {
      try { fs.copyFileSync(backupPath, p); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[stripActivityHooks] Failed to clean hooks at ${p}:`, err);
  }
}
