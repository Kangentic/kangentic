import fs from 'node:fs';
import path from 'node:path';

/**
 * Identify a hook entry injected by Kangentic.
 * Matches a known bridge script name AND `.kangentic` in the command string
 * to ensure we never touch user-defined hooks.
 */
function isKangenticHook(h: any): boolean {
  if (typeof h.command !== 'string') return false;
  const cmd = h.command;
  return cmd.includes('.kangentic') && (
    cmd.includes('activity-bridge') || cmd.includes('event-bridge')
  );
}

/** Check if a hook entry is specifically an activity-bridge entry. */
function isActivityBridgeHook(h: any): boolean {
  return typeof h.command === 'string'
    && h.command.includes('activity-bridge')
    && h.command.includes('.kangentic');
}

/** Check if a hook entry is specifically an event-bridge entry. */
function isEventBridgeHook(h: any): boolean {
  return typeof h.command === 'string'
    && h.command.includes('event-bridge')
    && h.command.includes('.kangentic');
}

/**
 * Filter out ALL Kangentic-injected entries from a hook event array.
 * Returns only entries that are NOT ours (any bridge type).
 */
function filterOurHooks(entries: any[] | undefined): any[] {
  return (entries || []).filter(
    (e: any) => !e?.hooks?.some?.(isKangenticHook),
  );
}

/**
 * Filter out only activity-bridge entries from a hook event array.
 * Preserves event-bridge entries and user-defined hooks.
 */
function filterActivityHooks(entries: any[] | undefined): any[] {
  return (entries || []).filter(
    (e: any) => !e?.hooks?.some?.(isActivityBridgeHook),
  );
}

/**
 * Filter out only event-bridge entries from a hook event array.
 * Preserves activity-bridge entries and user-defined hooks.
 */
function filterEventHooks(entries: any[] | undefined): any[] {
  return (entries || []).filter(
    (e: any) => !e?.hooks?.some?.(isEventBridgeHook),
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
 * Replaces any stale activity-bridge entries from previous sessions while
 * preserving event-bridge hooks and all user-defined hooks/settings.
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
      ...filterActivityHooks(existingHooks.UserPromptSubmit),
      { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" thinking` }] },
    ],
    Stop: [
      ...filterActivityHooks(existingHooks.Stop),
      { matcher: '', hooks: [{ type: 'command', command: `node "${activityBridge}" "${activityPath}" idle` }] },
    ],
  };

  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

/**
 * Inject Kangentic event-bridge hooks into `<cwd>/.claude/settings.local.json`.
 * Adds PreToolUse, PostToolUse, UserPromptSubmit, and Stop hooks for the
 * event log (activity log stream). Replaces any stale event-bridge entries
 * from previous sessions while preserving activity-bridge hooks and all
 * user-defined hooks/settings.
 */
export function injectEventHooks(
  cwd: string,
  eventBridge: string,
  eventsPath: string,
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
    PreToolUse: [
      ...filterEventHooks(existingHooks.PreToolUse),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" tool_start` }] },
    ],
    PostToolUse: [
      ...filterEventHooks(existingHooks.PostToolUse),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" tool_end` }] },
    ],
    UserPromptSubmit: [
      ...filterEventHooks(existingHooks.UserPromptSubmit),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" prompt` }] },
    ],
    Stop: [
      ...filterEventHooks(existingHooks.Stop),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" idle` }] },
    ],
  };

  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

/**
 * Strip ALL Kangentic hook entries (activity-bridge + event-bridge) from
 * `.claude/settings.local.json` at the given directory. Preserves all
 * other user hooks and settings.
 *
 * Safety guarantees:
 * - Only removes entries matching a known bridge AND `.kangentic`
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
