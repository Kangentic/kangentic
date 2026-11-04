import { EventType, IdleReason } from '../../../../shared/types';
import type { SessionEvent } from '../../../../shared/types';
import { buildBridgeCommand, type HookShell } from '../../shared/hook-utils';
import {
  emitOnlyWhenDetailMatches, extractDetail, extractTool, setDetail, setWaitKind, setWaitKindWhen,
} from '../../shared/directive-builders';
import { BROWSER_POLICY_DENY_TEXT, browserPolicySpec, type BrowserPolicyHookSpec } from '../../shared/browser-policy-hook';

/**
 * Droid's hooks: the tool calls, the waits on the user (#452), and the session
 * lifecycle.
 *
 * Droid takes a per-process settings file (`droid --settings <path>`, "merged
 * for this process only", 0.218.0's `--help`), and a hook pipeline through it
 * was measured in `droid exec` on 0.218.0 (`tests/fixtures/droid-hooks/`):
 * SessionStart, PreToolUse, PostToolUse and Stop fired, UserPromptSubmit did
 * not, and the file merged with the user's `~/.factory/settings.json`. Hooks
 * concatenate per event: a SessionStart in the file and one in the project's
 * `.factory/settings.json` both ran, the file's first, so a user's own hooks
 * keep running beside Kangentic's. The TUI asks for a Factory sign-in even with
 * a BYOK model, so no TUI hook was ever captured.
 *
 * Event names and payload fields not measured come from Factory's hooks
 * reference (https://docs.factory.com/reference/hooks-reference, read
 * 2026-11-03 against CLI v1.2.0): every hook carries `session_id`,
 * `transcript_path`, `cwd`, `permission_mode` and `hook_event_name`;
 * UserPromptSubmit adds `prompt`; Notification adds `message` and
 * `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`,
 * `elicitation_dialog`); PreCompact adds `trigger`; SessionStart adds `source`
 * (`startup`, `resume`, `clear`, `compact`); SessionEnd adds `reason`.
 *
 * What is wired:
 * - Notification: `elicitation_dialog` (the AskUser tool's question) and
 *   `permission_prompt` (a tool to allow) become the permission wait, of that
 *   kind. Every other notification is dropped. It carries no question text.
 * - PreToolUse and PostToolUse: the tool start a wait follows and the tool end
 *   that answers it (the engine's depth-0 clear).
 * - UserPromptSubmit: the user's next message, which also clears a wait whose
 *   tool never ended (a rejected prompt), if Droid's TUI fires it.
 * - SessionStart: the session's own id (`parseDroidSessionIdFromHook`), so a
 *   second Droid in the same folder cannot hand this session its id.
 * - SessionEnd and PreCompact: log events, and the compaction count.
 *
 * Stop is deliberately left out, and no hook here emits a plain Idle: an Idle
 * that is not a permission wait ends the turn in the engine and runs the
 * column's On agent turn end automations, whatever `reportsTurnEnd` says.
 * Droid's turn ends stay with the PTY silence timer (`reportsTurnEnd: false`)
 * until a TUI session is measured. SubagentStop is left out too: Droid has no
 * SubagentStart, so a stop would unbalance the subagent depth; the Task tool's
 * own PreToolUse and PostToolUse already bracket a subagent.
 */

/** The Notification types that are a wait on the user, and the kind each one is. */
const DROID_QUESTION_NOTIFICATION = 'elicitation_dialog';
const DROID_APPROVAL_NOTIFICATION = 'permission_prompt';

/**
 * How Droid runs a hook command on Windows. Not measured: the 0.218.0 probe's
 * `node "<forward-slashed path>" <event>` command ran, which this quoting
 * produces for an ordinary path (double quotes, forward slashes).
 */
export const DROID_HOOK_SHELL: HookShell = 'sh-or-powershell';

/** One hook entry in Droid's settings shape (Claude's: matcher groups of command hooks). */
export interface DroidHookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout: number }>;
}

const DROID_HOOK_TIMEOUT_SECONDS = 10;

export interface DroidHookOptions {
  /**
   * Copy UserPromptSubmit's `prompt` into the Prompt event's `detail`. Only a
   * Command Terminal asks for it, to name itself from its first prompt.
   */
  capturePromptText?: boolean;
  /** The browser policy hook, registered on PreToolUse with its own matcher. */
  browserPolicy?: { matcher: string; command: string } | null;
  /**
   * Builds each event hook's command in place of `node <event-bridge>`: for a
   * Droid installed in a WSL distro, the WSL hook transport's
   * `wslHookEventCommand`, with the same event types and directives.
   */
  eventCommand?: (eventType: string, ...directives: string[]) => string;
}

/** One events.jsonl line the hooks wrote, as the event bridge wrote it, or null. */
export function parseDroidHookEvent(line: string): SessionEvent | null {
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

/** A session id as Droid writes one: a standard 8-4-4-4-12 UUID. */
const DROID_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id in a SessionStart hook's payload (`runtime.sessionId.fromHook`).
 * Every Droid hook carries `session_id` (the hooks reference; the 0.218.0
 * fixture `droid-0.218.0-session-start.json`). The event bridge caps the
 * stored payload at 2048 characters, and `transcript_path` alone can run to
 * hundreds, so a payload cut short is read with a pattern for the id field,
 * which comes first. Null when neither finds a UUID.
 */
export function parseDroidSessionIdFromHook(hookContext: string): string | null {
  let candidate: unknown = null;
  try {
    const parsed: unknown = JSON.parse(hookContext);
    if (parsed && typeof parsed === 'object') candidate = (parsed as { session_id?: unknown }).session_id;
  } catch {
    candidate = /"session_id"\s*:\s*"([^"]+)"/.exec(hookContext)?.[1] ?? null;
  }
  return typeof candidate === 'string' && DROID_SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The browser policy's spec for Droid. Droid reads the same PreToolUse reply
 * Claude does (`hookSpecificOutput.permissionDecision: "deny"` with a reason,
 * Factory's hooks reference) and names MCP tools `mcp__<server>__<tool>`, so
 * only the servers differ.
 */
export function droidBrowserPolicySpec(servers: string[], configPath: string): BrowserPolicyHookSpec {
  return browserPolicySpec({
    toolField: 'tool_name',
    servers,
    configPath,
    reply: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: BROWSER_POLICY_DENY_TEXT,
      },
    },
  });
}

/**
 * The settings file Kangentic passes with `--settings`: the hooks above and
 * nothing else, so the user's own settings (models, autonomy) stay theirs.
 */
export function buildDroidHookSettings(
  eventBridge: string,
  eventsPath: string,
  options: DroidHookOptions = {},
): { hooks: Record<string, DroidHookEntry[]> } {
  const command = options.eventCommand
    ?? ((eventType: string, ...directives: string[]): string =>
      buildBridgeCommand(DROID_HOOK_SHELL, eventBridge, eventsPath, eventType, ...directives));
  const entry = (hookCommand: string, matcher?: string): DroidHookEntry => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command: hookCommand, timeout: DROID_HOOK_TIMEOUT_SECONDS }],
  });
  return {
    hooks: {
      PreToolUse: [
        entry(command(EventType.ToolStart,
          extractTool('tool_name'),
          extractDetail(['command', 'file_path', 'path', 'pattern'], { nested: 'tool_input' })), '*'),
        ...(options.browserPolicy ? [entry(options.browserPolicy.command, options.browserPolicy.matcher)] : []),
      ],
      PostToolUse: [entry(command(EventType.ToolEnd, extractTool('tool_name')), '*')],
      UserPromptSubmit: [entry(options.capturePromptText
        ? command(EventType.Prompt, extractDetail(['prompt']))
        : command(EventType.Prompt))],
      Notification: [entry(command(EventType.Idle,
        extractDetail(['notification_type']),
        emitOnlyWhenDetailMatches(`^(${DROID_QUESTION_NOTIFICATION}|${DROID_APPROVAL_NOTIFICATION})$`),
        setDetail(IdleReason.Permission),
        setWaitKind('approval'),
        setWaitKindWhen({ path: ['notification_type'], equals: DROID_QUESTION_NOTIFICATION, to: 'question' })))],
      SessionStart: [entry(command(EventType.SessionStart))],
      SessionEnd: [entry(command(EventType.SessionEnd))],
      PreCompact: [entry(command(EventType.Compact))],
    },
  };
}
