import fs from 'node:fs';
import path from 'node:path';
import { toForwardSlash } from '../../../../shared/paths';
import { EventType } from '../../../../shared/types';
import { resolveBridgeScript } from '../../shared/bridge-utils';

/** A single entry in Codex's .codex/hooks.json array. */
export interface CodexHookEntry {
  event: string;
  command: string;
  timeout_secs?: number;
}

/**
 * Codex hook event names mapped to the event-bridge event types
 * that our agent-agnostic event-bridge.js understands.
 */
export const CODEX_HOOK_EVENTS: Array<{ event: string; bridgeEventType: EventType }> = [
  { event: 'SessionStart', bridgeEventType: EventType.SessionStart },
  { event: 'UserPromptSubmit', bridgeEventType: EventType.Prompt },
  { event: 'PreToolUse', bridgeEventType: EventType.ToolStart },
  { event: 'PostToolUse', bridgeEventType: EventType.ToolEnd },
  { event: 'Stop', bridgeEventType: EventType.Idle },
];

/** True if this hook entry was injected by Kangentic. */
function isKangenticCodexHook(entry: CodexHookEntry): boolean {
  const command = entry.command || '';
  return command.includes('.kangentic') && (
    command.includes('activity-bridge') || command.includes('event-bridge')
  );
}

/** Path to .codex/hooks.json for a given project directory. */
function codexHooksPath(directory: string): string {
  return path.join(directory, '.codex', 'hooks.json');
}

/**
 * Write Kangentic event-bridge hooks into .codex/hooks.json at the project
 * root. Merges with any existing user-defined hooks (our entries are filtered
 * out first to avoid duplicates).
 */
export function writeCodexHooks(projectRoot: string, eventsOutputPath: string): void {
  const hooksFile = codexHooksPath(projectRoot);
  const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
  const eventsPath = toForwardSlash(eventsOutputPath);

  // Read existing hooks and filter out stale Kangentic entries
  let existingHooks: CodexHookEntry[] = [];
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      existingHooks = (parsed as CodexHookEntry[]).filter(
        entry => !isKangenticCodexHook(entry),
      );
    }
  } catch {
    // No existing hooks file or invalid JSON - start fresh
  }

  // Build our hook entries
  const kangenticHooks: CodexHookEntry[] = CODEX_HOOK_EVENTS.map(({ event, bridgeEventType }) => ({
    event,
    command: `node "${eventBridge}" "${eventsPath}" ${bridgeEventType}`,
    timeout_secs: 10,
  }));

  const merged = [...existingHooks, ...kangenticHooks];

  // Ensure .codex/ directory exists
  const codexDir = path.dirname(hooksFile);
  fs.mkdirSync(codexDir, { recursive: true });

  fs.writeFileSync(hooksFile, JSON.stringify(merged, null, 2));
}

/**
 * Strip ALL Kangentic hook entries from .codex/hooks.json at the given
 * directory. Preserves all other user hooks.
 *
 * Safety: backs up before write, validates JSON round-trip, restores on error.
 */
export function stripCodexHooks(directory: string): void {
  const hooksFile = codexHooksPath(directory);
  if (!fs.existsSync(hooksFile)) return;

  const backupPath = hooksFile + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    const hooks = parsed as CodexHookEntry[];
    const filtered = hooks.filter(entry => !isKangenticCodexHook(entry));

    if (filtered.length === hooks.length) return; // nothing changed

    // Back up original before writing
    fs.copyFileSync(hooksFile, backupPath);
    backedUp = true;

    if (filtered.length === 0) {
      // No hooks left - remove the file
      fs.unlinkSync(hooksFile);
      try { fs.rmdirSync(path.dirname(hooksFile)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(filtered, null, 2);
      JSON.parse(output); // verify round-trip integrity
      fs.writeFileSync(hooksFile, output);
    }

    // Success - remove backup
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (error) {
    if (backedUp) {
      try { fs.copyFileSync(backupPath, hooksFile); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[stripCodexHooks] Failed to clean hooks at ${hooksFile}:`, error);
  }
}
