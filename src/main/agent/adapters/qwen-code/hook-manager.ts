import path from 'node:path';
import { AgentTool, EventType, IdleReason } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';
import { extractTool, extractToolId, extractDetail, extractPlanMode, extractSubagentId, setDetail, setToolWhen, setTypeWhen } from '../../shared/directive-builders';

/** Hook entry in Qwen Code's settings.json. */
export interface QwenHookEntry {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/**
 * Qwen Code hook event names (settings.json keys).
 *
 * Qwen forked gemini-cli but did not keep its hook system. Its
 * `HookEventName` (packages/core/src/hooks/types.ts) uses Claude Code's
 * names: read from the 0.21.7 and 0.24.0 bundles, and the same in upstream
 * v0.12.0 and v0.15.3. Qwen skips any other key with an "Invalid hook event
 * name ... Skipping." warning in its TUI, so the Gemini names Kangentic once
 * wrote here (BeforeTool, AfterAgent, ...) never loaded on any of them.
 * StopFailure arrived after v0.12.0; every other name below is in v0.12.0.
 */
export const QwenHookEvent = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  UserPromptSubmit: 'UserPromptSubmit',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  PermissionRequest: 'PermissionRequest',
  Notification: 'Notification',
  PreCompact: 'PreCompact',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
} as const;
export type QwenHookEvent = (typeof QwenHookEvent)[keyof typeof QwenHookEvent];

/** Qwen Code's plan exit tool, the one that raises its plan approval dialog. */
const QWEN_PLAN_EXIT_TOOL = 'exit_plan_mode';

/**
 * Reports Qwen's plan exit as Kangentic's (`AgentTool.ExitPlanMode`) only for
 * an approved plan, so the card moves to the column's After Plan Mode target as
 * Claude's does. `exit_plan_mode` fires PostToolUse with no error for a plan it
 * did not act on too ("Plan execution was not approved. Remaining in plan
 * mode.", "Plan approval is stale because ..."), so only
 * `tool_response.llmContent` tells them apart.
 *
 * Qwen's own `PLAN_EXIT_APPROVED_LLM_CONTENT_PREFIXES` (0.21.7 and 0.24.0) has
 * a second entry, "Leader approved.", which is deliberately left out. Only
 * `executePlanRequiredTeammate` writes it: the plan of an in-process teammate,
 * approved by the session's agent, while the session itself stays in plan mode.
 * A rejection in the dialog never runs the tool, so it fires no PostToolUse.
 */
const APPROVED_PLAN_EXIT = setToolWhen({
  whenTool: QWEN_PLAN_EXIT_TOOL,
  nested: ['tool_response', 'llmContent'],
  startsWith: 'User approved.',
  to: AgentTool.ExitPlanMode,
});

/**
 * Keys under `hooks` that configure the hook system instead of naming an event
 * (Qwen's `HOOKS_CONFIG_FIELDS`). Their values are not entry lists.
 */
const HOOK_CONFIG_KEYS: ReadonlySet<string> = new Set(['enabled', 'disabled', 'notifications']);

/** Filter out Kangentic-injected entries, keeping only user-defined hooks. */
function filterOurHooks(entries: QwenHookEntry[] | undefined): QwenHookEntry[] {
  return filterKangenticHooks(entries, (entry: QwenHookEntry) => entry?.hooks?.map((hook) => hook?.command) ?? []);
}

/**
 * The user's own hooks: Kangentic's entries stripped from EVERY event key, not
 * only the keys this build writes, so a settings file an older Kangentic left
 * with Gemini-named entries is cleaned on the next spawn. A key the sweep
 * empties is dropped; a config key, or any value that is not an entry list,
 * passes through untouched.
 */
function userHooksOnly(existingHooks: Record<string, QwenHookEntry[]>): Record<string, QwenHookEntry[]> {
  const userHooks: Record<string, QwenHookEntry[]> = {};
  for (const [key, value] of Object.entries(existingHooks)) {
    if (HOOK_CONFIG_KEYS.has(key) || !Array.isArray(value)) {
      userHooks[key] = value;
      continue;
    }
    const kept = filterOurHooks(value);
    if (kept.length > 0 || value.length === 0) userHooks[key] = kept;
  }
  return userHooks;
}

/** Build a single Qwen hook entry for the event bridge. */
function bridgeEntry(eventBridge: string, eventsPath: string, eventType: string, ...directives: string[]): QwenHookEntry {
  return {
    matcher: '*',
    hooks: [{
      name: `kangentic-${eventType}`,
      type: 'command',
      command: buildBridgeCommand(eventBridge, eventsPath, eventType, ...directives),
    }],
  };
}

/**
 * Build event-bridge hook entries to merge into Qwen Code settings.
 *
 * Each event maps the way the Claude adapter maps the event of the same name,
 * minus Claude's tool-specific remaps (Bash, KillBash, Monitor), which key on
 * Claude's tool names. Payload fields read from the 0.24.0 bundle: every
 * payload carries `session_id`; tool events carry `tool_name`, `tool_input`
 * and `tool_use_id` (one synthetic id per execution, shared by PreToolUse and
 * its PostToolUse or PostToolUseFailure); PostToolUse adds `tool_response`
 * (`{ llmContent, returnDisplay }`); PostToolUseFailure adds `error` and
 * `is_interrupt`; StopFailure carries `error` and `error_details`. In 0.24.0
 * every payload also carries `permission_mode`, and `agent_id` when it runs
 * inside a subagent's context. 0.21.7 leaves `permission_mode` off
 * UserPromptSubmit and Stop, so the plan mode report is absent there and the
 * engine reads it as unknown.
 *
 * A live 0.25.2 session (tests/fixtures/qwen-hooks/) fires PreToolUse, then
 * PermissionRequest, the same order as Claude. A subagent fires no
 * UserPromptSubmit or Stop, in the foreground or the background: only
 * SubagentStart, SubagentStop and its own tool events, which carry `agent_id`.
 *
 * Strips any stale Kangentic hooks from existingHooks before injecting fresh
 * ones. Qwen Code has no --settings flag, so hooks live in the shared
 * project-level .qwen/settings.json. Normal cleanup runs via removeHooks() on
 * session exit/suspend, but if the app was killed (force quit, crash,
 * taskkill), those callbacks never fire and orphan hooks would accumulate.
 * Stripping here ensures each spawn starts with exactly one set of Kangentic
 * hooks regardless of how the previous session ended.
 */
export function buildHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, QwenHookEntry[]>,
): Record<string, QwenHookEntry[]> {
  const userHooks = userHooksOnly(existingHooks);
  const withBridge = (hookEvent: QwenHookEvent, eventType: string, ...directives: string[]): QwenHookEntry[] => {
    // A hand-edited value that is not an entry list (Qwen rejects one) is
    // replaced, not spread: a string would split and an object would throw.
    const userEntries: unknown = userHooks[hookEvent];
    return [
      ...(Array.isArray(userEntries) ? userEntries : []),
      bridgeEntry(eventBridge, eventsPath, eventType, ...directives),
    ];
  };
  // The session's mode at each prompt and turn end (SessionEvent.planMode),
  // never a subagent's, whose payload carries `agent_id`.
  const planMode = extractPlanMode('permission_mode', ['plan'], { unlessField: 'agent_id' });
  return {
    ...userHooks,
    [QwenHookEvent.PreToolUse]: withBridge(QwenHookEvent.PreToolUse, EventType.ToolStart,
      extractTool('tool_name'),
      extractToolId(['tool_use_id']),
      extractDetail(['file_path', 'command', 'query'], { nested: 'tool_input' })),
    // Fires only for a result with no error; an error or a cancel fires
    // PostToolUseFailure instead.
    [QwenHookEvent.PostToolUse]: withBridge(QwenHookEvent.PostToolUse, EventType.ToolEnd,
      extractTool('tool_name'),
      extractToolId(['tool_use_id']),
      APPROVED_PLAN_EXIT),
    [QwenHookEvent.PostToolUseFailure]: withBridge(QwenHookEvent.PostToolUseFailure, EventType.ToolEnd,
      extractTool('tool_name'),
      extractToolId(['tool_use_id']),
      setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted }),
      extractDetail(['error'])),
    [QwenHookEvent.UserPromptSubmit]: withBridge(QwenHookEvent.UserPromptSubmit, EventType.Prompt, planMode),
    [QwenHookEvent.Stop]: withBridge(QwenHookEvent.Stop, EventType.Idle, planMode),
    // Fires instead of Stop when an API error or loop detection ends the turn.
    // The TUI fires it from its error handler once retries are over, so it is
    // always a final failure: no turn_retrying remap.
    [QwenHookEvent.StopFailure]: withBridge(QwenHookEvent.StopFailure, EventType.TurnFailed, extractDetail(['error', 'error_details'])),
    // The tool rides along so the permission idle names what is waiting.
    [QwenHookEvent.PermissionRequest]: withBridge(QwenHookEvent.PermissionRequest, EventType.Idle,
      setDetail(IdleReason.Permission),
      extractTool('tool_name')),
    // A background subagent keeps working after the main agent's Stop, which
    // is a turn end only once its SubagentStop brings the depth back to zero.
    // Without these, that Stop ran the column's turn-end automations while the
    // subagent still worked (the live capture's line 17). Both carry
    // `agent_id`, as Claude's do.
    [QwenHookEvent.SubagentStart]: withBridge(QwenHookEvent.SubagentStart, EventType.SubagentStart,
      extractDetail(['agent_type']),
      extractSubagentId(['agent_id'])),
    [QwenHookEvent.SubagentStop]: withBridge(QwenHookEvent.SubagentStop, EventType.SubagentStop,
      extractDetail(['agent_type']),
      extractSubagentId(['agent_id'])),
    [QwenHookEvent.Notification]: withBridge(QwenHookEvent.Notification, EventType.Notification, extractDetail(['message', 'notification'])),
    [QwenHookEvent.PreCompact]: withBridge(QwenHookEvent.PreCompact, EventType.Compact),
    [QwenHookEvent.SessionStart]: withBridge(QwenHookEvent.SessionStart, EventType.SessionStart),
    [QwenHookEvent.SessionEnd]: withBridge(QwenHookEvent.SessionEnd, EventType.SessionEnd),
  };
}

/** Path to `.qwen/settings.json` for the given directory. */
function qwenSettingsPath(directory: string): string {
  return path.join(directory, '.qwen', 'settings.json');
}

/**
 * Remove ALL Kangentic-injected entries from `.qwen/settings.json` at
 * the given directory. Preserves user hooks, user MCP servers, and any
 * other user settings.
 *
 * Cleans up two kinds of injected entries:
 *   1. Hook entries written by `buildHooks()`, under any event key
 *      (including the Gemini-named keys older builds wrote) - matched by
 *      the `isKangenticHookCommand` guard.
 *   2. The `mcpServers.kangentic` entry written by the command builder
 *      when wiring the in-process MCP HTTP server. Pulled out unconditionally
 *      because the entry name is fixed.
 *
 * Called on session exit/suspend. Qwen Code has no --settings flag, so
 * these entries live in the shared project-level file and must be
 * explicitly removed when the session ends - otherwise stale tokens
 * stay on disk and user hooks are noisy.
 */
export function removeHooks(directory: string): void {
  safelyUpdateSettingsFile(qwenSettingsPath(directory), (parsed) => {
    const settings = parsed as {
      hooks?: Record<string, QwenHookEntry[]>;
      mcpServers?: Record<string, unknown>;
    };
    if (!settings || typeof settings !== 'object') return null;

    let changed = false;

    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const key of Object.keys(settings.hooks)) {
        if (HOOK_CONFIG_KEYS.has(key) || !Array.isArray(settings.hooks[key])) continue;
        const before = settings.hooks[key].length;
        settings.hooks[key] = filterOurHooks(settings.hooks[key]);
        if (settings.hooks[key].length !== before) changed = true;
        if (settings.hooks[key].length === 0) delete settings.hooks[key];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (
      settings.mcpServers &&
      typeof settings.mcpServers === 'object' &&
      'kangentic' in settings.mcpServers
    ) {
      delete settings.mcpServers.kangentic;
      changed = true;
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    }

    if (!changed) return null;
    return settings;
  }, 'removeHooks');
}
