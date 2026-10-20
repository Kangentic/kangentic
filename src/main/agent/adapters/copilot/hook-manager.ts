import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toForwardSlash } from '../../../../shared/paths';
import { AgentTool, EventType } from '../../../../shared/types';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { buildBridgeCommand, isKangenticHookCommand, quoteBridgePath, type HookShell } from '../../shared/hook-utils';
import { extractTool, extractDetail, setToolWhen } from '../../shared/directive-builders';
import { backgroundLaunchDirective, backgroundStopDirectives, backgroundToolMatcher } from '../../shared/background-command-hooks';
import { BACKGROUND_SHELL_HINT_TEXT } from '../../shared/background-shell-hint-hook';
import type { BackgroundCommandSpec } from '../../../../shared/background-command-spec';

/**
 * A single hook entry under one event in a Copilot hook config.
 *
 * Copilot hooks are keyed by event name, each mapping to an ARRAY of
 * `{ command, timeout }` objects (same pattern as Gemini/Claude).
 * Empirically verified against Copilot CLI v1.0.24 - single objects
 * per event are rejected with "Expected array, received object".
 * `command` and `timeout` are Copilot's cross-platform aliases for
 * `bash`/`powershell` and `timeoutSec` (CLI 1.0.2), still accepted by 1.0.97.
 * `matcher` (a regex the tool name must match fully) is honored on a flat
 * entry: measured on 1.0.100, a postToolUse entry matched to the shell tools
 * never ran for `view` or `list_powershell`.
 */
export interface CopilotHookEntry {
  command: string;
  timeout?: number;
  matcher?: string;
}

/**
 * Copilot's background commands (task #859), from a headless 1.0.100 run in
 * BYOK mode against a local stand-in for the model API
 * (tests/fixtures/copilot-hooks/copilot-1.0.100-*). `powershell` (`bash` off
 * Windows) runs a command in the background two ways, and the result text is
 * the only place both show: `mode: "async"` answers
 * "<command started in background with shellId: X>", and a `sync` command
 * still running at `initial_wait` answers "<command with shellId: X is still
 * running after N seconds. ...>". `X` is the agent's own `shellId` or one
 * Copilot assigns ("0", "1"). `detach: true` answers "started in detached
 * background": an independent process the agent means to outlive the session,
 * so it never holds. `stop_powershell` / `stop_bash` take `toolArgs.shellId`.
 * Copilot adds a postToolUse reply's top-level `additionalContext` to the tool
 * result ("Additional guidance from postToolUse hooks"); `hookSpecificOutput`
 * is ignored. The command runs under `pwsh.exe` inside Copilot's tree.
 */
export const COPILOT_BACKGROUND_COMMAND_SPEC: BackgroundCommandSpec = {
  launch: {
    toolField: 'toolName',
    tools: ['powershell', 'bash'],
    when: [],
    unless: [{ path: ['toolArgs', 'detach'], equals: true }],
    idSources: [
      { path: ['toolResult', 'textResultForLlm'], pattern: '<command started in background with shellId: ([\\w-]+)>' },
      { path: ['toolResult', 'textResultForLlm'], pattern: '<command with shellId: ([\\w-]+) is still running' },
    ],
    commandPath: ['toolArgs', 'command'],
  },
  stop: {
    toolField: 'toolName',
    tools: ['stop_powershell', 'stop_bash'],
    when: [{ path: ['toolResult', 'resultType'], equals: 'success' }],
    unless: [],
    idSources: [{ path: ['toolArgs', 'shellId'] }],
  },
  hintReply: { additionalContext: BACKGROUND_SHELL_HINT_TEXT },
};

/**
 * The shell Copilot runs a hook's `command` in on Windows: the field is copied
 * to `powershell`, run as `pwsh.exe -nop -nol -c "<command>"` (measured on 1.0.98).
 */
export const COPILOT_HOOK_SHELL: HookShell = 'sh-or-powershell';

/**
 * The shell Copilot runs the status line in on Windows: Node's `shell: true`,
 * so `cmd.exe /d /s /c "<command>"` verbatim (read from 1.0.98's `cli-main.js`).
 */
const COPILOT_STATUS_LINE_SHELL: HookShell = 'cmd';

/** Copilot CLI's plan exit tool, the one that raises its plan approval card. */
const COPILOT_PLAN_EXIT_TOOL = 'exit_plan_mode';

/**
 * Reports Copilot's plan exit as Kangentic's (`AgentTool.ExitPlanMode`) only for
 * an approved plan, so the card moves to the column's After Plan Mode target.
 * Read from the 1.0.97 bundle (runtime.node, tools/exit_plan_mode.rs): the
 * result the model gets starts "Plan approved! Exited plan mode." when approved
 * and "Plan not approved." when not, at postToolUse `toolResult.textResultForLlm`.
 * Copilot names the tool `toolName`.
 */
const APPROVED_PLAN_EXIT = setToolWhen({
  whenTool: COPILOT_PLAN_EXIT_TOOL,
  toolField: 'toolName',
  nested: ['toolResult', 'textResultForLlm'],
  startsWith: 'Plan approved',
  to: AgentTool.ExitPlanMode,
});

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
 * A live 1.0.98 session (tests/fixtures/copilot-hooks/) sends the same, plus a
 * snake_case `stop_hook_active` on agentStop. Its preCompact carries
 * `transcriptPath`, `trigger` ("manual" for /compact) and `customInstructions`.
 *
 * Note: Copilot uses camelCase `toolName` (not snake_case `tool_name`). Only a
 * hook registered under a PascalCase event name gets snake_case fields
 * (CLI 1.0.21), and these are registered camelCase.
 */
export const COPILOT_HOOK_EVENTS: Array<{
  event: string;
  bridgeEventType: EventType;
  directives?: string[];
}> = [
  {
    event: 'preToolUse',
    bridgeEventType: EventType.ToolStart,
    directives: [extractTool('toolName')],
  },
  {
    event: 'postToolUse',
    bridgeEventType: EventType.ToolEnd,
    // A background launch and stop ride this entry: Copilot runs one event's
    // hooks one after another (about 0.7 s each on 1.0.100), so a second
    // entry would cost every tool call.
    directives: [
      extractTool('toolName'),
      APPROVED_PLAN_EXIT,
      backgroundLaunchDirective(COPILOT_BACKGROUND_COMMAND_SPEC),
      ...backgroundStopDirectives(COPILOT_BACKGROUND_COMMAND_SPEC),
    ],
  },
  {
    event: 'agentStop',
    bridgeEventType: EventType.Idle,
    directives: [extractDetail(['stopReason'])],
  },
  {
    event: 'preCompact',
    bridgeEventType: EventType.Compact,
  },
];

/**
 * Kangentic's hook file, inside the `hooks/` folder of the session's config
 * home. Copilot loads every `*.json` there as user-level hooks (CLI 0.0.422 on;
 * in 1.0.97 `createNativeHookSession` passes `<config home>/hooks` as
 * `userHooksDir`).
 */
const SESSION_HOOKS_DIR = 'hooks';
const SESSION_HOOKS_FILE = 'kangentic.json';

/**
 * Build Kangentic event-bridge hook entries for Copilot CLI.
 *
 * Returns a `hooks` object keyed by event name, where each value is an
 * array of `{ command, timeout }` entries. This is the format Copilot CLI
 * v1.0.24 expects (empirically verified - single objects are rejected).
 */
export function buildHooks(
  eventsOutputPath: string,
  options: CopilotSessionHookOptions = {},
): Record<string, CopilotHookEntry[]> {
  const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
  const eventsPath = toForwardSlash(eventsOutputPath);

  const hooks: Record<string, CopilotHookEntry[]> = {};
  for (const { event, bridgeEventType, directives } of COPILOT_HOOK_EVENTS) {
    hooks[event] = [{
      command: buildBridgeCommand(COPILOT_HOOK_SHELL, eventBridge, eventsPath, bridgeEventType, ...(directives || [])),
      timeout: 10,
    }];
  }
  // The hint runs for the shell tools alone, after the event bridge.
  if (options.backgroundShellHintCommand) {
    hooks.postToolUse.push({
      command: options.backgroundShellHintCommand,
      timeout: 10,
      matcher: backgroundToolMatcher(COPILOT_BACKGROUND_COMMAND_SPEC.launch.tools),
    });
  }
  return hooks;
}

/** What a Copilot session's hooks carry beyond the event bridge. */
export interface CopilotSessionHookOptions {
  /**
   * The background shell hint's command (`backgroundShellHintCommandFor`).
   * Passed only for a session offered `kangentic_mark_background_service`.
   */
  backgroundShellHintCommand?: string | null;
}

/**
 * Resolve the user's Copilot config directory (default: `~/.copilot`).
 */
function userCopilotConfigDir(): string {
  return path.join(os.homedir(), '.copilot');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a Copilot JSON file as an object. Returns an empty object if the file
 * does not exist, cannot be read, or is not a JSON object, and warns for the
 * last two.
 *
 * Whole-line `//` comments are skipped: Copilot 1.0.97 writes config.json with
 * a "// User settings belong in settings.json." header, and a plain
 * JSON.parse of that file would drop the signed-in account and trusted folders.
 */
function readJsonObject(filePath: string): Record<string, unknown> {
  let fileText: string;
  try {
    fileText = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    // No existing file: start with empty, and nothing of the user's is lost.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn(`[copilot] ${path.basename(filePath)} could not be read; the session starts without it`);
    return {};
  }
  try {
    // A byte order mark (U+FEFF) fails JSON.parse; editors on Windows can add one.
    const raw = fileText.charCodeAt(0) === 0xfeff ? fileText.slice(1) : fileText;
    const withoutCommentLines = raw
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const parsed: unknown = JSON.parse(withoutCommentLines);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // Invalid JSON - start with empty, below
  }
  // The session then runs without the user's settings in this file (the
  // signed-in account and trusted folders, for config.json).
  console.warn(`[copilot] ${path.basename(filePath)} is not a JSON object; the session starts without it`);
  return {};
}

/** Every command string in one hook entry, flat or Claude-style nested. */
function commandsOfHookEntry(entry: unknown): string[] {
  if (!isPlainObject(entry)) return [];
  const commands: string[] = [];
  for (const field of ['command', 'bash', 'powershell']) {
    const value = entry[field];
    if (typeof value === 'string') commands.push(value);
  }
  if (Array.isArray(entry.hooks)) {
    for (const inner of entry.hooks) commands.push(...commandsOfHookEntry(inner));
  }
  return commands;
}

/**
 * Drop Kangentic's event-bridge entries from a config's `hooks`, keeping the
 * user's own. Kangentic wrote its hooks into the session config.json up to
 * Copilot 1.0.92; leaving them there next to the hooks file would fire every
 * event twice on a version that reads both.
 */
function withoutKangenticHooks(config: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(config.hooks)) return config;
  const keptHooks: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) {
      keptHooks[event] = entries;
      continue;
    }
    const keptEntries = entries.filter((entry) => !commandsOfHookEntry(entry).some(isKangenticHookCommand));
    // A key the sweep empties is dropped; the user's own empty list is kept.
    if (keptEntries.length > 0 || entries.length === 0) keptHooks[event] = keptEntries;
  }
  const next: Record<string, unknown> = { ...config };
  delete next.hooks;
  if (Object.keys(keptHooks).length > 0) next.hooks = keptHooks;
  return next;
}

/** Kangentic's user-setting overrides: the status line bridge and no banner. */
function withSessionSettings(
  config: Record<string, unknown>,
  statusOutputPath: string | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, banner: 'never' };
  if (statusOutputPath) {
    const statusBridge = toForwardSlash(resolveBridgeScript('status-bridge'));
    const statusPath = toForwardSlash(statusOutputPath);
    next.statusLine = {
      type: 'command',
      command: `node ${quoteBridgePath(statusBridge, COPILOT_STATUS_LINE_SHELL)} ${quoteBridgePath(statusPath, COPILOT_STATUS_LINE_SHELL)}`,
    };
  }
  return next;
}

/**
 * Write the per-session Copilot config home. The command builder passes this
 * directory with `--config-dir`, which Copilot 1.0.97 turns into
 * `COPILOT_HOME`, so the user's own `~/.copilot` is never modified.
 *
 * - `hooks/kangentic.json`: the event-bridge hooks, `{ version: 1, hooks }`.
 *   The hooks folder is read by every Copilot version since 0.0.422, so one
 *   file covers them all.
 * - `settings.json`: a copy of the user's `~/.copilot/settings.json` plus the
 *   statusLine bridge and `banner: never`. Copilot 1.0.93 reads user settings
 *   only from settings.json.
 * - `config.json`: a copy of the user's `~/.copilot/config.json` (signed-in
 *   account, trusted folders) with the same two settings, for versions before
 *   1.0.93 that still read them there. Never hooks: 1.0.8 through 1.0.92 read
 *   config.json hooks AND the hooks folder.
 * - `mcp-config.json`: a copy of the user's, since `--config-dir` moves where
 *   Copilot looks for it too.
 */
export function writeSessionConfig(
  configDir: string,
  eventsOutputPath: string,
  statusOutputPath?: string,
  hookOptions: CopilotSessionHookOptions = {},
): void {
  const hooksDir = path.join(configDir, SESSION_HOOKS_DIR);
  // sync-write-ok: this must throw, not degrade - configDir is passed straight
  // to --config-dir, so a swallowed failure would spawn Copilot pointed at a
  // directory that does not exist, with no hooks. The spawn preamble already
  // reports and notifies (notifySpawnBlocked) on throw.
  fs.mkdirSync(hooksDir, { recursive: true });

  // sync-write-ok: same reason as the mkdir above - carries the event-bridge
  // hooks this whole function exists to inject.
  fs.writeFileSync(
    path.join(hooksDir, SESSION_HOOKS_FILE),
    JSON.stringify({ version: 1, hooks: buildHooks(eventsOutputPath, hookOptions) }, null, 2),
  );

  const userDir = userCopilotConfigDir();
  const settings = withSessionSettings(
    withoutKangenticHooks(readJsonObject(path.join(userDir, 'settings.json'))),
    statusOutputPath,
  );
  // sync-write-ok: same reason as the mkdir above - carries the statusLine
  // wiring and the user's own settings for the session.
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));

  const config = withSessionSettings(
    withoutKangenticHooks(readJsonObject(path.join(userDir, 'config.json'))),
    statusOutputPath,
  );
  // sync-write-ok: same reason as the mkdir above - carries the signed-in
  // account the session runs as.
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  // Copy user's mcp-config.json if it exists (--config-dir changes where
  // Copilot looks for ALL config files, not just config.json)
  const userMcpConfig = path.join(userDir, 'mcp-config.json');
  const sessionMcpConfig = path.join(configDir, 'mcp-config.json');
  try {
    if (fs.existsSync(userMcpConfig)) {
      fs.copyFileSync(userMcpConfig, sessionMcpConfig);
    }
  } catch {
    // Best effort - MCP config is optional
  }
}

/** Delete one file, ignoring a file that is already gone. */
function removeFileQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort cleanup
  }
}

/**
 * Remove Kangentic's files from a per-session Copilot config directory.
 *
 * Called on session exit/suspend. Removes file by file, never recursively:
 * Copilot keeps the session's `session-state/` in this same config home, and
 * the next `--session-id <uuid>` resume needs it. Covers the hooks file and the
 * config.json that carried the hooks up to Copilot 1.0.92.
 */
export function removeSessionConfig(sessionConfigDir: string): void {
  const hooksDir = path.join(sessionConfigDir, SESSION_HOOKS_DIR);
  removeFileQuietly(path.join(hooksDir, SESSION_HOOKS_FILE));
  try { fs.rmdirSync(hooksDir); } catch { /* not empty or already gone */ }
  for (const fileName of ['settings.json', 'config.json', 'mcp-config.json']) {
    removeFileQuietly(path.join(sessionConfigDir, fileName));
  }
  // Remove the directory if now empty
  try { fs.rmdirSync(sessionConfigDir); } catch { /* not empty or already gone */ }
}
