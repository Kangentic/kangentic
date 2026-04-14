import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toForwardSlash } from '../../../../shared/paths';
import { EventType } from '../../../../shared/types';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { isKangenticHookCommand, buildBridgeCommand } from '../../shared/hook-utils';

/**
 * A single hook entry in Copilot's config.json `hooks` object.
 *
 * Copilot hooks are keyed by event name, each mapping to an ARRAY of
 * `{ command, timeout }` objects (same pattern as Gemini/Claude).
 * Empirically verified against Copilot CLI v1.0.24 - single objects
 * per event are rejected with "Expected array, received object".
 */
export interface CopilotHookEntry {
  command: string;
  timeout?: number;
}

/**
 * Copilot hook events mapped to event-bridge event types with extraction
 * directives. Directives tell event-bridge how to extract fields from
 * Copilot's hook stdin JSON format.
 */
/**
 * Copilot hook events mapped to event-bridge event types with extraction
 * directives. Directives tell event-bridge how to extract fields from
 * Copilot's hook stdin JSON.
 *
 * Empirically verified stdin schemas (Copilot CLI v1.0.24):
 *
 * preToolUse:  { sessionId, timestamp, cwd, toolName, toolArgs }
 * postToolUse: { sessionId, timestamp, cwd, toolName, toolArgs, toolResult }
 * agentStop:   { timestamp, cwd, sessionId, transcriptPath, stopReason }
 *
 * Note: Copilot uses camelCase `toolName` (not snake_case `tool_name`).
 */
export const COPILOT_HOOK_EVENTS: Array<{
  event: string;
  bridgeEventType: EventType;
  directives?: string[];
}> = [
  {
    event: 'preToolUse',
    bridgeEventType: EventType.ToolStart,
    directives: ['tool:toolName'],
  },
  {
    event: 'postToolUse',
    bridgeEventType: EventType.ToolEnd,
    directives: ['tool:toolName'],
  },
  {
    event: 'agentStop',
    bridgeEventType: EventType.Idle,
    directives: ['detail:stopReason'],
  },
  {
    event: 'preCompact',
    bridgeEventType: EventType.Compact,
  },
];

/**
 * Build Kangentic event-bridge hook entries for Copilot CLI config.
 *
 * Returns a `hooks` object keyed by event name, where each value is an
 * array of `{ command, timeout }` entries. This is the format Copilot CLI
 * v1.0.24 expects (empirically verified - single objects are rejected).
 */
export function buildHooks(eventsOutputPath: string): Record<string, CopilotHookEntry[]> {
  const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
  const eventsPath = toForwardSlash(eventsOutputPath);

  const hooks: Record<string, CopilotHookEntry[]> = {};
  for (const { event, bridgeEventType, directives } of COPILOT_HOOK_EVENTS) {
    hooks[event] = [{
      command: buildBridgeCommand(eventBridge, eventsPath, bridgeEventType, ...(directives || [])),
      timeout: 10,
    }];
  }
  return hooks;
}

/**
 * Resolve the user's Copilot config directory (default: `~/.copilot`).
 */
function userCopilotConfigDir(): string {
  return path.join(os.homedir(), '.copilot');
}

/**
 * Read the user's existing `~/.copilot/config.json` and return parsed content.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
function readUserConfig(): Record<string, unknown> {
  const configPath = path.join(userCopilotConfigDir(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // No existing config or invalid JSON - start with empty
  }
  return {};
}

/**
 * Write a Copilot config.json that merges the user's existing
 * `~/.copilot/config.json` with our hooks, statusLine, and banner
 * overrides into the given per-session config directory. This directory
 * is passed to Copilot via `--config-dir` so the user's original config
 * file is not modified, but all their preferences (model, theme,
 * trusted_folders, experimental, etc.) are preserved.
 */
export function writeSessionConfig(
  configDir: string,
  eventsOutputPath: string,
  statusOutputPath?: string,
): void {
  fs.mkdirSync(configDir, { recursive: true });

  // Start with the user's existing config to preserve preferences
  const config = readUserConfig();

  // Override hooks with our event-bridge entries
  config.hooks = buildHooks(eventsOutputPath);

  // Inject statusLine bridge if status output path is provided
  if (statusOutputPath) {
    const statusBridge = toForwardSlash(resolveBridgeScript('status-bridge'));
    const statusPath = toForwardSlash(statusOutputPath);
    config.statusLine = {
      type: 'command',
      command: `node "${statusBridge}" "${statusPath}"`,
    };
  }

  // Disable the animated banner in managed sessions
  config.banner = 'never';

  // Copy user's mcp-config.json if it exists (--config-dir changes where
  // Copilot looks for ALL config files, not just config.json)
  const userMcpConfig = path.join(userCopilotConfigDir(), 'mcp-config.json');
  const sessionMcpConfig = path.join(configDir, 'mcp-config.json');
  try {
    if (fs.existsSync(userMcpConfig)) {
      fs.copyFileSync(userMcpConfig, sessionMcpConfig);
    }
  } catch {
    // Best effort - MCP config is optional
  }

  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * Remove Kangentic-injected hooks from a per-session Copilot config directory.
 *
 * Called on session exit/suspend. The `sessionConfigDir` is the per-session
 * copilot-config directory created by writeSessionConfig. Since each session
 * has its own config dir, cleanup is straightforward: delete the session config.
 */
export function removeSessionConfig(sessionConfigDir: string): void {
  try {
    const configFile = path.join(sessionConfigDir, 'config.json');
    if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile);
    }
    // Also clean up the copied mcp-config.json
    const mcpConfigFile = path.join(sessionConfigDir, 'mcp-config.json');
    if (fs.existsSync(mcpConfigFile)) {
      try { fs.unlinkSync(mcpConfigFile); } catch { /* best effort */ }
    }
    // Remove the directory if now empty
    try { fs.rmdirSync(sessionConfigDir); } catch { /* not empty or already gone */ }
  } catch {
    // Best effort cleanup
  }
}
