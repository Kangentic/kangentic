import { EventType, IdleReason } from '../../../../shared/types';
import type { SessionEvent } from '../../../../shared/types';
import { buildBridgeCommand, type HookShell } from '../../shared/hook-utils';
import {
  emitOnlyWhenDetailMatches, extractDetail, extractTool, setDetail, setWaitKind, setWaitKindWhen,
} from '../../shared/directive-builders';

/**
 * Droid's hooks, for the waits on the user (#452).
 *
 * Droid takes a per-process settings file (`droid --settings <path>`, "merged
 * for this process only", 0.218.0's `--help`), and a hook pipeline through it
 * was measured in `droid exec` on 0.218.0 (`tests/fixtures/droid-hooks/`):
 * SessionStart, PreToolUse, PostToolUse and Stop fired, UserPromptSubmit did
 * not, and the file merged with the user's `~/.factory/settings.json`. Hooks
 * concatenate per event: a SessionStart in the file and one in the project's
 * `.factory/settings.json` both ran, the file's first, so a user's own hooks
 * keep running beside Kangentic's. The TUI
 * asks for a Factory sign-in even with a BYOK model, so its Notification was
 * never captured: its shape comes from Factory's hooks reference, which lists
 * `notification_type` values `permission_prompt`, `idle_prompt`,
 * `auth_success` and `elicitation_dialog`.
 *
 * Only what the waits need is wired:
 * - Notification: `elicitation_dialog` (the AskUser tool's question) and
 *   `permission_prompt` (a tool to allow) become the permission wait, of that
 *   kind. Every other notification is dropped. It carries no question text.
 * - PreToolUse and PostToolUse: the tool start a wait follows and the tool
 *   end that answers it (the engine's depth-0 clear).
 * - UserPromptSubmit: the user's next message, which also clears a wait whose
 *   tool never ended (a rejected prompt), if Droid's TUI fires it.
 *
 * Stop is deliberately left out. Droid's turn ends stay with the PTY silence
 * timer (`reportsTurnEnd: false`), as before, so these hooks start no turn-end
 * automations of their own.
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

/**
 * The settings file Kangentic passes with `--settings`: the hooks above and
 * nothing else, so the user's own settings (models, autonomy) stay theirs.
 */
export function buildDroidHookSettings(eventBridge: string, eventsPath: string): { hooks: Record<string, DroidHookEntry[]> } {
  const command = (eventType: string, ...directives: string[]): string =>
    buildBridgeCommand(DROID_HOOK_SHELL, eventBridge, eventsPath, eventType, ...directives);
  const entry = (hookCommand: string, matcher?: string): DroidHookEntry => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command: hookCommand, timeout: DROID_HOOK_TIMEOUT_SECONDS }],
  });
  return {
    hooks: {
      PreToolUse: [entry(command(EventType.ToolStart,
        extractTool('tool_name'),
        extractDetail(['command', 'file_path', 'path', 'pattern'], { nested: 'tool_input' })), '*')],
      PostToolUse: [entry(command(EventType.ToolEnd, extractTool('tool_name')), '*')],
      UserPromptSubmit: [entry(command(EventType.Prompt))],
      Notification: [entry(command(EventType.Idle,
        extractDetail(['notification_type']),
        emitOnlyWhenDetailMatches(`^(${DROID_QUESTION_NOTIFICATION}|${DROID_APPROVAL_NOTIFICATION})$`),
        setDetail(IdleReason.Permission),
        setWaitKind('approval'),
        setWaitKindWhen({ path: ['notification_type'], equals: DROID_QUESTION_NOTIFICATION, to: 'question' })))],
    },
  };
}
