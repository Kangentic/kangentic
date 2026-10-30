import path from 'node:path';
import { AgentTool, EventType, IdleReason } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile, type HookShell } from '../../shared/hook-utils';
import { extractTool, extractDetail, setToolWhen, emitOnlyWhenDetailMatches, setDetail, setWaitKind, setWaitKindWhen } from '../../shared/directive-builders';
import { backgroundLaunchDirective, nestedBackgroundShellHintEntries } from '../../shared/background-command-hooks';
import { BACKGROUND_SHELL_HINT_TEXT } from '../../shared/background-shell-hint-hook';
import type { BackgroundCommandSpec } from '../../../../shared/background-command-spec';

/** Hook entry in Gemini CLI's settings.json. */
export interface GeminiHookEntry {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/**
 * Gemini CLI hook event names (settings.json keys).
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

/** Gemini CLI's plan exit tool, the one that raises its plan approval dialog. */
const GEMINI_PLAN_EXIT_TOOL = 'exit_plan_mode';

/** The `notification_type` of the Notification Gemini sends for a tool confirmation dialog. */
const GEMINI_TOOL_PERMISSION_NOTIFICATION = 'ToolPermission';

/**
 * The `details.type` of that Notification when the dialog is the `ask_user`
 * tool's question rather than a confirmation (`exec`, `edit`, `mcp`, `info`,
 * the plan prompt). Gemini's confirmation details carry the dialog's type, so
 * this one value tells a question from every approval.
 */
const GEMINI_QUESTION_DETAILS_TYPE = 'ask_user';

/**
 * Reports Gemini's plan exit as Kangentic's (`AgentTool.ExitPlanMode`) only for
 * an approved plan, so the card moves to the column's After Plan Mode target as
 * Claude's does. Measured on Gemini CLI 0.63.0: `exit_plan_mode`
 * fires AfterTool for a rejected plan too, and only `tool_response.llmContent`
 * tells them apart: "Plan approved. Switching to Auto-Edit mode ..." against
 * "Plan rejected. User feedback: ...".
 */
const APPROVED_PLAN_EXIT = setToolWhen({
  whenTool: GEMINI_PLAN_EXIT_TOOL,
  nested: ['tool_response', 'llmContent'],
  startsWith: 'Plan approved.',
  to: AgentTool.ExitPlanMode,
});

/** Filter out Kangentic-injected entries, keeping only user-defined hooks. */
function filterOurHooks(entries: GeminiHookEntry[] | undefined): GeminiHookEntry[] {
  return filterKangenticHooks(entries, (entry: GeminiHookEntry) => entry.hooks?.map((hook) => hook.command) ?? []);
}

/**
 * The shell Gemini runs hooks in on Windows: PowerShell, as
 * `pwsh.exe -NoProfile -Command "<command>"` (measured on 0.64.0), or
 * powershell.exe when there is no pwsh. On every platform Gemini first replaces
 * `$NAME` and `${NAME}` in the settings file's strings with the environment's
 * values (`resolveEnvVarsInString`), which the quoting also keeps away from.
 */
export const GEMINI_HOOK_SHELL: HookShell = 'sh-or-powershell';

/**
 * Gemini CLI's background commands (task #859), from a headless 0.64.0 run
 * against a local stand-in for the model API (tests/fixtures/gemini-hooks/).
 * `run_shell_command` with `is_background: true`, or a command the user moves
 * to the background with Ctrl+B, answers `tool_response.llmContent`
 * "<untrusted_context>\nCommand moved to background (PID: N). ...". N is the
 * `pwsh.exe` (Windows) or shell running the command, inside Gemini's tree, so
 * the watcher sees it exit. The id sources are anchored at the start, where a
 * foreground command's result has "Output:", so output that quotes the phrase
 * never reads as a launch. The first matches the wrapper with the single
 * newline the capture shows (on Windows too); the second covers a result
 * without the `<untrusted_context>` wrapper. N is read as id characters, not
 * digits only: the anchored phrase is Gemini's own text, which only ever holds
 * a PID there. Gemini has no stop tool. Gemini adds an AfterTool
 * `hookSpecificOutput.additionalContext` to the tool response inside
 * `<hook_context>`. Its payloads carry no tool id.
 */
export const GEMINI_BACKGROUND_COMMAND_SPEC: BackgroundCommandSpec = {
  launch: {
    toolField: 'tool_name',
    tools: ['run_shell_command'],
    when: [],
    unless: [],
    idSources: [
      { path: ['tool_response', 'llmContent'], before: '<untrusted_context>\nCommand moved to background (PID: ', after: ')', atStart: true },
      { path: ['tool_response', 'llmContent'], before: 'Command moved to background (PID: ', after: ')', atStart: true },
    ],
    commandPath: ['tool_input', 'command'],
  },
  hintReply: {
    hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: BACKGROUND_SHELL_HINT_TEXT },
  },
};

/** Options for `buildHooks`. */
export interface GeminiBuildHooksOptions {
  /**
   * The background shell hint's command (`backgroundShellHintCommandFor`),
   * registered on AfterTool for the shell tool alone. Passed only for a
   * session offered `kangentic_mark_background_service`.
   */
  backgroundShellHintCommand?: string | null;
  /**
   * Builds each event hook's command in place of `node <event-bridge>`: for a
   * Gemini installed in a WSL distro, the transport's `wslHookEventCommand`,
   * with the same event types and directives. Gemini passes a hook its
   * payload on stdin, which the transport's `event` mode reads. Absent: the
   * node bridge, as before.
   */
  eventCommand?: (eventType: string, ...directives: string[]) => string;
}

/** Build a single Gemini hook entry for the event bridge, or the command `eventCommand` builds in its place. */
function bridgeEntry(
  eventBridge: string,
  eventsPath: string,
  eventCommand: GeminiBuildHooksOptions['eventCommand'],
  eventType: string,
  ...directives: string[]
): GeminiHookEntry {
  return {
    matcher: '*',
    hooks: [{
      name: `kangentic-${eventType}`,
      type: 'command',
      command: eventCommand
        ? eventCommand(eventType, ...directives)
        : buildBridgeCommand(GEMINI_HOOK_SHELL, eventBridge, eventsPath, eventType, ...directives),
    }],
  };
}

/**
 * Build event-bridge hook entries to merge into Gemini CLI settings.
 * Maps available Gemini hook events to our event-bridge script.
 *
 * Strips any stale Kangentic hooks from existingHooks before injecting
 * fresh ones. Gemini has no --settings flag, so hooks live in the shared
 * project-level .gemini/settings.json. Normal cleanup runs via
 * removeHooks() on session exit/suspend, but if the app was killed
 * (force quit, crash, taskkill), those callbacks never fire and orphan
 * hooks would accumulate. Stripping here ensures each spawn starts with
 * exactly one set of Kangentic hooks regardless of how the previous
 * session ended.
 */
export function buildHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, GeminiHookEntry[]>,
  options: GeminiBuildHooksOptions = {},
): Record<string, GeminiHookEntry[]> {
  // Gemini CLI stdin field extraction directives:
  // - tool_name: tool identifier at top level
  // - tool_input: nested object with file_path, content, etc.
  // - message: notification text
  const H = GeminiHookEvent;
  const E = EventType;
  return {
    ...existingHooks,
    [H.BeforeTool]: [
      ...filterOurHooks(existingHooks[H.BeforeTool]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.ToolStart,
        extractTool('tool_name'), extractDetail(['file_path', 'command', 'query'], { nested: 'tool_input' })),
    ],
    // A background launch rides the tool_end entry, and the hint runs beside
    // it for the shell tool alone. Gemini runs one event's hooks in parallel
    // (measured on 0.64.0).
    [H.AfterTool]: [
      ...filterOurHooks(existingHooks[H.AfterTool]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.ToolEnd, extractTool('tool_name'), APPROVED_PLAN_EXIT,
        backgroundLaunchDirective(GEMINI_BACKGROUND_COMMAND_SPEC)),
      ...nestedBackgroundShellHintEntries(GEMINI_BACKGROUND_COMMAND_SPEC, options.backgroundShellHintCommand),
    ],
    [H.SessionStart]: [
      ...filterOurHooks(existingHooks[H.SessionStart]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.SessionStart),
    ],
    [H.SessionEnd]: [
      ...filterOurHooks(existingHooks[H.SessionEnd]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.SessionEnd),
    ],
    [H.AfterAgent]: [
      ...filterOurHooks(existingHooks[H.AfterAgent]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.Idle),
    ],
    [H.BeforeAgent]: [
      ...filterOurHooks(existingHooks[H.BeforeAgent]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.Prompt),
    ],
    [H.Notification]: [
      ...filterOurHooks(existingHooks[H.Notification]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.Notification, extractDetail(['message', 'notification'])),
      // A tool confirmation dialog (the plan prompt included) is a permission
      // wait, so the card shows the session needs you. Gemini 0.63.0 has no
      // permission hook: it reports each dialog as a Notification whose
      // `notification_type` is "ToolPermission" (`fireToolNotificationEvent`),
      // and the AfterTool that follows the answer clears it. The dialog's own
      // type is `details.type`: `ask_user` is a question, the rest approvals.
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.Idle,
        extractDetail(['notification_type']),
        emitOnlyWhenDetailMatches(`^${GEMINI_TOOL_PERMISSION_NOTIFICATION}$`),
        setDetail(IdleReason.Permission),
        setWaitKind('approval'),
        setWaitKindWhen({ path: ['details', 'type'], equals: GEMINI_QUESTION_DETAILS_TYPE, to: 'question' })),
    ],
    [H.PreCompress]: [
      ...filterOurHooks(existingHooks[H.PreCompress]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.Compact),
    ],
    [H.BeforeModel]: [
      ...filterOurHooks(existingHooks[H.BeforeModel]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.ModelStart, extractDetail(['model'], { nested: 'llm_request' })),
    ],
    [H.AfterModel]: [
      ...filterOurHooks(existingHooks[H.AfterModel]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.ModelEnd, extractDetail(['model'], { nested: 'llm_request' })),
    ],
    [H.BeforeToolSelection]: [
      ...filterOurHooks(existingHooks[H.BeforeToolSelection]),
      bridgeEntry(eventBridge, eventsPath, options.eventCommand, E.ToolSelectionStart),
    ],
  };
}

/**
 * Return the path to `.gemini/settings.json` for the given directory.
 */
function geminiSettingsPath(directory: string): string {
  return path.join(directory, '.gemini', 'settings.json');
}

/** The parts of a parsed `.gemini/settings.json` that Kangentic writes into. */
export interface GeminiSettingsWithKangenticEntries {
  hooks?: Record<string, GeminiHookEntry[]>;
  mcpServers?: Record<string, unknown>;
}

/**
 * Strip ALL Kangentic hook entries AND the Kangentic MCP server entry from a
 * parsed `.gemini/settings.json`, in place. Preserves all other user hooks,
 * MCP servers, and settings. Returns whether anything was removed.
 *
 * Shared by `removeHooks()` and the command builder's read of the folder's
 * settings. In the main repo that read finds the file the previous spawn
 * wrote, and this strip is what keeps that spawn's entries out of the user's
 * baseline.
 */
export function stripKangenticEntries(settings: GeminiSettingsWithKangenticEntries): boolean {
  let changed = false;

  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const key of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[key])) continue;
      const before = settings.hooks[key].length;
      settings.hooks[key] = filterOurHooks(settings.hooks[key]);
      if (settings.hooks[key].length !== before) changed = true;
      if (settings.hooks[key].length === 0) delete settings.hooks[key];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (
    settings.mcpServers
    && typeof settings.mcpServers === 'object'
    && 'kangentic' in settings.mcpServers
  ) {
    delete settings.mcpServers.kangentic;
    changed = true;
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }

  return changed;
}

/**
 * Remove ALL Kangentic hook entries AND the Kangentic MCP server entry from
 * `.gemini/settings.json` at the given directory (`stripKangenticEntries`).
 *
 * Called on session exit/suspend to clean up what buildHooks() and the
 * command builder injected. Gemini has no --settings flag, so both live in
 * the shared project-level file and must be explicitly removed when the
 * session ends. Removing the MCP entry matters beyond tidiness: it carries
 * the per-launch token in plaintext, so leaving it behind would strand a
 * credential in a file users may commit.
 */
export function removeHooks(directory: string): void {
  safelyUpdateSettingsFile(geminiSettingsPath(directory), (parsed) => {
    const settings = parsed as GeminiSettingsWithKangenticEntries;
    if (!settings || typeof settings !== 'object') return null;
    return stripKangenticEntries(settings) ? settings : null;
  }, 'removeHooks');
}
