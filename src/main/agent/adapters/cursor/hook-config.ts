/**
 * Kangentic's activity hooks in a Cursor session's working folder.
 *
 * Built from Cursor's documentation and not yet run against a real Cursor:
 * - Hooks reference, https://cursor.com/docs/hooks (fetched 2026-11-03): the
 *   project file is `<project>/.cursor/hooks.json`, shaped
 *   `{ "version": 1, "hooks": { "<event>": [{ "command", "timeout" }] } }`,
 *   each command gets the hook's JSON on stdin, `timeout` is in seconds, and
 *   on Windows a command runs through PowerShell.
 * - CLI changelog, https://cursor.com/docs/cli/changelog: the CLI runs hooks
 *   since January 2026 (session start and end, stop, pre-compaction,
 *   subagent lifecycle), "Hooks fire reliably" in April 2026, and post-tool
 *   hooks fire for subagents since v2026.10.17.
 *
 * The CLI takes no flag naming a hooks file, so the file is the project's and
 * every Cursor session in the folder reads it, as with `.cursor/mcp.json`
 * (`project-mcp-config.ts`). The entries are static. Each command names its
 * events file as `env:KANGENTIC_EVENTS_PATH_INTERACTIVE`, which the event
 * bridge reads from the hook's own environment. The adapter sets that
 * variable only for a session-screen start (`buildEnv`). A print run, whose
 * stream-json already reports its tool calls, and a user's own Cursor run in
 * the folder leave it unset, and the bridge writes nothing. For a Cursor in a
 * WSL distro the commands run the WSL hook transport inside a shell test of
 * the same variable instead. The spawn sets `KANGENTIC_EVENTS_PATH` for every
 * session after the adapter's variables, which is why that one cannot be the
 * gate. The name keeps `env:KANGENTIC_EVENTS_PATH` as its prefix, so the
 * shared `isKangenticHookCommand` still recognizes an entry an older install
 * wrote from another bridge path.
 *
 * One file serves one place. The last Kangentic start in a folder decides
 * whether it holds the node commands or the WSL shell commands, and the CLI
 * path is the project's, so Kangentic's own sessions in a folder share one.
 * A user who also runs a Cursor of the other place by hand in that folder
 * while a session holds the file gets hook errors there. Windows PowerShell
 * cannot run the WSL form, and a distro with no node cannot run the other.
 *
 * No hook answers for the user. Cursor reads a `permission` from
 * `preToolUse` and `subagentStart`, and an answer there would decide what
 * confirm-changes leaves to the person, so those hooks print nothing. The one
 * reply is `beforeSubmitPrompt`'s `{ "continue": true }`, so a prompt is never
 * held on a field Kangentic left out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../../../shared/types';
import type { SessionEvent } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';
import { buildBridgeCommand, filterKangenticHooks, type HookShell } from '../../shared/hook-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import {
  extractDetail,
  extractSubagentId,
  extractTool,
  extractToolId,
  replyJson,
  setTypeWhen,
} from '../../shared/directive-builders';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import type { CliPlace } from '../../shared/cli-target';
import { copyWslHookScriptInto, prepareWslHookTransport, wslHookEventCommand } from '../../shared/wsl-hook-transport';
import { isJsonObject } from './project-mcp-config';

/** The WSL hook transport's paths for one session, with the folder's script copy. */
type WslFolderHooks = ReturnType<typeof prepareWslHookTransport>;

/**
 * The variable a session-screen start sets. On this machine it holds the
 * session's events file, and its `env:` form is what every Kangentic command
 * in `.cursor/hooks.json` names. For a Cursor in a WSL distro it is a flag
 * (`1`): the hook transport finds the session's folder through
 * `KANGENTIC_WSL_HOOK_DIR`, which the spawn sets for every distro session, so
 * each command runs the transport only while this variable is set.
 */
export const CURSOR_HOOK_EVENTS_ENV = 'KANGENTIC_EVENTS_PATH_INTERACTIVE';

/** The folder copy of the WSL hook transport's script a Cursor in a WSL distro runs its hooks with. */
export const CURSOR_WSL_HOOK_COPY_NAME = 'cursor-wsl-hook.sh';

/** Where a Cursor in a WSL distro runs, and the session folder its hook transport publishes into. */
export interface CursorWslHooks {
  place: CliPlace;
  sessionDirectory: string;
}

/**
 * Builds one hook's command from its event type and directives, and the JSON
 * the hook must print, if any.
 */
type CursorHookCommandBuilder = (eventType: string, directives: string[], reply: Record<string, unknown> | null) => string;

/** The command on this machine: the node bridge, reading its events file from the gating variable. */
function nodeBridgeCommandBuilder(eventBridge: string): CursorHookCommandBuilder {
  return (eventType, directives, reply) => buildBridgeCommand(
    CURSOR_HOOK_SHELL,
    eventBridge,
    `env:${CURSOR_HOOK_EVENTS_ENV}`,
    eventType,
    ...directives,
    ...(reply ? [replyJson(reply)] : []),
  );
}

/**
 * The command for a Cursor in a WSL distro: the folder's copy of the WSL hook
 * transport's script (`sh '<copy>' event <type> <directives>`), which a distro
 * with no node can run, inside a POSIX `if` on the gating variable so a print
 * run and the user's own Cursor publish nothing. The `if` ends with status 0
 * either way, so Cursor never reports the hook as failed. A reply is printed
 * after it, as the node bridge prints its reply whatever the events path.
 * Cursor's hooks reference says a hook command may be a shell string.
 */
function wslTransportCommandBuilder(folderHooks: WslFolderHooks, place: CliPlace): CursorHookCommandBuilder {
  return (eventType, directives, reply) => {
    const publish = wslHookEventCommand(folderHooks, place, eventType, ...directives);
    const gated = `if [ -n "$${CURSOR_HOOK_EVENTS_ENV}" ]; then ${publish}; fi`;
    if (!reply) return gated;
    // A single quote in the reply closes the quoted word; `'\''` puts it back.
    const quotedReply = JSON.stringify(reply).replace(/'/g, `'\\''`);
    return `${gated}; printf '%s' '${quotedReply}'`;
  };
}

/** How the hook commands are handed to a shell on Windows: PowerShell, per Cursor's hooks docs. */
export const CURSOR_HOOK_SHELL: HookShell = 'sh-or-powershell';

/** Seconds each hook may run. The bridge appends one line and exits. */
const CURSOR_HOOK_TIMEOUT_SECONDS = 10;

/** Cursor's hook event names Kangentic registers on (https://cursor.com/docs/hooks). */
export const CURSOR_HOOK_EVENTS = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  beforeSubmitPrompt: 'beforeSubmitPrompt',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  postToolUseFailure: 'postToolUseFailure',
  subagentStart: 'subagentStart',
  subagentStop: 'subagentStop',
  preCompact: 'preCompact',
  stop: 'stop',
} as const;

/** One entry in a `.cursor/hooks.json` event list. Other keys a user wrote are kept. */
export interface CursorHookEntry {
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

type JsonObject = Record<string, unknown>;

/**
 * Kangentic's command for each Cursor event. `eventBridge` is the bridge
 * script's path; `wsl`, for a Cursor in a WSL distro, is the transport's
 * folder copy and the distro, used in its place. Exported so a test can run
 * the real bridge on each command.
 */
export function buildCursorHookCommands(
  eventBridge: string,
  wsl: { folderHooks: WslFolderHooks; place: CliPlace } | null = null,
): Record<string, string> {
  const buildWithReply = wsl ? wslTransportCommandBuilder(wsl.folderHooks, wsl.place) : nodeBridgeCommandBuilder(eventBridge);
  const silentCommand = (eventType: string, ...directives: string[]): string => buildWithReply(eventType, directives, null);
  // Every tool hook carries `tool_name` and `tool_use_id` (hooks docs, preToolUse
  // and postToolUse inputs), so a start and its end pair by id.
  const toolDirectives = [extractTool('tool_name'), extractToolId(['tool_use_id'])];
  const hookEvent = CURSOR_HOOK_EVENTS;
  return {
    [hookEvent.sessionStart]: silentCommand(EventType.SessionStart),
    [hookEvent.sessionEnd]: silentCommand(EventType.SessionEnd),
    [hookEvent.beforeSubmitPrompt]: buildWithReply(EventType.Prompt, [], { continue: true }),
    [hookEvent.preToolUse]: silentCommand(EventType.ToolStart, ...toolDirectives),
    [hookEvent.postToolUse]: silentCommand(EventType.ToolEnd, ...toolDirectives),
    [hookEvent.postToolUseFailure]: silentCommand(EventType.ToolEnd, ...toolDirectives),
    // `subagent_id` and `subagent_type` are subagentStart's inputs. subagentStop
    // carries the type but no id, so its stop is counted rather than matched.
    // The type keeps its detail non-empty, since the engine reads an empty
    // detail as a subagent's inner-loop stop and ignores it.
    [hookEvent.subagentStart]: silentCommand(EventType.SubagentStart, extractSubagentId(['subagent_id']), extractDetail(['subagent_type'])),
    [hookEvent.subagentStop]: silentCommand(EventType.SubagentStop, extractDetail(['subagent_type'])),
    [hookEvent.preCompact]: silentCommand(EventType.Compact),
    // "Called when the agent loop ends", with `status` completed, aborted or
    // error. An aborted loop is the user's interrupt, an errored one a failed turn.
    [hookEvent.stop]: silentCommand(
      EventType.Idle,
      setTypeWhen({ field: 'status', equals: 'aborted', to: EventType.Interrupted }),
      setTypeWhen({ field: 'status', equals: 'error', to: EventType.TurnFailed }),
    ),
  };
}

function hooksPathOf(directory: string): string {
  return path.join(directory, '.cursor', 'hooks.json');
}

/**
 * What a folder's `.cursor/hooks.json` holds: no file, a file Kangentic can
 * merge into, or one it cannot (not JSON it parses, or a `hooks` that is not
 * an object of lists). An unusable file is never rewritten.
 */
type ProjectHooksConfig =
  | { kind: 'absent' }
  | { kind: 'usable'; config: JsonObject; hooks: Record<string, unknown[]> }
  | { kind: 'unusable' };

function readHooksConfig(configPath: string): ProjectHooksConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unusable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unusable' };
  }
  if (!isJsonObject(parsed)) return { kind: 'unusable' };
  const hooks = parsed.hooks ?? {};
  if (!isJsonObject(hooks)) return { kind: 'unusable' };
  const lists: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) return { kind: 'unusable' };
    lists[eventName] = entries;
  }
  return { kind: 'usable', config: parsed, hooks: lists };
}

/** The commands an entry runs, for recognizing Kangentic's own. */
function entryCommands(entry: unknown): string[] {
  return isJsonObject(entry) && typeof entry.command === 'string' ? [entry.command] : [];
}

/** Every event's list with Kangentic's entries taken out. */
function userHooksOf(hooks: Record<string, unknown[]>): Record<string, unknown[]> {
  const kept: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    kept[eventName] = filterKangenticHooks(entries, entryCommands);
  }
  return kept;
}

/**
 * Add Kangentic's entries to `<directory>/.cursor/hooks.json`, keeping the
 * user's own, and report whether they are there. Stale Kangentic entries (an
 * older bridge path) are replaced, not added beside. A file that already holds
 * exactly these entries is left untouched, and so is one Kangentic cannot
 * read. A file Kangentic creates is kept out of `git status`. Never throws. A
 * failed write leaves the session on terminal activity, as before hooks.
 * `eventBridge` defaults to the installed bridge; a test passes its own.
 */
export function writeCursorProjectHooks(
  directory: string,
  { wsl = null, eventBridge }: { wsl?: CursorWslHooks | null; eventBridge?: string } = {},
): boolean {
  const configPath = hooksPathOf(directory);
  const current = readHooksConfig(configPath);
  if (current.kind === 'unusable') {
    console.warn(`[cursor] Left ${configPath} as it is: it is not JSON Kangentic can merge its hooks into.`);
    return false;
  }
  let commands: Record<string, string>;
  try {
    // A distro's hooks publish into the session's transport folder, through a
    // script copy in the project's `.kangentic/` (one command for every session
    // in the folder; the copy finds each session's folder by its variable).
    const wslCommands = wsl
      ? {
          folderHooks: {
            ...prepareWslHookTransport(wsl.sessionDirectory),
            script: copyWslHookScriptInto(directory, CURSOR_WSL_HOOK_COPY_NAME),
          },
          place: wsl.place,
        }
      : null;
    commands = buildCursorHookCommands(eventBridge ?? toForwardSlash(resolveBridgeScript('event-bridge')), wslCommands);
  } catch (error) {
    console.error(`[cursor] Could not prepare the WSL hook transport; the session runs on terminal activity: ${configPath}`, error);
    return false;
  }
  const existingHooks = current.kind === 'usable' ? current.hooks : {};
  const merged: Record<string, unknown[]> = {};
  for (const [eventName, userEntries] of Object.entries(userHooksOf(existingHooks))) {
    // An event that held only Kangentic's entries (one an older install
    // registered) goes with them, as the removal drops it.
    if (userEntries.length > 0 || existingHooks[eventName].length === 0) merged[eventName] = userEntries;
  }
  for (const [eventName, command] of Object.entries(commands)) {
    const ours: CursorHookEntry = { command, timeout: CURSOR_HOOK_TIMEOUT_SECONDS };
    merged[eventName] = [...(merged[eventName] ?? []), ours];
  }
  if (current.kind === 'usable' && JSON.stringify(current.hooks) === JSON.stringify(merged)) return true;
  // A file Kangentic creates gets the documented `version`. A user's file
  // keeps its own keys as they are, so the removal can hand it back unchanged.
  const next = current.kind === 'usable' ? { ...current.config, hooks: merged } : { version: 1, hooks: merged };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  } catch (error) {
    console.error(`[cursor] Failed to write hooks config: ${configPath}`, error);
    return false;
  }
  if (current.kind === 'absent') ensureLocalGitExcludes(directory, ['.cursor/hooks.json']);
  return true;
}

/**
 * Remove Kangentic's entries from `<directory>/.cursor/hooks.json`, leaving the
 * user's, and the file itself only when nothing of the user's is left in it.
 */
export function removeCursorProjectHooks(directory: string): void {
  const configPath = hooksPathOf(directory);
  const current = readHooksConfig(configPath);
  if (current.kind !== 'usable') return;
  const kept = userHooksOf(current.hooks);
  const removedAny = Object.entries(current.hooks).some(([eventName, entries]) => entries.length !== kept[eventName].length);
  if (!removedAny) return;
  const remainingHooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(kept)) {
    if (entries.length > 0) remainingHooks[eventName] = entries;
  }
  const remaining: JsonObject = { ...current.config };
  if (Object.keys(remainingHooks).length > 0) remaining.hooks = remainingHooks;
  else delete remaining.hooks;
  try {
    // A `version` alone is what Kangentic's own write added: nothing of the user's.
    const userKeys = Object.keys(remaining).filter((key) => key !== 'version');
    if (userKeys.length === 0) {
      fs.rmSync(configPath, { force: true });
      return;
    }
    fs.writeFileSync(configPath, JSON.stringify(remaining, null, 2));
  } catch (error) {
    console.error(`[cursor] Failed to clean up hooks config: ${configPath}`, error);
  }
}

/**
 * One events.jsonl line the hooks wrote, as the event bridge wrote it, or null.
 * The bridge writes every line with a numeric `ts` and a string `type`; a line
 * without both is not one of its events.
 */
export function parseCursorHookEvent(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isJsonObject(parsed) || typeof parsed.type !== 'string' || typeof parsed.ts !== 'number') return null;
    return parsed as unknown as SessionEvent;
  } catch {
    return null;
  }
}

/** A sessionStart payload's conversation id field, its UUID captured. */
const HOOK_CONVERSATION_ID = /"(?:session_id|conversation_id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/**
 * The conversation id a sessionStart hook names: `session_id` ("same as
 * `conversation_id`", hooks docs), else the common `conversation_id`. Read with
 * a pattern, not a parse: the bridge cuts the payload it keeps at 2048
 * characters, which can leave the JSON unclosed.
 */
export function cursorSessionIdFromHook(hookContext: string): string | null {
  const match = hookContext.match(HOOK_CONVERSATION_ID);
  return match ? match[1].toLowerCase() : null;
}
