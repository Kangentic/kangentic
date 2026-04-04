import fs from 'node:fs';
import path from 'node:path';
import { EventType, HookEvent } from '../../../../shared/types';

/** Hook entry in Claude Code's settings.json. */
export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/**
 * Identify a hook entry injected by Kangentic.
 * Matches a known bridge script name AND `.kangentic` in the command string
 * to ensure we never touch user-defined hooks.
 */
function isKangenticHook(h: { command?: string }): boolean {
  if (typeof h.command !== 'string') return false;
  const cmd = h.command;
  return cmd.includes('.kangentic') && (
    cmd.includes('activity-bridge') || cmd.includes('event-bridge')
  );
}

/**
 * Filter out ALL Kangentic-injected entries from a hook event array.
 * Returns only entries that are NOT ours (any bridge type).
 */
function filterOurHooks(entries: ClaudeHookEntry[] | undefined): ClaudeHookEntry[] {
  return (entries || []).filter(
    (e) => !e?.hooks?.some?.(isKangenticHook),
  );
}

/**
 * Return the path to `.claude/settings.local.json` for the given directory.
 */
function settingsLocalPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.local.json');
}

/**
 * Build event-bridge hook entries to merge into Claude Code settings.
 * Takes the resolved bridge script path, events output path, and existing
 * hooks, and returns the merged hooks object with event-bridge entries appended.
 */
export function buildEventHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, ClaudeHookEntry[]>,
): Record<string, ClaudeHookEntry[]> {
  return {
    ...existingHooks,
    [HookEvent.PreToolUse]: [
      ...(existingHooks[HookEvent.PreToolUse] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.ToolStart}` }] },
    ],
    [HookEvent.PostToolUse]: [
      ...(existingHooks[HookEvent.PostToolUse] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.ToolEnd}` }] },
    ],
    [HookEvent.PostToolUseFailure]: [
      ...(existingHooks[HookEvent.PostToolUseFailure] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" tool_failure` }] },
    ],
    [HookEvent.UserPromptSubmit]: [
      ...(existingHooks[HookEvent.UserPromptSubmit] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.Prompt}` }] },
    ],
    [HookEvent.Stop]: [
      ...(existingHooks[HookEvent.Stop] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.Idle}` }] },
    ],
    [HookEvent.PermissionRequest]: [
      ...(existingHooks[HookEvent.PermissionRequest] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.Idle} permission` }] },
    ],
    [HookEvent.SessionStart]: [
      ...(existingHooks[HookEvent.SessionStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.SessionStart}` }] },
    ],
    [HookEvent.SessionEnd]: [
      ...(existingHooks[HookEvent.SessionEnd] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.SessionEnd}` }] },
    ],
    [HookEvent.SubagentStart]: [
      ...(existingHooks[HookEvent.SubagentStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.SubagentStart}` }] },
    ],
    [HookEvent.SubagentStop]: [
      ...(existingHooks[HookEvent.SubagentStop] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.SubagentStop}` }] },
    ],
    [HookEvent.Notification]: [
      ...(existingHooks[HookEvent.Notification] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.Notification}` }] },
    ],
    [HookEvent.PreCompact]: [
      ...(existingHooks[HookEvent.PreCompact] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.Compact}` }] },
    ],
    [HookEvent.TeammateIdle]: [
      ...(existingHooks[HookEvent.TeammateIdle] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.TeammateIdle}` }] },
    ],
    [HookEvent.TaskCompleted]: [
      ...(existingHooks[HookEvent.TaskCompleted] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.TaskCompleted}` }] },
    ],
    [HookEvent.ConfigChange]: [
      ...(existingHooks[HookEvent.ConfigChange] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.ConfigChange}` }] },
    ],
    [HookEvent.WorktreeCreate]: [
      ...(existingHooks[HookEvent.WorktreeCreate] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.WorktreeCreate}` }] },
    ],
    [HookEvent.WorktreeRemove]: [
      ...(existingHooks[HookEvent.WorktreeRemove] || []),
      { matcher: '', hooks: [{ type: 'command', command: `node "${eventBridge}" "${eventsPath}" ${EventType.WorktreeRemove}` }] },
    ],
  };
}

/**
 * Strip ALL Kangentic hook entries (event-bridge) from
 * `.claude/settings.local.json` at the given directory. Preserves all
 * other user hooks and settings.
 *
 * @deprecated Since the unified --settings approach, Kangentic no longer
 * writes hooks to `.claude/settings.local.json`. This function is kept
 * for backward compatibility - existing worktrees created before the
 * change may still have our hooks in their settings.local.json.
 * Called by `cleanupProject()` during project deletion.
 *
 * Safety guarantees:
 * - Only removes entries matching a known bridge AND `.kangentic`
 * - Backs up the original file before any modification
 * - Validates the result is valid JSON before writing
 * - Restores from backup on any error
 * - If the file becomes empty `{}`, deletes it (and the backup)
 */
export function stripKangenticHooks(dir: string): void {
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

    // Success - remove backup
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (err) {
    // Restore from backup if anything went wrong
    if (backedUp) {
      try { fs.copyFileSync(backupPath, p); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[stripKangenticHooks] Failed to clean hooks at ${p}:`, err);
  }
}
