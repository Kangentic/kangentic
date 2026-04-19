import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';

/** All Claude Code hook event names (settings.json keys). */
export const ClaudeHookEvent = {
  // Tool lifecycle
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  // Session lifecycle
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  // Agent stop
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  // User interaction
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'PermissionRequest',
  Notification: 'Notification',
  // Context management
  PreCompact: 'PreCompact',
  // Agent teams
  TeammateIdle: 'TeammateIdle',
  TaskCompleted: 'TaskCompleted',
  // Configuration
  ConfigChange: 'ConfigChange',
  // Worktrees
  WorktreeCreate: 'WorktreeCreate',
  WorktreeRemove: 'WorktreeRemove',
} as const;
export type ClaudeHookEvent = (typeof ClaudeHookEvent)[keyof typeof ClaudeHookEvent];

/** Hook entry in Claude Code's settings.json. */
export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Filter out Kangentic-injected entries, keeping only user-defined hooks. */
function filterOurHooks(entries: ClaudeHookEntry[] | undefined): ClaudeHookEntry[] {
  return filterKangenticHooks(entries, (entry: ClaudeHookEntry) => entry.hooks?.map((hook) => hook.command) ?? []);
}

/** Return the path to `.claude/settings.local.json` for the given directory. */
function settingsLocalPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.local.json');
}

export function buildHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, ClaudeHookEntry[]>,
): Record<string, ClaudeHookEntry[]> {
  const H = ClaudeHookEvent;
  const E = EventType;

  // Claude Code stdin field extraction directives:
  // - tool_name: tool identifier at top level
  // - tool_input: nested object with file_path, command, query, pattern, url, description
  // - is_interrupt / error: PostToolUseFailure context
  // - agent_type / subagent_type: subagent context
  // - message / notification: notification text
  // - task / description / name: task completion info
  // - agent / teammate / name: teammate info
  // - name / path: worktree info
  return {
    ...existingHooks,
    [H.PreToolUse]: [
      ...(existingHooks[H.PreToolUse] || []),
      // Emit `tool_start` by default, but REMAP to `background_shell_start`
      // when the tool is Bash with run_in_background: true, or to
      // `background_shell_end` when the tool is KillBash. The state
      // machine uses these to track active detached children -- a
      // backgrounded Bash fires a well-formed tool_start/tool_end pair
      // around the handle return, then Stop fires while the real child
      // keeps running. Tracking these explicitly lets the engine avoid
      // false-idle while background work is outstanding. See
      // `tests/e2e/background-shell-idle.spec.ts` for the repro.
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolStart,
        'tool:tool_name',
        'nested-detail:tool_input:file_path,command,query,pattern,url,description',
        'remap-nested:tool_input:run_in_background:true:background_shell_start',
        'remap:tool_name:KillBash:background_shell_end') }] },
    ],
    [H.PostToolUse]: [
      ...(existingHooks[H.PostToolUse] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolEnd,
        'tool:tool_name') }] },
    ],
    [H.PostToolUseFailure]: [
      ...(existingHooks[H.PostToolUseFailure] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolEnd,
        'tool:tool_name', 'remap:is_interrupt:true:interrupted', 'detail:error') }] },
    ],
    [H.UserPromptSubmit]: [
      ...(existingHooks[H.UserPromptSubmit] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Prompt) }] },
    ],
    [H.Stop]: [
      ...(existingHooks[H.Stop] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Idle) }] },
    ],
    [H.PermissionRequest]: [
      ...(existingHooks[H.PermissionRequest] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Idle,
        'arg-detail', 'permission') }] },
    ],
    [H.SessionStart]: [
      ...(existingHooks[H.SessionStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.SessionStart) }] },
    ],
    [H.SessionEnd]: [
      ...(existingHooks[H.SessionEnd] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.SessionEnd) }] },
    ],
    [H.SubagentStart]: [
      ...(existingHooks[H.SubagentStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.SubagentStart,
        'detail:agent_type,subagent_type') }] },
    ],
    [H.SubagentStop]: [
      ...(existingHooks[H.SubagentStop] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.SubagentStop,
        'detail:agent_type,subagent_type') }] },
    ],
    [H.Notification]: [
      ...(existingHooks[H.Notification] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Notification,
        'detail:message,notification') }] },
    ],
    [H.PreCompact]: [
      ...(existingHooks[H.PreCompact] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Compact) }] },
    ],
    [H.TeammateIdle]: [
      ...(existingHooks[H.TeammateIdle] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.TeammateIdle,
        'detail:agent,teammate,name') }] },
    ],
    [H.TaskCompleted]: [
      ...(existingHooks[H.TaskCompleted] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.TaskCompleted,
        'detail:task,description,name') }] },
    ],
    [H.ConfigChange]: [
      ...(existingHooks[H.ConfigChange] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ConfigChange) }] },
    ],
    [H.WorktreeCreate]: [
      ...(existingHooks[H.WorktreeCreate] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.WorktreeCreate,
        'detail:name,path') }] },
    ],
    [H.WorktreeRemove]: [
      ...(existingHooks[H.WorktreeRemove] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.WorktreeRemove,
        'detail:name,path') }] },
    ],
  };
}

/**
 * Strip ALL Kangentic hook entries (event-bridge) from
 * `.claude/settings.local.json` at the given directory. Preserves all
 * other user hooks and settings.
 *
 * @deprecated Since the unified --settings approach, Kangentic no longer
 * writes hooks to `.claude/settings.local.json`. This function is kept
 * for backward compatibility - existing worktrees created before the
 * change may still have our hooks in their settings.local.json.
 */
export function removeHooks(dir: string): void {
  safelyUpdateSettingsFile(settingsLocalPath(dir), (parsed) => {
    const settings = parsed as { hooks?: Record<string, ClaudeHookEntry[]> };
    if (!settings?.hooks || typeof settings.hooks !== 'object') return null;

    let changed = false;
    for (const key of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[key])) continue;
      const before = settings.hooks[key].length;
      settings.hooks[key] = filterOurHooks(settings.hooks[key]);
      if (settings.hooks[key].length !== before) changed = true;
      if (settings.hooks[key].length === 0) delete settings.hooks[key];
    }
    if (!changed) return null;

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    return settings;
  }, 'removeHooks');
}
