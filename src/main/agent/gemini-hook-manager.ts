import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../shared/types';

/** Hook entry in Gemini CLI's settings.json. */
export interface GeminiHookEntry {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/**
 * Gemini CLI hook event names (settings.json keys).
 * Not all events are mapped to our event-bridge; BeforeModel, AfterModel,
 * and BeforeToolSelection are available but currently unused.
 */
export const GeminiHookEvent = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  BeforeAgent: 'BeforeAgent',
  AfterAgent: 'AfterAgent',
  BeforeModel: 'BeforeModel',
  AfterModel: 'AfterModel',
  BeforeToolSelection: 'BeforeToolSelection',
  BeforeTool: 'BeforeTool',
  AfterTool: 'AfterTool',
  PreCompress: 'PreCompress',
  Notification: 'Notification',
} as const;
export type GeminiHookEvent = (typeof GeminiHookEvent)[keyof typeof GeminiHookEvent];

/**
 * Identify a hook sub-entry injected by Kangentic.
 * Matches a known bridge script name AND `.kangentic` in the command string.
 */
function isKangenticHook(hook: { command?: string }): boolean {
  if (typeof hook.command !== 'string') return false;
  const command = hook.command;
  return command.includes('.kangentic') && (
    command.includes('activity-bridge') || command.includes('event-bridge')
  );
}

/**
 * Filter out Kangentic-injected entries from a Gemini hook event array.
 * Returns only entries whose inner hooks are NOT ours.
 */
function filterOurHooks(entries: GeminiHookEntry[] | undefined): GeminiHookEntry[] {
  return (entries || []).filter(
    (entry) => !entry?.hooks?.some?.(isKangenticHook),
  );
}

/**
 * Build a single Gemini hook entry for the event bridge.
 */
function bridgeEntry(eventBridge: string, eventsPath: string, eventType: string): GeminiHookEntry {
  return {
    matcher: '*',
    hooks: [{
      name: `kangentic-${eventType}`,
      type: 'command',
      command: `node "${eventBridge}" "${eventsPath}" ${eventType}`,
    }],
  };
}

/**
 * Build event-bridge hook entries to merge into Gemini CLI settings.
 * Maps available Gemini hook events to our event-bridge script.
 */
export function buildGeminiEventHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, GeminiHookEntry[]>,
): Record<string, GeminiHookEntry[]> {
  return {
    ...existingHooks,
    [GeminiHookEvent.BeforeTool]: [
      ...(existingHooks[GeminiHookEvent.BeforeTool] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.ToolStart),
    ],
    [GeminiHookEvent.AfterTool]: [
      ...(existingHooks[GeminiHookEvent.AfterTool] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.ToolEnd),
    ],
    [GeminiHookEvent.SessionStart]: [
      ...(existingHooks[GeminiHookEvent.SessionStart] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.SessionStart),
    ],
    [GeminiHookEvent.SessionEnd]: [
      ...(existingHooks[GeminiHookEvent.SessionEnd] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.SessionEnd),
    ],
    [GeminiHookEvent.AfterAgent]: [
      ...(existingHooks[GeminiHookEvent.AfterAgent] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.Idle),
    ],
    [GeminiHookEvent.BeforeAgent]: [
      ...(existingHooks[GeminiHookEvent.BeforeAgent] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.Prompt),
    ],
    [GeminiHookEvent.Notification]: [
      ...(existingHooks[GeminiHookEvent.Notification] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.Notification),
    ],
    [GeminiHookEvent.PreCompress]: [
      ...(existingHooks[GeminiHookEvent.PreCompress] || []),
      bridgeEntry(eventBridge, eventsPath, EventType.Compact),
    ],
  };
}

/**
 * Return the path to `.gemini/settings.json` for the given directory.
 */
function geminiSettingsPath(directory: string): string {
  return path.join(directory, '.gemini', 'settings.json');
}

/**
 * Strip ALL Kangentic hook entries from `.gemini/settings.json` at the
 * given directory. Preserves all other user hooks and settings.
 *
 * Safety guarantees (same as Claude hook stripping):
 * - Only removes entries matching a known bridge AND `.kangentic`
 * - Backs up the original file before any modification
 * - Validates the result is valid JSON before writing
 * - Restores from backup on any error
 * - If the file becomes empty `{}`, deletes it
 */
export function stripGeminiKangenticHooks(directory: string): void {
  const settingsPath = geminiSettingsPath(directory);
  if (!fs.existsSync(settingsPath)) return;

  const backupPath = settingsPath + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
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
    fs.copyFileSync(settingsPath, backupPath);
    backedUp = true;

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (Object.keys(settings).length === 0) {
      fs.unlinkSync(settingsPath);
      // Remove the .gemini/ directory if it's now empty
      try { fs.rmdirSync(path.dirname(settingsPath)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(settings, null, 2);
      JSON.parse(output); // verify round-trip integrity
      fs.writeFileSync(settingsPath, output);
    }

    // Success - remove backup
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (error) {
    // Restore from backup if anything went wrong
    if (backedUp) {
      try { fs.copyFileSync(backupPath, settingsPath); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[stripGeminiKangenticHooks] Failed to clean hooks at ${settingsPath}:`, error);
  }
}
