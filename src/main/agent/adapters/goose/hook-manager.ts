import fs from 'node:fs';
import path from 'node:path';
import { EventType, type SessionEvent } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';
import { buildBridgeCommand, type HookShell } from '../../shared/hook-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { extractDetail, extractTool, extractToolId } from '../../shared/directive-builders';
import type { CliPlace } from '../../shared/cli-target';
import { copyWslHookScriptInto, prepareWslHookTransport, wslHookEventCommand } from '../../shared/wsl-hook-transport';

/**
 * Goose's hooks, wired to Kangentic's event bridge.
 *
 * Built from Goose's published hooks guide
 * (https://goose-docs.ai/docs/guides/context-engineering/hooks) and its source
 * at 1.57.0 (`crates/goose/src/hooks/mod.rs`), not against a running Goose:
 *
 * - A hook is a PLUGIN: a folder holding `hooks/hooks.json` (and an optional
 *   `plugin.json`), found at start in `<project>/.agents/plugins/<name>/` or
 *   `~/.agents/plugins/<name>/`. No trust prompt gates a project plugin.
 * - `hooks.json` is `{ "hooks": { <Event>: [ { "matcher"?, "hooks": [ {
 *   "type": "command", "command", "timeout"? } ] } ] } }`. An omitted matcher
 *   matches every call.
 * - Goose writes a JSON payload to the command's stdin: `event` and
 *   `session_id` always, and where they apply `tool_name`, `tool_input`,
 *   `tool_call_id`, `message` and `last_assistant_message`.
 * - Goose runs the command with `sh -c` and has no Windows branch, so on
 *   Windows a hook runs only where `sh` is on PATH. Goose's install guide
 *   recommends Git Bash, which puts it there; for a PowerShell or cmd terminal
 *   the adapter appends Git for Windows' `bin` folder (`gooseWindowsHookPath`).
 *   With no Git for Windows at all the hooks stay silent and the adapter's
 *   `hooksAndPty` activity falls back to the PTY silence timer.
 * - The bridge exits 0 with empty stdout, which Goose's guide reads as a
 *   PreToolUse "allow". That never approves a call: Goose decides approval
 *   before it runs the PreToolUse chain, which only sees calls already cleared
 *   to execute and can only deny them
 *   (`crates/goose/src/agents/state_machine/ops_toolcalling.rs`,
 *   `pending_tool_requests` then `dispatch_tool_call`). So `tool_start` also
 *   lands after any approval prompt, which the OSC 7501 parser reports.
 * - SubagentStart and SubagentStop are documented as not emitted, and there is
 *   no compaction or notification event, so none is wired.
 *
 * The plugin folder is `kangentic-goose`, not `kangentic`: Antigravity owns
 * `<cwd>/.agents/plugins/kangentic/` for its MCP plugin and deletes it whole on
 * cleanup, and the two agents can share a worktree.
 *
 * EVENTS ROUTING. The file is per folder and serves every Goose session in it,
 * so a command names its events file indirectly, `env:KANGENTIC_GOOSE_EVENTS_PATH`,
 * which the event bridge reads from the hook's own environment (Goose's hook
 * inherits Goose's, which inherits the PTY's). The variable is Goose's own
 * rather than the `KANGENTIC_EVENTS_PATH` every spawn carries: another agent
 * that loads `.agents/plugins/*` in the same folder, or a Goose the user runs
 * by hand, has no such variable, and the bridge's empty path is a silent no-op.
 */

/** The variable the hook commands read their events path from. Set by the adapter's `buildEnv`. */
export const GOOSE_EVENTS_PATH_ENV = 'KANGENTIC_GOOSE_EVENTS_PATH';

/** The plugin folder Kangentic owns under `<cwd>/.agents/plugins/`. */
export const GOOSE_PLUGIN_NAME = 'kangentic-goose';

/** The workspace copy of the WSL hook transport's script a Goose in a WSL distro runs its hooks with. */
export const GOOSE_WSL_HOOK_COPY_NAME = 'goose-wsl-hook.sh';

/**
 * Goose runs every hook with `sh -c "<command>"` (hooks/mod.rs: `Command::new("sh")`),
 * on Windows too, so the command is one `-c` argument to sh.
 */
const GOOSE_HOOK_SHELL: HookShell = 'sh-or-powershell';

/** Seconds Goose waits on one hook. The documented default is 30; the bridge returns in well under one. */
const GOOSE_HOOK_TIMEOUT_SECONDS = 10;

/**
 * Fields of a built-in tool's `tool_input` that name what it acts on, per the
 * hooks guide's table: `shell` {command}, `write`/`edit`/`tree` {path},
 * `read_image` {source}. First non-null wins.
 */
const GOOSE_TOOL_DETAIL_FIELDS = ['command', 'path', 'source'];

/** One hook action in Goose's `hooks.json`. */
export interface GooseHookAction {
  type: 'command';
  command: string;
  timeout: number;
}

/** One rule: an optional matcher and its actions. */
export interface GooseHookRule {
  matcher?: string;
  hooks: GooseHookAction[];
}

/** The whole `hooks/hooks.json` Kangentic writes. */
export interface GooseHooksFile {
  hooks: Record<string, GooseHookRule[]>;
}

/** Builds one hook's command for an event type and its directives. */
export type GooseEventCommand = (eventType: string, ...directives: string[]) => string;

/**
 * Where Git for Windows puts `sh.exe`, by its installer's defaults: a machine
 * install under Program Files (64- or 32-bit) and a per-user install under
 * `%LOCALAPPDATA%\Programs`. Its `bin` folder holds only `sh`, `bash` and `git`.
 */
function gitForWindowsBinCandidates(environment: NodeJS.ProcessEnv): string[] {
  const roots = [environment.ProgramFiles, environment.ProgramW6432, environment['ProgramFiles(x86)']]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.win32.join(root, 'Git', 'bin'));
  if (environment.LOCALAPPDATA) roots.push(path.win32.join(environment.LOCALAPPDATA, 'Programs', 'Git', 'bin'));
  return roots;
}

/**
 * On Windows, the PATH a Goose session needs so its hooks run: Goose starts
 * every hook with `sh -c` and has no Windows branch, so with no `sh` on PATH
 * (a PowerShell or cmd terminal) every hook fails to start and no turn end
 * arrives. When `sh.exe` is already on PATH, or Git for Windows is not
 * installed, this answers null and nothing changes. Otherwise it answers the
 * PATH with Git's `bin` folder APPENDED, under the variable's own spelling
 * (`Path` on Windows), so every command that already resolved resolves the
 * same way and only the missing `sh` is added.
 */
export function gooseWindowsHookPath(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync,
): Record<string, string> | null {
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'Path';
  const currentPath = environment[pathKey] ?? '';
  const folders = currentPath.split(';').map((folder) => folder.trim()).filter(Boolean);
  if (folders.some((folder) => exists(path.win32.join(folder, 'sh.exe')))) return null;
  const gitBin = gitForWindowsBinCandidates(environment).find((folder) => exists(path.win32.join(folder, 'sh.exe')));
  if (!gitBin) return null;
  return { [pathKey]: currentPath ? `${currentPath.replace(/;+$/, '')};${gitBin}` : gitBin };
}

function rule(command: string): GooseHookRule {
  return { hooks: [{ type: 'command', command, timeout: GOOSE_HOOK_TIMEOUT_SECONDS }] };
}

/**
 * The event mapping. Exported for tests; `writeGooseHooks` is the production
 * entry point. `eventCommand` builds the commands for a Goose in a WSL distro,
 * which may have no node, with the same event types and directives.
 *
 * - SessionStart -> `session_start` (the bridge keeps its payload as hook context).
 * - UserPromptSubmit -> `prompt`.
 * - PreToolUse -> `tool_start`, with the tool, its call id and what it acts on.
 * - PostToolUse and PostToolUseFailure -> `tool_end`, paired by the call id.
 * - Stop -> `idle`: "goose finishes a turn or receives a stop event" (hooks
 *   guide), the turn end the adapter's `reportsTurnEnd` declares.
 * - SessionEnd -> `session_end`.
 *
 * The payload's fields are snake_case like Claude's (`tool_name`), so the
 * bridge's tool-scoped guards would read them, though none is needed here.
 */
export function buildGooseHooks(eventBridge: string, eventCommand?: GooseEventCommand): GooseHooksFile {
  const bridge: GooseEventCommand = eventCommand
    ?? ((eventType, ...directives) => buildBridgeCommand(
      GOOSE_HOOK_SHELL,
      eventBridge,
      `env:${GOOSE_EVENTS_PATH_ENV}`,
      eventType,
      ...directives,
    ));
  const toolIdentity = [extractTool('tool_name'), extractToolId(['tool_call_id'])];
  return {
    hooks: {
      SessionStart: [rule(bridge(EventType.SessionStart))],
      UserPromptSubmit: [rule(bridge(EventType.Prompt))],
      PreToolUse: [rule(bridge(EventType.ToolStart,
        ...toolIdentity,
        extractDetail(GOOSE_TOOL_DETAIL_FIELDS, { nested: 'tool_input' })))],
      PostToolUse: [rule(bridge(EventType.ToolEnd, ...toolIdentity))],
      PostToolUseFailure: [rule(bridge(EventType.ToolEnd, ...toolIdentity))],
      Stop: [rule(bridge(EventType.Idle))],
      SessionEnd: [rule(bridge(EventType.SessionEnd))],
    },
  };
}

/**
 * One events.jsonl line the hooks wrote, as the event bridge wrote it, or null
 * for a blank line, malformed JSON, or anything but an object with a string
 * `type` (an array has none). The adapter's `statusFile.parseEvent`.
 */
export function parseGooseHookEvent(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') return null;
    return parsed as SessionEvent;
  } catch {
    return null;
  }
}

/** `<directory>/.agents/plugins/kangentic-goose`. */
export function goosePluginDirectory(directory: string): string {
  return path.join(directory, '.agents', 'plugins', GOOSE_PLUGIN_NAME);
}

/**
 * Write (or refresh) Kangentic's plugin in `<directory>/.agents/plugins/`. The
 * content is static per install (only the bridge's absolute path varies), so
 * rewriting it on every spawn also heals a stale path after an app update.
 * Best-effort: a failed write costs only hook activity, which `hooksAndPty`
 * degrades around, so it is logged and the spawn goes on.
 *
 * A Goose installed in a WSL distro (`wsl`) runs its hooks through the folder's
 * copy of the WSL hook transport's script, which finds the session's own folder
 * through the variable the spawn sets, as Grok's hooks do.
 */
export function writeGooseHooks(directory: string, wsl: { place: CliPlace; sessionDirectory: string } | null = null): void {
  const pluginDirectory = goosePluginDirectory(directory);
  try {
    const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
    let eventCommand: GooseEventCommand | undefined;
    if (wsl) {
      const sessionHooks = prepareWslHookTransport(wsl.sessionDirectory);
      const folderHooks = { ...sessionHooks, script: copyWslHookScriptInto(directory, GOOSE_WSL_HOOK_COPY_NAME) };
      eventCommand = (eventType, ...directives) => wslHookEventCommand(folderHooks, wsl.place, eventType, ...directives);
    }
    const hooksDirectory = path.join(pluginDirectory, 'hooks');
    fs.mkdirSync(hooksDirectory, { recursive: true });
    // The manifest fields the plugins guide shows. Goose infers a hook-only
    // plugin's name from its folder, so this only labels it.
    fs.writeFileSync(path.join(pluginDirectory, 'plugin.json'), JSON.stringify({
      name: GOOSE_PLUGIN_NAME,
      version: '1.0.0',
      description: 'Kangentic activity hooks',
    }, null, 2));
    fs.writeFileSync(path.join(hooksDirectory, 'hooks.json'), JSON.stringify(buildGooseHooks(eventBridge, eventCommand), null, 2));
  } catch (error) {
    console.error(`[goose] Failed to write hook plugin: ${pluginDirectory}`, error);
  }
}

/**
 * Delete Kangentic's plugin folder and fold up `.agents/plugins` and `.agents`
 * when nothing else is left in them. Never touches another plugin, Antigravity's
 * `kangentic` included.
 */
export function removeGooseHooks(directory: string): void {
  const pluginDirectory = goosePluginDirectory(directory);
  try {
    fs.rmSync(pluginDirectory, { recursive: true, force: true });
    const pluginsDirectory = path.dirname(pluginDirectory);
    try { fs.rmdirSync(pluginsDirectory); } catch { /* not empty or already gone */ }
    try { fs.rmdirSync(path.dirname(pluginsDirectory)); } catch { /* not empty or already gone */ }
  } catch (error) {
    console.error(`[goose] Failed to remove hook plugin: ${pluginDirectory}`, error);
  }
}
