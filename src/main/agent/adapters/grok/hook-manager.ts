import fs from 'node:fs';
import path from 'node:path';
import { EventType, IdleReason } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';
import {
  buildBridgeCommand,
  EVENTS_PATH_ENVIRONMENT_VARIABLE,
  EVENTS_PATH_FROM_ENVIRONMENT,
  type HookShell,
} from '../../shared/hook-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import {
  appendPermissionWaitForTool,
  emitOnlyWhenDetailMatches,
  extractDetail,
  extractPlanMode,
  extractTool,
  extractToolId,
  setDetail,
  setTypeWhen,
  setTypeWhenDetailContains,
  setTypeWhenDetailMatches,
  setWaitKind,
} from '../../shared/directive-builders';
import { backgroundLaunchDirective, backgroundStopDirectives } from '../../shared/background-command-hooks';
import type { CliPlace } from '../../shared/cli-target';
import { copyWslHookScriptInto, prepareWslHookTransport, wslHookEventCommand } from '../../shared/wsl-hook-transport';
import type { BackgroundCommandSpec } from '../../../../shared/background-command-spec';

/** The workspace copy of the WSL hook transport's script a Grok in a WSL distro runs its hooks with. */
export const GROK_WSL_HOOK_COPY_NAME = 'grok-wsl-hook.sh';

/**
 * Grok's background commands (task #859), from a headless 1.0.0 run against a
 * local stand-in for the model API (tests/fixtures/grok-hooks/grok-1.0.0-*).
 * `run_terminal_command` with `background: true`, or a foreground command past
 * its timeout, answers `toolResult: { type: "BackgroundTaskStarted", task_id }`
 * (the top-level `isBackgrounded` stayed false for both, so it decides
 * nothing). `kill_command_or_subagent` takes `toolInput.task_id` and answers
 * `{ type: "KillTask" }`; it also stops subagents, whose ids are then an
 * unmatched end the engine counts and ignores. Grok's PostToolUse is passive:
 * a `hookSpecificOutput.additionalContext` never reached the model, so there is
 * no hint. The command runs under `pwsh.exe` inside Grok's tree.
 */
export const GROK_BACKGROUND_COMMAND_SPEC: BackgroundCommandSpec = {
  launch: {
    toolField: 'toolName',
    tools: ['run_terminal_command'],
    when: [{ path: ['toolResult', 'type'], equals: 'BackgroundTaskStarted' }],
    unless: [],
    idSources: [{ path: ['toolResult', 'task_id'] }],
    commandPath: ['toolInput', 'command'],
  },
  stop: {
    toolField: 'toolName',
    tools: ['kill_command_or_subagent'],
    when: [{ path: ['toolResult', 'type'], equals: 'KillTask' }],
    unless: [],
    idSources: [{ path: ['toolInput', 'task_id'] }],
  },
};

/**
 * Grok Build hook wiring.
 *
 * Grok's hook system is deliberately Claude Code-compatible (same event
 * names, same `{"hooks": {Event: [{matcher, hooks: [{type, command}]}]}}`
 * JSON shape, verified against the user guide shipped with grok 1.0.0,
 * 10-hooks.md), and it merges EVERY `*.json` file found in
 * `<project>/.grok/hooks/`. That last property is what makes this manager
 * far simpler than Claude's: Kangentic writes its own wholly-owned file,
 * `<cwd>/.grok/hooks/kangentic.json`, and never reads, merges, or sweeps
 * the user's hook files at all. Removal is deleting our file.
 *
 * PER-SESSION EVENTS ROUTING (the `env:` sentinel). Grok has no per-session
 * settings flag (`--settings` equivalent), so the hook file is per-cwd and
 * must serve every session spawned there. Instead of baking one session's
 * `events.jsonl` path into the command (last-writer-wins corruption for
 * concurrent same-cwd sessions, and the user's own manual `grok` runs in
 * that cwd would write into a task's activity log), the command names the
 * events path indirectly: `env:KANGENTIC_EVENTS_PATH`. Hook processes
 * inherit the grok process environment, and each Kangentic PTY spawn
 * carries its own value via `buildEnv` - so one static file routes every
 * session's events to that session's own log, and a session with no such
 * env var (the user's own grok) makes the bridge exit as a silent no-op.
 * See `event-bridge.js` for the sentinel resolution.
 *
 * TRUST: project-level hooks are gated by grok's folder-trust store
 * (`~/.grok/trusted_folders.toml`), and trust CASCADES to subdirectories -
 * verified live: a Kangentic worktree under a trusted project root reports
 * `projectTrusted: true` in `grok inspect` with only the root in the store.
 * An untrusted folder silently skips project hooks (fail-open), which the
 * adapter's `hooksAndPty` activity strategy absorbs: the PTY silence timer
 * carries activity until the user trusts the project once. See
 * `trust-manager.ts` for the worktree pre-approval that keeps per-task
 * worktrees from ever prompting.
 *
 * EVENT MAPPING NOTES (grok 1.0.0, shipped user guide):
 * - Payloads are camelCase (`toolName`, `toolUseId`, `errorDetails`) where
 *   Claude uses snake_case - the extraction directives below name grok's
 *   fields.
 * - `Stop` fires ONLY for the main agent and only on genuine completions
 *   (interrupts skip it; API errors fire `StopFailure` instead), and a
 *   subagent's turn end fires `SubagentStop` inside the subagent. This is
 *   Claude's subagent-depth problem solved natively - no depth gating
 *   needed.
 * - An extra observe-only `Stop` fires at session end with
 *   `reason: "channel_closed" | "shutdown"`; an Idle event then is
 *   harmless (the session is terminating), so it is not filtered. The
 *   reason is carried in `detail` for the activity log.
 * - `StopFailure.error` uses Claude's vocabulary (`rate_limit`,
 *   `server_error`, `authentication_failed`, `invalid_request`,
 *   `max_output_tokens`, `unknown`; 503/529 capacity errors fold into
 *   `rate_limit`). The transient classes remap to `turn_retrying` so the
 *   engine holds the session thinking through a retry backoff instead of
 *   false-idling it - mirroring Claude's StopFailure remaps.
 * - Directives whose tool guard reads `ctx.tool_name` (Claude's field:
 *   `setTypeWhen`'s `whenTool`, `markSubagentLaunch`, `extractDetailWhenTool`)
 *   are never used here, because the 1.0.0 captures carry only `toolName`.
 *   Every tool-scoped directive below names its field or path explicitly
 *   (`appendPermissionWaitForTool`'s `toolPath`).
 *
 * BUILT FROM DOCUMENTATION, NOT YET RUN AGAINST THE CLI. The installed 1.0.0
 * is too old for xAI's API (it answers 426, "update to 1.0.13 or later"), so
 * the entries below were built from Grok's own docs, not from a capture:
 * - `StopCancelled` -> `interrupted`. "Runs instead of `Stop` when a turn ends
 *   without completing": a user interrupt, a declined permission prompt, the
 *   `--max-turns` limit, or a no-progress bail-out. Added in 1.0.4 (CHANGELOG),
 *   documented in 10-hooks.md on main (1.0.45, 2026-09-29):
 *   https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md
 *   An older CLI ignores the key: "Grok skips unrecognized event names"
 *   (10-hooks.md shipped with 1.0.0). Inside a subagent the payload carries
 *   `subagentType`, and that cancel is logged, never the session's interrupt.
 * - `Notification` with `notificationType: "permission_prompt"` is an approval
 *   wait ("fires only when a permission UI is actually waiting"), and
 *   `idle_prompt` an idle hint ("fires on any turn end", about a minute after
 *   the session settles). Same 10-hooks.md on main; the doc says to match on
 *   `notificationType`, because `message` is display text that can change.
 * - `ask_user_question` and `exit_plan_mode` raise their waits from
 *   PreToolUse, as Codex's question tool does: the tool's start is the wait
 *   and its own PostToolUse the answer. Both tools are named in 19-plan-mode.md
 *   shipped with 1.0.0 (the agent "may use `ask_user_question`", and
 *   `exit_plan_mode` opens the plan approval view).
 * - Plan mode rides `permissionMode`, which every payload carries with the
 *   values `default`, `auto`, `plan` or `bypassPermissions` (10-hooks.md,
 *   1.0.0). A subagent's payload carries `subagentType` and is skipped.
 */

/** The variable `EVENTS_PATH_FROM_ENVIRONMENT` names, which the command builder sets. */
export const KANGENTIC_EVENTS_PATH_ENV = EVENTS_PATH_ENVIRONMENT_VARIABLE;

/**
 * The shell grok runs hooks in on Windows: PowerShell, as
 * `pwsh -NoProfile -NonInteractive -Command "<command>"` (measured on 1.0.0).
 * Like Gemini, grok replaces `$NAME` and `${NAME}` in the command with the
 * environment's values before the shell runs it.
 */
const GROK_HOOK_SHELL: HookShell = 'sh-or-powershell';

/** Grok hook event names (Claude-compatible, verified in 10-hooks.md). */
const GrokHookEvent = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  StopCancelled: 'StopCancelled',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionDenied: 'PermissionDenied',
  Notification: 'Notification',
  PreCompact: 'PreCompact',
} as const;

/**
 * Grok's question tool. Its start is a wait on the user, answered by its own
 * PostToolUse (19-plan-mode.md shipped with 1.0.0; not yet captured).
 */
const GROK_QUESTION_TOOL = 'ask_user_question';

/**
 * Grok's plan exit tool: it reads `plan.md` and opens the plan approval view
 * (19-plan-mode.md shipped with 1.0.0). Its start is an approval wait. It is
 * NOT reported as Kangentic's plan exit: what its result says for an approved,
 * a revised and a quit plan is undocumented, and quitting also ends plan mode.
 */
const GROK_PLAN_EXIT_TOOL = 'exit_plan_mode';

/** A detail pattern that matches any non-empty extracted value. */
const ANY_DETAIL = '.';

/** The `notificationType` Grok sends while a permission UI waits (10-hooks.md on main, 1.0.45). */
const GROK_PERMISSION_NOTIFICATION = 'permission_prompt';

/** The `notificationType` Grok sends once a session has settled after a turn (10-hooks.md on main, 1.0.45). */
const GROK_IDLE_NOTIFICATION = 'idle_prompt';

interface GrokHookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

function commandEntry(command: string): GrokHookEntry {
  return { hooks: [{ type: 'command', command }] };
}

/**
 * Build the full Kangentic hook object for grok. Exported for tests; the
 * production entry point is `writeHooksFile`. `eventCommand`, for a Grok
 * installed in a WSL distro, builds each command in place of the node bridge
 * with the same event types and directives.
 */
export function buildGrokHooks(
  eventBridge: string,
  eventCommand?: (eventType: string, ...directives: string[]) => string,
): Record<string, GrokHookEntry[]> {
  const H = GrokHookEvent;
  const E = EventType;
  const bridge = (eventType: string, ...directives: string[]): string => (eventCommand
    ? eventCommand(eventType, ...directives)
    : buildBridgeCommand(GROK_HOOK_SHELL, eventBridge, EVENTS_PATH_FROM_ENVIRONMENT, eventType, ...directives));
  // The session's mode at each prompt and turn end (SessionEvent.planMode),
  // never a subagent's, whose payload carries `subagentType`.
  const planMode = extractPlanMode('permissionMode', ['plan'], { unlessField: 'subagentType' });

  return {
    [H.PreToolUse]: [commandEntry(bridge(E.ToolStart,
      extractTool('toolName'),
      extractToolId(['toolUseId']),
      // Tool-specific context: grok's `toolInput` carries the tool's raw
      // input (observed: `command` for run_terminal_command, `target_file`
      // for read_file). First non-null wins.
      extractDetail(['command', 'target_file', 'file_path', 'path', 'query', 'pattern', 'url', 'description'], { nested: 'toolInput' }),
      // Written after the tool_start, in this one process, so the start cannot
      // clear the wait it opens.
      appendPermissionWaitForTool({ toolPath: ['toolName'], tool: GROK_QUESTION_TOOL, waitKind: 'question' }),
      appendPermissionWaitForTool({ toolPath: ['toolName'], tool: GROK_PLAN_EXIT_TOOL, waitKind: 'approval' })))],
    // A background launch and kill ride this entry: grok runs one event's
    // hooks one after another, so a second entry would cost every tool call.
    [H.PostToolUse]: [commandEntry(bridge(E.ToolEnd,
      extractTool('toolName'),
      extractToolId(['toolUseId']),
      backgroundLaunchDirective(GROK_BACKGROUND_COMMAND_SPEC),
      ...backgroundStopDirectives(GROK_BACKGROUND_COMMAND_SPEC)))],
    [H.PostToolUseFailure]: [commandEntry(bridge(E.ToolEnd,
      extractTool('toolName'),
      extractToolId(['toolUseId']),
      extractDetail(['error', 'errorDetails'])))],
    [H.UserPromptSubmit]: [commandEntry(bridge(E.Prompt, planMode))],
    [H.Stop]: [commandEntry(bridge(E.Idle,
      // `end_turn` for genuine completions; `channel_closed` / `shutdown`
      // for the session-end observe fire. Carried for the activity log.
      extractDetail(['reason']),
      planMode))],
    [H.StopFailure]: [commandEntry(bridge(E.TurnFailed,
      extractDetail(['error', 'errorDetails']),
      setTypeWhenDetailContains('rate_limit', E.TurnRetrying),
      setTypeWhenDetailContains('server_error', E.TurnRetrying)))],
    // A turn that ended without completing (an interrupt, a declined prompt,
    // max turns): a hard turn end. A subagent's own cancel carries
    // `subagentType`; it is retyped to a log line, so it cannot end the main
    // turn. `extractDetail` is first-wins, so the reason fills only a
    // main-agent event's detail. The order is load-bearing: the
    // `subagentType` extraction must come first for the retype to see it.
    [H.StopCancelled]: [commandEntry(bridge(E.Interrupted,
      extractDetail(['subagentType']),
      setTypeWhenDetailMatches(ANY_DETAIL, E.Notification),
      extractDetail(['reason', 'cancelTrigger'])))],
    [H.SessionStart]: [commandEntry(bridge(E.SessionStart))],
    [H.SessionEnd]: [commandEntry(bridge(E.SessionEnd))],
    [H.SubagentStart]: [commandEntry(bridge(E.SubagentStart,
      extractDetail(['subagentType', 'agentType'])))],
    [H.SubagentStop]: [commandEntry(bridge(E.SubagentStop,
      extractDetail(['subagentType', 'agentType'])))],
    // Observation-only: a denied tool call is logged for the activity feed.
    [H.PermissionDenied]: [commandEntry(bridge(E.Notification,
      extractDetail(['toolName', 'message'])))],
    // Grok runs one event's entries one after another, so the entry that
    // changes state runs first: a quick approval's tool end must not land
    // before the wait it ends.
    [H.Notification]: [
      // A permission UI on screen is an approval wait. The event is written
      // only for that type; the tool's own end clears it.
      commandEntry(bridge(E.Idle,
        extractDetail(['notificationType']),
        emitOnlyWhenDetailMatches(`^${GROK_PERMISSION_NOTIFICATION}$`),
        setDetail(IdleReason.Permission),
        setWaitKind('approval'))),
      // Every notification is logged; `idle_prompt` is also an idle hint, so
      // a turn whose Stop never arrived still settles. The engine ends a turn
      // on it only when no tool, subagent, shell or wait still holds one.
      commandEntry(bridge(E.Notification,
        extractDetail(['message', 'notification', 'text']),
        setTypeWhen({ field: 'notificationType', equals: GROK_IDLE_NOTIFICATION, to: E.IdleHint }))),
    ],
    [H.PreCompact]: [commandEntry(bridge(E.Compact))],
  };
}

function hooksFilePath(directory: string): string {
  return path.join(directory, '.grok', 'hooks', 'kangentic.json');
}

/**
 * Write (or refresh) `<cwd>/.grok/hooks/kangentic.json`. Idempotent: the
 * content is static per install (the only machine-varying piece is the
 * bridge script's absolute path), so rewriting on every spawn also
 * self-heals a stale path after an app update. Best-effort: a failure only
 * costs hook-based activity, which `hooksAndPty` degrades around.
 *
 * Grok loads project hooks from the PROJECT ROOT it discovers by walking
 * up from the session cwd to the first `.git` (probe-verified: hooks in a
 * non-git directory never load). Every Kangentic spawn cwd is a git root
 * (the project itself, or a worktree, which is its own git root), so
 * writing at `cwd` IS writing at the discovered root.
 *
 * A Grok installed in a WSL distro (`wsl`) may have no node, so its hooks
 * call the folder's copy of the WSL hook transport's script with the same
 * events and directives: the file is per folder, and the copy finds each
 * session's own folder through `KANGENTIC_WSL_HOOK_DIR`, which grok's hooks
 * inherit as they inherit `KANGENTIC_EVENTS_PATH`. Grok passes a hook its
 * payload on stdin, which the script's `event` mode reads.
 */
export function writeHooksFile(directory: string, wsl: { place: CliPlace; sessionDirectory: string } | null = null): void {
  const filePath = hooksFilePath(directory);
  try {
    const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
    let eventCommand: ((eventType: string, ...directives: string[]) => string) | undefined;
    if (wsl) {
      const sessionHooks = prepareWslHookTransport(wsl.sessionDirectory);
      const folderHooks = { ...sessionHooks, script: copyWslHookScriptInto(directory, GROK_WSL_HOOK_COPY_NAME) };
      eventCommand = (eventType, ...directives) => wslHookEventCommand(folderHooks, wsl.place, eventType, ...directives);
    }
    const content = { hooks: buildGrokHooks(eventBridge, eventCommand) };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
  } catch (error) {
    console.error(`[grok] Failed to write hooks file: ${filePath}`, error);
  }
}

/**
 * Delete Kangentic's hook file and prune the `.grok/hooks` / `.grok`
 * directories when they end up empty (so a repo the user never configured
 * grok in is left exactly as found). User hook files are never touched -
 * Kangentic only ever owns `kangentic.json`.
 */
export function removeHooksFile(directory: string): void {
  const filePath = hooksFilePath(directory);
  try {
    fs.rmSync(filePath, { force: true });
    const hooksDir = path.dirname(filePath);
    try { fs.rmdirSync(hooksDir); } catch { /* not empty or already gone */ }
    try { fs.rmdirSync(path.dirname(hooksDir)); } catch { /* not empty or already gone */ }
  } catch (error) {
    console.error(`[grok] Failed to remove hooks file: ${filePath}`, error);
  }
}
