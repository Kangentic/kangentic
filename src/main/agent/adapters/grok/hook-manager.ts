import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';
import { buildBridgeCommand } from '../../shared/hook-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { extractTool, extractToolId, extractDetail } from '../../shared/directive-builders';
import { setTypeWhenDetailContains } from '../../shared/directive-builders';

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
 * - Tool-scoped directives (`whenTool`, `setTypeWhen`) are deliberately
 *   absent: the bridge's tool guard reads `ctx.tool_name` (Claude's field),
 *   which grok payloads do not carry.
 */

/** The events-path sentinel the bridge resolves from the hook process env. */
export const KANGENTIC_EVENTS_PATH_ENV = 'KANGENTIC_EVENTS_PATH';
const EVENTS_PATH_SENTINEL = `env:${KANGENTIC_EVENTS_PATH_ENV}`;

/** Grok hook event names (Claude-compatible, verified in 10-hooks.md). */
const GrokHookEvent = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionDenied: 'PermissionDenied',
  Notification: 'Notification',
  PreCompact: 'PreCompact',
} as const;

interface GrokHookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

function commandEntry(command: string): GrokHookEntry {
  return { hooks: [{ type: 'command', command }] };
}

/**
 * Build the full Kangentic hook object for grok. Exported for tests; the
 * production entry point is `writeHooksFile`.
 */
export function buildGrokHooks(eventBridge: string): Record<string, GrokHookEntry[]> {
  const H = GrokHookEvent;
  const E = EventType;
  const bridge = (eventType: string, ...directives: string[]): string =>
    buildBridgeCommand(eventBridge, EVENTS_PATH_SENTINEL, eventType, ...directives);

  return {
    [H.PreToolUse]: [commandEntry(bridge(E.ToolStart,
      extractTool('toolName'),
      extractToolId(['toolUseId']),
      // Tool-specific context: grok's `toolInput` carries the tool's raw
      // input (observed: `command` for run_terminal_command, `target_file`
      // for read_file). First non-null wins.
      extractDetail(['command', 'target_file', 'file_path', 'path', 'query', 'pattern', 'url', 'description'], { nested: 'toolInput' })))],
    [H.PostToolUse]: [commandEntry(bridge(E.ToolEnd,
      extractTool('toolName'),
      extractToolId(['toolUseId'])))],
    [H.PostToolUseFailure]: [commandEntry(bridge(E.ToolEnd,
      extractTool('toolName'),
      extractToolId(['toolUseId']),
      extractDetail(['error', 'errorDetails'])))],
    [H.UserPromptSubmit]: [commandEntry(bridge(E.Prompt))],
    [H.Stop]: [commandEntry(bridge(E.Idle,
      // `end_turn` for genuine completions; `channel_closed` / `shutdown`
      // for the session-end observe fire. Carried for the activity log.
      extractDetail(['reason'])))],
    [H.StopFailure]: [commandEntry(bridge(E.TurnFailed,
      extractDetail(['error', 'errorDetails']),
      setTypeWhenDetailContains('rate_limit', E.TurnRetrying),
      setTypeWhenDetailContains('server_error', E.TurnRetrying)))],
    [H.SessionStart]: [commandEntry(bridge(E.SessionStart))],
    [H.SessionEnd]: [commandEntry(bridge(E.SessionEnd))],
    [H.SubagentStart]: [commandEntry(bridge(E.SubagentStart,
      extractDetail(['subagentType', 'agentType'])))],
    [H.SubagentStop]: [commandEntry(bridge(E.SubagentStop,
      extractDetail(['subagentType', 'agentType'])))],
    // Observation-only: a denied tool call and agent notifications are
    // logged for the activity feed; neither changes activity state.
    [H.PermissionDenied]: [commandEntry(bridge(E.Notification,
      extractDetail(['toolName', 'message'])))],
    [H.Notification]: [commandEntry(bridge(E.Notification,
      extractDetail(['message', 'notification', 'text'])))],
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
 */
export function writeHooksFile(directory: string): void {
  const filePath = hooksFilePath(directory);
  try {
    const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
    const content = { hooks: buildGrokHooks(eventBridge) };
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
