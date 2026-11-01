import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { filterKangenticHooks, buildBridgeCommand, safelyUpdateSettingsFile, type HookShell } from '../../shared/hook-utils';
import { extractTool, extractToolId, extractSubagentId, extractDetail, extractPlanMode, markSubagentLaunch, setDetail, setTypeWhen, setTypeWhenDetailContains, setTypeWhenDetailMatches, setWaitKind, setWaitKindWhen } from '../../shared/directive-builders';
import { PLAN_APPROVAL_MODE, PLAN_APPROVAL_TOOL_INPUT, type PlanApprovalHookSpec } from '../../shared/plan-approval-hook';
import { BACKGROUND_SHELL_HINT_TEXT, type BackgroundShellHintSpec } from '../../shared/background-shell-hint-hook';
import { NO_ACTIVITY_HOLD_FLAG } from '../../../../shared/background-shell-hold';
import { CLAUDE_PLAN_TOOL_APPROVAL_MATCHER } from './plan-tool-approval';
import { CLAUDE_SUBAGENT_SPAWN_TOOL } from './subagent-usage-parser';

/**
 * The tools a Claude call starts a subagent with: `Agent` in current CLIs
 * (the replay captures under `tests/fixtures/replay/` name it so), and the
 * older `Task`, which the subagent sidecars still record.
 */
const CLAUDE_SUBAGENT_LAUNCH_TOOLS = ['Agent', CLAUDE_SUBAGENT_SPAWN_TOOL];

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

export interface BuildHooksOptions {
  /**
   * Copy UserPromptSubmit's `prompt` into the Prompt event's `detail` (the
   * bridge caps it at `FIELD_CAP`, 2000 characters). Only a Command Terminal asks for it, to
   * name itself; task sessions keep prompt text out of their events file.
   */
  capturePromptText?: boolean;
  /**
   * The plan approval hook's command (`buildPlanApprovalCommand`), registered
   * on PermissionRequest with the matcher EXACTLY `ExitPlanMode`, so it never
   * runs for a question the agent asks (AskUserQuestion) or any other prompt.
   * Claude runs it beside the catch-all entry below; the decision file decides
   * whether it answers.
   */
  planApprovalCommand?: string;
  /**
   * The same bridge built with the session's plan tool approval spec
   * (`claudePlanToolApprovalSpec`), registered on PermissionRequest with the
   * matcher `CLAUDE_PLAN_TOOL_APPROVAL_MATCHER`. Passed only when the session's
   * allow rules name an MCP tool it may answer (`planToolApprovalRules`).
   */
  planToolApprovalCommand?: string;
  /**
   * The background shell hint hook's command (`buildBackgroundShellHintCommand`
   * with `CLAUDE_BACKGROUND_SHELL_HINT_SPEC`), registered on PostToolUse with
   * the matcher `Bash|PowerShell`. Passed only for a session whose MCP URL names
   * it as the caller, since the hint points at a tool only such a session has.
   */
  backgroundShellHintCommand?: string;
  /**
   * Builds each event hook's command in place of `node <event-bridge>`: for a
   * Claude installed in a WSL distro, the transport's `wslHookEventCommand`,
   * with the same event types and directives. Absent: the node bridge, as before.
   */
  eventCommand?: (eventType: string, ...directives: string[]) => string;
}

/**
 * The shell Claude Code runs every hook and the status line in on Windows: Git
 * Bash when it finds Git Bash, PowerShell when it does not. Measured on 2.1.303
 * (`bash.exe -c "<command>"`), and stated in its hooks and status line docs.
 * One quoting serves both.
 */
export const CLAUDE_BRIDGE_SHELL: HookShell = 'sh-or-powershell';

/** Claude's plan exit tool, the only non-MCP prompt the plan approval hook answers. */
const CLAUDE_PLAN_EXIT_TOOL = 'ExitPlanMode';

/**
 * Claude's pick-an-option question tool. Its PermissionRequest is the one
 * wait that is a question rather than an approval.
 */
export const CLAUDE_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Claude's plan approval reply (code.claude.com/docs/en/hooks, PermissionRequest):
 * allow, with the tool input echoed EXACTLY (since 2.1.300 a changed input
 * denies the call), and `setMode` so the session continues in the destination
 * column's mode. A hook approval otherwise restores the mode the session had
 * before plan mode, and a session launched in plan mode has none. Probed on
 * 2.1.302: acceptEdits and auto apply; bypassPermissions applies only to a
 * session launched with bypass available.
 */
export const CLAUDE_PLAN_APPROVAL_SPEC: PlanApprovalHookSpec = {
  toolField: 'tool_name',
  tool: CLAUDE_PLAN_EXIT_TOOL,
  inputField: 'tool_input',
  reply: {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: PLAN_APPROVAL_TOOL_INPUT,
        updatedPermissions: [{ type: 'setMode', mode: PLAN_APPROVAL_MODE, destination: 'session' }],
      },
    },
  },
};

/** Claude's tools that take `run_in_background`, and the hint hook's matcher for them. */
const CLAUDE_BACKGROUND_SHELL_TOOLS = ['Bash', 'PowerShell'];

/**
 * Claude's background shell hint (task #857). Claude adds a PostToolUse hook's
 * `hookSpecificOutput.additionalContext` to the model's context beside the tool
 * result. Probed on Claude Code headless, 2026-10-20: it reached the model for
 * a Bash and a PowerShell `run_in_background` launch, and both results carried
 * the id as `tool_response.backgroundTaskId`. `shellId` and `shell_id` follow
 * the PostToolUse remap's own candidate list. Claude runs one event's hooks in
 * parallel, so this costs a tool call no wall time.
 */
export const CLAUDE_BACKGROUND_SHELL_HINT_SPEC: BackgroundShellHintSpec = {
  toolField: 'tool_name',
  tools: CLAUDE_BACKGROUND_SHELL_TOOLS,
  inputField: 'tool_input',
  commandField: 'command',
  responseField: 'tool_response',
  idFields: ['backgroundTaskId', 'shellId', 'shell_id'],
  optOutFlag: NO_ACTIVITY_HOLD_FLAG,
  reply: {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: BACKGROUND_SHELL_HINT_TEXT,
    },
  },
};

export function buildHooks(
  eventBridge: string,
  eventsPath: string,
  existingHooks: Record<string, ClaudeHookEntry[]>,
  options: BuildHooksOptions = {},
): Record<string, ClaudeHookEntry[]> {
  const H = ClaudeHookEvent;
  const E = EventType;
  const bridge = options.eventCommand
    ?? ((eventType: string, ...directives: string[]): string =>
      buildBridgeCommand(CLAUDE_BRIDGE_SHELL, eventBridge, eventsPath, eventType, ...directives));
  // The session's mode at each prompt and turn end, so a turn-end automation
  // can tell a turn that began after the plan was left (SessionEvent.planMode).
  // Never a subagent's: a subagent can run in its own mode while the session
  // plans. Its tool hooks are left out, and its Stop, which arrives through the
  // same Stop hook, carries `agent_id` where the main agent's does not.
  const planMode = extractPlanMode('permission_mode', ['plan'], { unlessField: 'agent_id' });
  const promptCommand = options.capturePromptText
    ? bridge(E.Prompt, extractDetail(['prompt']), planMode)
    : bridge(E.Prompt, planMode);

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
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.ToolStart,
        extractTool('tool_name'),
        // Capture Claude's tool_use_id for correlation with the matching
        // PostToolUse. Lets the engine match concurrent ToolEnds to the
        // exact ToolStart instead of falling back to LIFO-by-name.
        // Top-level extraction first (canonical Claude shape), nested
        // fallback for hook payload variations across CLI versions.
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_input' }),
        // The agent that ran the tool. Every tool hook carries `agent_id` when
        // the tool ran in an agent context of its own, and none for the main
        // agent's. An Agent-tool subagent fired a SubagentStart under the same
        // id first. An internal CLI agent fires none, and the ones that run
        // after a Stop can start a tool whose end never comes. The engine logs
        // a tool event from an id that never started and acts on nothing in it
        // (`isInternalAgentEvent`).
        extractSubagentId(['agent_id']),
        // Detail extraction priority: shell_id first (KillBash + future
        // shell-aware events) so the engine can use Set-based id
        // tracking. Falls back to the command/path/etc when shell_id
        // is absent, preserving anonymous bg shell behavior.
        extractDetail(['shell_id', 'file_path', 'command', 'query', 'pattern', 'url', 'description'], { nested: 'tool_input' }),
        // Tool-scoped remap via the typed builder, gated on `whenTool: 'Bash'`.
        // The PowerShell tool takes run_in_background too, and is left out on
        // purpose: its launch stays a pending `tool_start`, which is what lets
        // the process-tree watcher adopt the shell's pid from its foreground
        // memo, and its PostToolUse still promotes it to a named shell. The
        // engine reads the no-activity-hold flag on either event (task #857).
        setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }),
        setTypeWhen({ field: 'tool_name', equals: 'KillBash', to: EventType.BackgroundShellEnd }),
        // The calls that start a subagent: `Agent`, and `Task` on older CLIs.
        // Only such a call's own approval may let a `subagent_start` close the
        // permission prompt it awaited (`updatePermissionFlag`).
        markSubagentLaunch(CLAUDE_SUBAGENT_LAUNCH_TOOLS)) }] },
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
      // `background-shell-hint-bridge.js` holds a third copy, which
      // `background-shell-hint-bridge.test.ts` pins against looksLikeShellId.
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
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.ToolEnd,
        extractTool('tool_name'),
        // Same correlation id extraction as PreToolUse so the engine
        // can match this end to its start. Claude carries tool_use_id
        // at the top level on PostToolUse; tool_response also has a
        // copy in some shapes - capture both via fallthrough.
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_response' }),
        // Same agent id as PreToolUse, so an internal agent's tool end cannot
        // drain a main-agent tool of the same name by the LIFO fallback.
        extractSubagentId(['agent_id']),
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
      // The background shell hint (task #857): beside a background launch's
      // result, tell the agent the shell keeps its task working and how to
      // mark it as a service. A separate script because the event bridge
      // silences stdout for every agent.
      ...(options.backgroundShellHintCommand
        ? [{ matcher: CLAUDE_BACKGROUND_SHELL_TOOLS.join('|'), hooks: [{ type: 'command', command: options.backgroundShellHintCommand }] }]
        : []),
    ],
    [H.PostToolUseFailure]: [
      ...(existingHooks[H.PostToolUseFailure] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.ToolEnd,
        extractTool('tool_name'),
        extractToolId(['tool_use_id']),
        extractToolId(['tool_use_id'], { nested: 'tool_input' }),
        // An internal agent's interrupted tool must not end the main turn.
        extractSubagentId(['agent_id']),
        setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted }),
        extractDetail(['error'])) }] },
    ],
    [H.UserPromptSubmit]: [
      ...(existingHooks[H.UserPromptSubmit] || []),
      { matcher: '', hooks: [{ type: 'command', command: promptCommand }] },
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
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.Idle, planMode) }] },
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
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.TurnFailed,
        extractDetail(['error', 'error_details']),
        setTypeWhenDetailContains('overloaded', E.TurnRetrying),
        setTypeWhenDetailContains('server_error', E.TurnRetrying),
        setTypeWhenDetailContains('rate_limit', E.TurnRetrying),
        setTypeWhenDetailContains('api_error', E.TurnRetrying)) }] },
    ],
    [H.PermissionRequest]: [
      ...(existingHooks[H.PermissionRequest] || []),
      // The tool name rides along so the plan approval gate can tell the plan
      // prompt's idle from every other one (plan-approval-gate.ts). The wait's
      // kind: AskUserQuestion is a question; a tool, a plan (ExitPlanMode) and
      // anything else Claude asks to run is an approval.
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.Idle,
        setDetail('permission'),
        extractTool('tool_name'),
        setWaitKind('approval'),
        setWaitKindWhen({ path: ['tool_name'], equals: CLAUDE_QUESTION_TOOL, to: 'question' })) }] },
      ...(options.planApprovalCommand
        ? [{ matcher: CLAUDE_PLAN_EXIT_TOOL, hooks: [{ type: 'command', command: options.planApprovalCommand }] }]
        : []),
      ...(options.planToolApprovalCommand
        ? [{ matcher: CLAUDE_PLAN_TOOL_APPROVAL_MATCHER, hooks: [{ type: 'command', command: options.planToolApprovalCommand }] }]
        : []),
    ],
    [H.SessionStart]: [
      ...(existingHooks[H.SessionStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.SessionStart) }] },
    ],
    [H.SessionEnd]: [
      ...(existingHooks[H.SessionEnd] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.SessionEnd) }] },
    ],
    // Both subagent hooks carry `agent_id` (captured on CLI 2.1.290), as the
    // tool hooks above do for a tool a subagent runs (captured on 2.1.303,
    // `tests/fixtures/claude-tool-hook-agent-id.jsonl`). The engine needs it
    // because one agent can fire two NAMED stops: a background
    // subagent that ends its turn without calling SubagentHandback stops, gets
    // re-prompted by the CLI's `[handback-send-enforce]` message, and stops
    // again after the handback. Counting both took a live sibling's depth slot
    // (task #759). A SendMessage continuation also stops twice under one id,
    // but fires a fresh SubagentStart with that id first, which re-opens it.
    [H.SubagentStart]: [
      ...(existingHooks[H.SubagentStart] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.SubagentStart,
        extractDetail(['agent_type', 'subagent_type']),
        extractSubagentId(['agent_id'])) }] },
    ],
    [H.SubagentStop]: [
      ...(existingHooks[H.SubagentStop] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.SubagentStop,
        extractDetail(['agent_type', 'subagent_type']),
        extractSubagentId(['agent_id'])) }] },
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
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.Notification,
        extractDetail(['message', 'notification']),
        setTypeWhenDetailContains('waiting for your input', E.IdleHint)) }] },
    ],
    [H.PreCompact]: [
      ...(existingHooks[H.PreCompact] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.Compact) }] },
    ],
    [H.TeammateIdle]: [
      ...(existingHooks[H.TeammateIdle] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.TeammateIdle,
        extractDetail(['agent', 'teammate', 'name'])) }] },
    ],
    [H.TaskCompleted]: [
      ...(existingHooks[H.TaskCompleted] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.TaskCompleted,
        extractDetail(['task', 'description', 'name'])) }] },
    ],
    [H.ConfigChange]: [
      ...(existingHooks[H.ConfigChange] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.ConfigChange) }] },
    ],
    [H.WorktreeCreate]: [
      ...(existingHooks[H.WorktreeCreate] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.WorktreeCreate,
        extractDetail(['name', 'path'])) }] },
    ],
    [H.WorktreeRemove]: [
      ...(existingHooks[H.WorktreeRemove] || []),
      { matcher: '', hooks: [{ type: 'command', command: bridge(E.WorktreeRemove,
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
