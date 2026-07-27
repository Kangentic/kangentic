import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';
import { extractTool, extractToolId, extractDetail, setDetail, setTypeWhen, setTypeWhenDetailContains, setTypeWhenDetailMatches } from '../../shared/directive-builders';

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
  StopFailure: 'StopFailure',
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
      // machine uses these to track active detached children - a
      // backgrounded Bash fires a well-formed tool_start/tool_end pair
      // around the handle return, then Stop fires while the real child
      // keeps running. Tracking these explicitly lets the engine avoid
      // false-idle while background work is outstanding. See
      // `tests/e2e/background-shell-idle.spec.ts` for the repro.
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolStart,
        extractTool('tool_name'),
        // Capture Claude's tool_use_id for correlation with the matching
        // PostToolUse. Lets the engine match concurrent ToolEnds to the
        // exact ToolStart instead of falling back to LIFO-by-name.
        // Top-level extraction first (canonical Claude shape), nested
        // fallback for hook payload variations across CLI versions.
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_input' }),
        // Detail extraction priority: shell_id first (KillBash + future
        // shell-aware events) so the engine can use Set-based id
        // tracking. Falls back to the command/path/etc when shell_id
        // is absent, preserving anonymous bg shell behavior.
        extractDetail(['shell_id', 'file_path', 'command', 'query', 'pattern', 'url', 'description'], { nested: 'tool_input' }),
        // Tool-scoped remaps via the typed builder. run_in_background is
        // Bash-only; gating on `whenTool: 'Bash'` makes that explicit so a
        // future tool with an incidental run_in_background field can never
        // be mis-mapped to a bg-shell event.
        setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }),
        setTypeWhen({ field: 'tool_name', equals: 'KillBash', to: EventType.BackgroundShellEnd })) }] },
    ],
    [H.PostToolUse]: [
      ...(existingHooks[H.PostToolUse] || []),
      // Default: emit `tool_end` for every tool. PostToolUse runs AFTER
      // the tool produced a result, so `tool_response` carries the
      // agent-assigned shell id for a backgrounded Bash.
      //
      // The ONLY conditional remap here is the backgrounded-Bash
      // promotion: a Bash whose `tool_response` carries an assigned shell
      // id fires a SECOND `background_shell_start` carrying that id. The
      // engine treats this as a promotion (the anonymous slot from a
      // run_in_background PreToolUse becomes a named slot keyed by the id),
      // OR - for a foreground Bash that Claude auto-backgrounds on timeout -
      // closes the in-flight foreground tool (matched by tool_use_id) and
      // opens a named shell. The id field is `shellId` (camelCase) in
      // Claude's structured tool_response output; older CLIs used
      // `shell_id`, and the TS SDK uses `backgroundTaskId`, so we try all
      // candidates first-non-null into `detail`. `bash_id` is the BashOutput
      // INPUT param, listed last as a defensive fallback.
      //
      // We key the remap on the EXTRACTED detail being a shell id, not on
      // `tool_input.run_in_background`: a foreground Bash that exceeds Claude
      // Code's 10-min ceiling is auto-promoted to a background shell WITHOUT
      // run_in_background:true, but its PostToolUse `tool_response` still
      // carries the assigned shell id (empirically `bjosycg6w` in session
      // 3fc0dca7, events.jsonl line 20). Gating on run_in_background missed
      // that and false-idled the task. The id-shape pattern mirrors
      // `looksLikeShellId` (background-shell/looks-like-shell-id.ts); the
      // engine independently re-classifies named-vs-anonymous via the same
      // shape, so the two MUST be kept in sync by hand (no shared constant
      // links the `^[\w-]{1,64}$` literal here to looksLikeShellId's check).
      // Matching on the resolved
      // detail (not a source field) keeps it robust to CLI field-name skew,
      // exactly like the Notification setTypeWhenDetailContains remap.
      //
      // The inverse risk - a normal foreground Bash mistaken for a
      // backgrounded shell - is structurally avoided: this PostToolUse
      // extractDetail sources ONLY the tool_response shell-id fields, so a
      // plain completion has no detail and never remaps, and a failed Bash
      // flows through PostToolUseFailure (a separate directive set).
      //
      // We deliberately do NOT remap on `tool_response.status`. That field
      // is shared by Bash/BashOutput/Agent, and a tool-blind status remap
      // mis-mapped every foreground Agent/Task completion (status:
      // "completed") to `background_shell_end`, draining real bg-shell
      // counts and causing premature-idle / false "task done"
      // notifications. Real bg-shell termination is owned elsewhere: the
      // process-tree watcher (plus 5-min escape hatch) detects natural
      // exit, and explicit kills emit `background_shell_end` via the
      // PreToolUse KillBash remap. BashOutput polling must not decrement.
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolEnd,
        extractTool('tool_name'),
        // Same correlation id extraction as PreToolUse so the engine
        // can match this end to its start. Claude carries tool_use_id
        // at the top level on PostToolUse; tool_response also has a
        // copy in some shapes - capture both via fallthrough.
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_response' }),
        extractDetail(['shellId', 'shell_id', 'backgroundTaskId', 'bash_id'], { nested: 'tool_response' }),
        // `Monitor` is a background-wait tool with the same lifecycle shape as
        // a backgrounded Bash: PreToolUse fires, the tool returns a handle in
        // ~300ms, PostToolUse fires, and the real wait continues for MINUTES
        // (up to its `timeoutMs`). Untracked, the whole wait reads as idle -
        // the board says "needs you" while the agent is still working.
        //
        // Its id field is `taskId` (`{taskId, timeoutMs, persistent}`), which
        // matches none of the four candidates above. `taskId` is generic
        // enough that a tool-blind extraction would repeat the Agent/Task
        // mis-map recorded at the top of this comment, so it is scoped to
        // Monitor.
        //
        // ORDER is load-bearing in both directions. It sits AFTER the shell-id
        // extractor and still fires because extractDetail is
        // first-extraction-wins and that extractor sources ONLY tool_response
        // shell-id fields, which Monitor's response never carries - not
        // because Monitor happens to be listed second. It sits BEFORE
        // setTypeWhenDetailMatches, which classifies on the resolved detail.
        //
        // Monitor holders drain via the transcript tailer
        // (background-shell-transcript.ts), which covers all three of its
        // terminal shapes: `completed` (stream ended), `stopped`, and the
        // status-less timeout marker.
        extractDetail(['taskId'], { nested: 'tool_response', whenTool: 'Monitor' }),
        setTypeWhenDetailMatches('^[\\w-]{1,64}$', EventType.BackgroundShellStart)) }] },
    ],
    [H.PostToolUseFailure]: [
      ...(existingHooks[H.PostToolUseFailure] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ToolEnd,
        extractTool('tool_name'),
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_input' }),
        setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted }),
        extractDetail(['error'])) }] },
    ],
    [H.UserPromptSubmit]: [
      ...(existingHooks[H.UserPromptSubmit] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Prompt) }] },
      // A background-shell terminal `<task-notification>` (Incident A, session
      // f03f5e43 / shell b9wh3dhov) used to be drained here via a SECOND
      // UserPromptSubmit entry. Empirically (task #386) that notification is
      // delivered as a `queued_command` ATTACHMENT and never fires this hook -
      // the only notifications that DO fire it are subagent/Task completions
      // (a genuine user turn), so the drain never touched a real bg shell and
      // instead fired spuriously on every subagent stop. Removed; the
      // definitive drain now reads the shell's terminal notification straight
      // from the durable transcript - see
      // src/main/agent/adapters/claude/background-shell-transcript.ts and the
      // bg-shell watcher's `reportTerminatedShellsFromTranscript` integration.
    ],
    [H.Stop]: [
      ...(existingHooks[H.Stop] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Idle) }] },
    ],
    // StopFailure fires INSTEAD of Stop when a turn concludes due to an API
    // error (rate limit, overload, server error, auth, ...). Without it, an
    // errored turn that aborted mid-subagent/mid-tool drops its closing hooks:
    // the lost named subagent_stop / tool_end leaves subagentDepth or
    // pendingToolCount stuck > 0, and the board stays falsely "thinking" until
    // the 5-min watchdog. We emit `turn_failed` by default, with the error type
    // carried in `detail` (Claude's payload fields are `error` then
    // `error_details`). See docs.claude.com/docs/en/hooks (StopFailure,
    // changelog 2.1.78).
    //
    // Claude also fires StopFailure for a TRANSIENT error it auto-retries
    // internally (529 overloaded / server_error / rate_limit / api_error), not
    // only a final abort - during that retry backoff the turn is still alive.
    // Reclassify those into the generic `turn_retrying` event (matching the
    // already-extracted `detail`, exactly like the Notification -> `idle_hint`
    // precedent below: the Claude-specific error strings live here, not in the
    // engine), so the activity engine can hold the session thinking through
    // the backoff instead of force-idling it (see EventType.TurnRetrying /
    // ActivityEngine.applyRetryableFailureHold). A terminal error (e.g.
    // authentication_error) falls through and stays `turn_failed`: a hard
    // turn-end that resets counters and idles immediately (the Interrupted
    // bypass).
    [H.StopFailure]: [
      ...(existingHooks[H.StopFailure] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.TurnFailed,
        extractDetail(['error', 'error_details']),
        setTypeWhenDetailContains('overloaded', E.TurnRetrying),
        setTypeWhenDetailContains('server_error', E.TurnRetrying),
        setTypeWhenDetailContains('rate_limit', E.TurnRetrying),
        setTypeWhenDetailContains('api_error', E.TurnRetrying)) }] },
    ],
    [H.PermissionRequest]: [
      ...(existingHooks[H.PermissionRequest] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Idle,
        setDetail('permission')) }] },
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
        extractDetail(['agent_type', 'subagent_type'])) }] },
    ],
    [H.SubagentStop]: [
      ...(existingHooks[H.SubagentStop] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.SubagentStop,
        extractDetail(['agent_type', 'subagent_type'])) }] },
    ],
    [H.Notification]: [
      ...(existingHooks[H.Notification] || []),
      // Default `notification` is log-only. But Claude's "waiting for your
      // input" notification means the turn is genuinely done and waiting on the
      // user - classify it into the generic `idle_hint` event so the activity
      // engine can settle to idle through the stability window instead of
      // stalling on the 180s stale-thinking watchdog when the Stop hook was
      // dropped (e.g. a turn fully delegated to a subagent). The match runs on
      // the already-extracted detail (empirically "Claude is waiting for your
      // input" - see tests/fixtures/replay/session-005-*), so it does not
      // depend on which payload field carried the text. The match string is the
      // only Claude-specific knowledge here; the engine stays generic.
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Notification,
        extractDetail(['message', 'notification']),
        setTypeWhenDetailContains('waiting for your input', E.IdleHint)) }] },
    ],
    [H.PreCompact]: [
      ...(existingHooks[H.PreCompact] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.Compact) }] },
    ],
    [H.TeammateIdle]: [
      ...(existingHooks[H.TeammateIdle] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.TeammateIdle,
        extractDetail(['agent', 'teammate', 'name'])) }] },
    ],
    [H.TaskCompleted]: [
      ...(existingHooks[H.TaskCompleted] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.TaskCompleted,
        extractDetail(['task', 'description', 'name'])) }] },
    ],
    [H.ConfigChange]: [
      ...(existingHooks[H.ConfigChange] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.ConfigChange) }] },
    ],
    [H.WorktreeCreate]: [
      ...(existingHooks[H.WorktreeCreate] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.WorktreeCreate,
        extractDetail(['name', 'path'])) }] },
    ],
    [H.WorktreeRemove]: [
      ...(existingHooks[H.WorktreeRemove] || []),
      { matcher: '', hooks: [{ type: 'command', command: buildBridgeCommand(eventBridge, eventsPath, E.WorktreeRemove,
        extractDetail(['name', 'path'])) }] },
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
