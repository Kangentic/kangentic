import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { resolvePluginScript } from '../../shared/bridge-utils';

/**
 * OpenCode plugin events mapped to event-bridge event types. Documented
 * here for symmetry with `CODEX_HOOK_EVENTS` and to give tests a
 * canonical mapping to assert against. The actual event-handler logic
 * lives inside the plugin file (`plugin/kangentic-activity.mjs`),
 * because OpenCode plugins run inline in the OpenCode process and write
 * JSONL directly rather than shelling out to event-bridge.
 *
 * OpenCode plugin event names (verified against
 * https://opencode.ai/docs/plugins/, April 2026):
 *  - `event` with `event.type === 'session.created'` -> session_start
 *  - `event` with `event.type === 'session.idle'`    -> idle
 *  - `event` with `event.type === 'session.error'`   -> idle (detail: 'error')
 *  - `tool.execute.before`                           -> tool_start
 *  - `tool.execute.after`                            -> tool_end
 */
export const OPENCODE_HOOK_EVENTS: Array<{
  hook: string;
  bridgeEventType: EventType;
  notes?: string;
}> = [
  { hook: 'event:session.created', bridgeEventType: EventType.SessionStart, notes: 'captures sessionID into hookContext' },
  { hook: 'event:session.idle', bridgeEventType: EventType.Idle },
  { hook: 'event:session.error', bridgeEventType: EventType.Idle, notes: "detail: 'error'" },
  { hook: 'tool.execute.before', bridgeEventType: EventType.ToolStart },
  { hook: 'tool.execute.after', bridgeEventType: EventType.ToolEnd },
];

const PLUGIN_FILENAME = 'kangentic-activity.mjs';
const PLUGIN_SENTINEL = '// kangentic-activity';

/** Directory under a project root where OpenCode auto-loads plugins. */
function pluginsDir(projectRoot: string): string {
  return path.join(projectRoot, '.opencode', 'plugins');
}

function pluginPath(projectRoot: string): string {
  return path.join(pluginsDir(projectRoot), PLUGIN_FILENAME);
}

/**
 * Copy the Kangentic OpenCode plugin into `<projectRoot>/.opencode/plugins/`.
 * OpenCode auto-discovers plugins in this directory at TUI startup, so no
 * mutation of `opencode.json` is required.
 *
 * The plugin reads its events output path from the `KANGENTIC_EVENTS_PATH`
 * env var (exported by the PTY spawn flow); the path is therefore not a
 * parameter of this function. Idempotent: skips the copy when the
 * destination file is byte-identical to the packaged source. Concurrent
 * OpenCode sessions in the same project share one plugin file (refcount
 * in `OpenCodeAdapter.hookHolders`).
 */
export function buildHooks(projectRoot: string): void {
  const sourcePath = resolvePluginScript('opencode', 'kangentic-activity');
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[opencode-hooks] Plugin source not found at ${sourcePath}; skipping install.`);
    return;
  }

  const destinationDir = pluginsDir(projectRoot);
  const destinationFile = pluginPath(projectRoot);

  try {
    fs.mkdirSync(destinationDir, { recursive: true });
  } catch (error) {
    console.error(`[opencode-hooks] Failed to create ${destinationDir}:`, error);
    return;
  }

  let needsCopy = true;
  if (fs.existsSync(destinationFile)) {
    try {
      const sourceContents = fs.readFileSync(sourcePath);
      const destinationContents = fs.readFileSync(destinationFile);
      if (sourceContents.equals(destinationContents)) {
        needsCopy = false;
      }
    } catch {
      // Fall through to overwrite.
    }
  }

  if (needsCopy) {
    try {
      fs.copyFileSync(sourcePath, destinationFile);
    } catch (error) {
      console.error(`[opencode-hooks] Failed to copy plugin to ${destinationFile}:`, error);
    }
  }
}

/**
 * Remove the Kangentic-authored plugin file from a project's
 * `.opencode/plugins/` directory. Verifies the sentinel comment on
 * line 1 before deletion so user-authored plugins are never touched.
 *
 * Best-effort cleanup of empty `.opencode/plugins/` and `.opencode/`
 * directories: leaves them in place if other files exist.
 */
export function removeHooks(directory: string): void {
  const file = pluginPath(directory);
  if (!fs.existsSync(file)) return;

  try {
    const contents = fs.readFileSync(file, 'utf-8');
    const firstLine = contents.split('\n', 1)[0] ?? '';
    if (!firstLine.includes(PLUGIN_SENTINEL)) {
      // Not our file. Leave it alone.
      return;
    }
    fs.unlinkSync(file);
  } catch (error) {
    console.error(`[opencode-hooks] Failed to remove ${file}:`, error);
    return;
  }

  // Best-effort directory cleanup. Ignore errors: a non-empty directory
  // means the user has other plugins or assets we should not touch.
  try { fs.rmdirSync(pluginsDir(directory)); } catch { /* not empty or already gone */ }
  try { fs.rmdirSync(path.join(directory, '.opencode')); } catch { /* not empty or already gone */ }
}
