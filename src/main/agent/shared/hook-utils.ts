import fs from 'node:fs';
import path from 'node:path';

/**
 * Identify a hook command string as Kangentic-injected.
 *
 * Matches the current bridges (`event-bridge`, `plan-approval-bridge`) and the
 * legacy `activity-bridge` (removed 2026-03-01) AND requires `.kangentic` in the
 * path, so user-defined hooks that happen to mention our script names without
 * pointing at our worktree are not swept up.
 */
export function isKangenticHookCommand(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  const hasBridge = command.includes('activity-bridge')
    || command.includes('event-bridge')
    || command.includes('plan-approval-bridge');
  const hasKangenticPath = command.includes('.kangentic') || command.includes('/kangentic/');
  return hasBridge && hasKangenticPath;
}

/**
 * Filter out Kangentic-injected entries from a hook array, keeping only
 * user-defined hooks. Works with any hook entry shape - the caller
 * provides a `getCommands` function that extracts command strings from
 * each entry.
 *
 * Used by each adapter's `buildHooks` (strip stale before inject) and
 * `removeHooks` (clean up on exit).
 */
export function filterKangenticHooks<T>(
  entries: T[] | undefined,
  getCommands: (entry: T) => string[],
): T[] {
  return (entries || []).filter((entry) => {
    return !getCommands(entry).some((command) => isKangenticHookCommand(command));
  });
}

/**
 * Double-quote a path for a bridge command an agent CLI runs (a hook or a
 * status line), so the bridge receives the path as written.
 *
 * On macOS and Linux the CLIs hand the command to sh or bash (`sh -c` for
 * Claude Code per its hooks reference, `bash -c` in the Gemini and Qwen hook
 * runners, `bash` for Copilot's cross-platform `command` field; Grok's hooks
 * and the Claude and Copilot status lines were not checked), where `\`, `"`, `$` and a backtick stay special inside double
 * quotes. Each is backslash-escaped, so a project under `~/work/$client` no
 * longer expands to `~/work/`. Without it the plan approval bridge found no
 * decision file and Automatic did nothing, and every activity event was
 * written to the wrong path.
 *
 * A Windows path is left as it is. The hook shell there differs per CLI and per
 * environment (Git Bash or PowerShell for Claude Code, PowerShell for Gemini,
 * Git Bash, cmd or PowerShell for Qwen), each escapes `$` differently, and `\`
 * is a path separator, so no one escape is right for all of them.
 */
export function quoteBridgePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${filePath}"`;
  return `"${filePath.replace(/[\\"$`]/g, '\\$&')}"`;
}

/**
 * Build a `node <bridge> <events> <eventType> [directives...]` command string.
 * Used by all hook-managers when wiring bridge entries.
 */
export function buildBridgeCommand(
  eventBridge: string,
  eventsPath: string,
  eventType: string,
  ...directives: string[]
): string {
  const parts = [`node ${quoteBridgePath(eventBridge)} ${quoteBridgePath(eventsPath)} ${eventType}`];
  parts.push(...directives);
  return parts.join(' ');
}

/**
 * Transactionally update a JSON settings file with backup-on-write and
 * restore-on-error. Guarantees the file is never left in a corrupt state.
 *
 * Behavior:
 * - If the file doesn't exist, this is a no-op.
 * - Reads + parses the file, calls `transform(parsed)` to produce the new value.
 * - If `transform` returns `null`, signals "no change" and the file is not touched.
 * - Otherwise writes a .kangentic-bak copy, validates the new content round-trips
 *   through JSON, then atomically replaces the file. On any error restores
 *   from backup. The backup is removed on success.
 * - If `transform` returns `{}` (empty object), the file is deleted entirely,
 *   and the containing directory is removed if it's now empty.
 */
export function safelyUpdateSettingsFile(
  filePath: string,
  transform: (parsed: unknown) => unknown | null,
  label: string,
): void {
  if (!fs.existsSync(filePath)) return;

  const backupPath = filePath + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const next = transform(parsed);
    if (next === null) return; // no change requested

    fs.copyFileSync(filePath, backupPath);
    backedUp = true;

    const isEmpty = typeof next === 'object' && next !== null
      && !Array.isArray(next) && Object.keys(next as object).length === 0;

    if (isEmpty || (Array.isArray(next) && next.length === 0)) {
      fs.unlinkSync(filePath);
      try { fs.rmdirSync(path.dirname(filePath)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(next, null, 2);
      JSON.parse(output); // round-trip validation
      fs.writeFileSync(filePath, output);
    }

    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (error) {
    if (backedUp) {
      try { fs.copyFileSync(backupPath, filePath); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[${label}] Failed to update ${filePath}:`, error);
  }
}
