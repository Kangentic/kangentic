import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import { EventType } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';import { isKangenticHookCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';
import { copyEventBridgeInto } from '../../shared/workspace-bridge-copy';
import {
  appendPermissionWaitForTool,
  captureHookContext,
  extractDetailPath,
  extractToolPath,
  replyJson,
} from '../../shared/directive-builders';

/** A single hook handler in Antigravity's hooks.json. */
export interface AntigravityHookHandler {
  type: string;
  command: string;
  timeout?: number;
}

/** Grouped entry (PreToolUse / PostToolUse): a matcher wrapping handlers. */
export interface AntigravityHookGroup {
  matcher: string;
  hooks: AntigravityHookHandler[];
}

/**
 * One NAMED hook in Antigravity's hooks.json. The file's top level maps hook
 * names to this shape; tool events are grouped (matcher + hooks), the
 * session/invocation/stop events are flat handler lists. The six events are
 * the hooks reference's (https://antigravity.google/docs/hooks).
 */
export interface AntigravityNamedHook {
  enabled?: boolean;
  SessionStart?: AntigravityHookHandler[];
  PreToolUse?: AntigravityHookGroup[];
  PostToolUse?: AntigravityHookGroup[];
  PreInvocation?: AntigravityHookHandler[];
  PostInvocation?: AntigravityHookHandler[];
  Stop?: AntigravityHookHandler[];
}

export type AntigravityHooksFile = Record<string, AntigravityNamedHook>;

/** The single named hook Kangentic owns in a workspace's hooks.json. */
export const KANGENTIC_HOOK_NAME = 'kangentic-events';

/**
 * agy's question tool, the one whose start is also a wait (#452). Its dialog
 * always waits on the user, unlike a tool whose approval agy's own policy may
 * skip, so its start is the wait. Measured on agy 1.3.4 with a probe hook that
 * answered `allow`: the PreToolUse carried `toolCall.name: "ask_question"` and
 * the question in `toolCall.args.questions`, the dialog still showed, and the
 * answer fired the tool's PostToolUse and then a PreInvocation.
 */
export const AGY_QUESTION_TOOL = 'ask_question';

/**
 * Filename of the event-bridge copy the command builder drops into the
 * workspace's `.kangentic/` dir. `.cjs` is load-bearing: the copy lives under
 * the USER'S project tree, so a `"type": "module"` in their package.json
 * would otherwise make `node <copy>.js` parse the CommonJS bridge as ESM.
 */
export const AGY_BRIDGE_COPY_NAME = 'agy-event-bridge.cjs';

/**
 * Turn an absolute path into a token agy's hook runner can consume, or null
 * when none exists. Hooks run with cwd = the directory containing hooks.json
 * (`<cwd>/.agents`), verified against agy 1.1.13. That cwd anchor is what
 * makes RELATIVE paths work here, and relative paths are REQUIRED, not a
 * nicety: agy tokenizes the hook command on whitespace with quote characters
 * kept LITERAL (a quoted path reached node as `"C:\...\x.js"` including both
 * quotes, resolved relative to `.agents`, and failed module lookup - observed
 * in the E1 rig). So no token may contain a space and no token may be quoted.
 * Every path we emit is relative to `.agents/` and traverses only
 * Kangentic-owned, space-free segments (`.kangentic`, session UUIDs, the
 * bridge copy name); the user's absolute project path, which CAN contain
 * spaces, never appears in the relative form. A cross-drive target on
 * Windows cannot relativize at all; a space-free ABSOLUTE path still
 * tokenizes correctly, so it is the fallback before giving up.
 */
export function spaceFreeAgentsToken(cwd: string, absoluteTarget: string): string | null {
  const agentsDir = path.join(cwd, '.agents');
  const relative = path.relative(agentsDir, absoluteTarget);
  if (!path.isAbsolute(relative) && !relative.includes(' ')) {
    return toForwardSlash(relative);
  }
  const absolute = toForwardSlash(absoluteTarget);
  return absolute.includes(' ') ? null : absolute;
}

/**
 * The event hook command for an agy installed in a WSL distro, which may have
 * no node: `sh <script> event <type> <directives>`, naming the session's copy
 * of the WSL hook transport's script by the same `.agents`-relative,
 * space-free token the bridge gets, since agy splits a command on whitespace
 * and keeps quotes literal. The script finds its folder from its own path.
 * agy passes the payload on stdin, which the script's `event` mode reads.
 * Directives are single tokens already (`directive-builders.ts`).
 */
export function wslAgentsHookCommand(scriptToken: string, eventType: string, ...directives: string[]): string {
  return ['sh', scriptToken, 'event', eventType, ...directives].join(' ');
}

/**
 * Copy the deployed event-bridge script into `<cwd>/.kangentic/` so the hook
 * command can reference it space-free relative to `.agents/`. Checked on every
 * spawn and re-copied when it differs, so an app upgrade can never leave a
 * stale bridge behind (the external-scripts-parity lesson). Returns the
 * `.agents`-relative token, or
 * null when the copy or relativization failed.
 */
export function deployWorkspaceBridgeCopy(cwd: string): string | null {
  try {
    return spaceFreeAgentsToken(cwd, copyEventBridgeInto(cwd, AGY_BRIDGE_COPY_NAME));
  } catch (error) {
    console.error('[antigravity] Failed to deploy workspace event-bridge copy', error);
    return null;
  }
}

/**
 * Drop the individual handlers whose command carries the Kangentic
 * fingerprint, preserving the entry's other handlers. PER-HANDLER
 * granularity is load-bearing: a user's named hook that happens to mix
 * their own handler with a stale/renamed Kangentic command (e.g. a copied
 * bridge invocation) must lose only the Kangentic handler, never the whole
 * entry - entry-level filtering silently destroyed the user's own handlers
 * alongside it. Returns null when nothing user-owned survives (the entry
 * was 100% ours, however it was named).
 */
function stripKangenticHandlers(entry: AntigravityNamedHook): AntigravityNamedHook | null {
  const keepHandler = (handler: AntigravityHookHandler): boolean =>
    !isKangenticHookCommand(handler.command);
  const filterGroups = (groups: AntigravityHookGroup[] | undefined): AntigravityHookGroup[] | undefined => {
    if (!groups) return undefined;
    return groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter(keepHandler) }))
      .filter((group) => group.hooks.length > 0);
  };
  const filterHandlers = (handlers: AntigravityHookHandler[] | undefined): AntigravityHookHandler[] | undefined =>
    handlers ? handlers.filter(keepHandler) : undefined;

  const survivor: AntigravityNamedHook = {
    ...entry,
    SessionStart: filterHandlers(entry.SessionStart),
    PreToolUse: filterGroups(entry.PreToolUse),
    PostToolUse: filterGroups(entry.PostToolUse),
    PreInvocation: filterHandlers(entry.PreInvocation),
    PostInvocation: filterHandlers(entry.PostInvocation),
    Stop: filterHandlers(entry.Stop),
  };

  const survivingHandlerCount =
    (survivor.SessionStart ?? []).length
    + (survivor.PreToolUse ?? []).reduce((count, group) => count + group.hooks.length, 0)
    + (survivor.PostToolUse ?? []).reduce((count, group) => count + group.hooks.length, 0)
    + (survivor.PreInvocation ?? []).length
    + (survivor.PostInvocation ?? []).length
    + (survivor.Stop ?? []).length;
  const originalHandlerCount =
    (entry.SessionStart ?? []).length
    + (entry.PreToolUse ?? []).reduce((count, group) => count + (group.hooks ?? []).length, 0)
    + (entry.PostToolUse ?? []).reduce((count, group) => count + (group.hooks ?? []).length, 0)
    + (entry.PreInvocation ?? []).length
    + (entry.PostInvocation ?? []).length
    + (entry.Stop ?? []).length;

  // A handler-less entry (nothing to fingerprint) is the user's to keep,
  // untouched; an entry whose every handler was ours is dropped whole.
  if (originalHandlerCount === 0) return entry;
  return survivingHandlerCount > 0 ? survivor : null;
}

/**
 * Drop Kangentic-owned hooks, keeping user-defined ones. An entry named with
 * the reserved `kangentic-` prefix is dropped whole; everywhere else the
 * shared command fingerprint (`isKangenticHookCommand`) sweeps
 * renamed-but-ours handlers PER HANDLER, so a mixed user entry keeps its own
 * handlers (see stripKangenticHandlers).
 */
export function filterOurHooks(root: AntigravityHooksFile): AntigravityHooksFile {
  const kept: AntigravityHooksFile = {};
  for (const [name, entry] of Object.entries(root)) {
    if (name.startsWith('kangentic-')) continue;
    const survivor = stripKangenticHandlers(entry);
    if (survivor) kept[name] = survivor;
  }
  return kept;
}

/** The primary-argument keys a tool event's detail is read from, under `toolCall.args`. */
const TOOL_DETAIL_ARGS = ['TargetFile', 'CommandLine', 'DirectoryPath', 'AbsolutePath', 'Query'];

/**
 * Build the merged hooks.json content: user hooks preserved, one fresh
 * Kangentic named hook injected. `bridgeToken` and `eventsToken` are the
 * `.agents`-relative space-free tokens produced by the command builder.
 *
 * Event mapping (agy's six hook events, https://antigravity.google/docs/hooks):
 * - SessionStart -> `session_start`. Fires once when a NEW conversation
 *   starts, before the first model call. The bridge captures a session_start
 *   payload as `hookContext` on its own, so the conversation id is read before
 *   the first turn. A `--conversation` resume gets none, which is why
 *   PreInvocation keeps its capture. The hooks reference lists the event, but
 *   no changelog entry dates it; not yet run against a real agy.
 * - PreInvocation -> `prompt`. The turn-initiating signal (ModelStart is NOT
 *   in TURN_INITIATING_EVENTS), fired before every model call. Also carries
 *   `captureHookContext` so `runtime.sessionId.fromHook` can read
 *   `conversationId` from a resumed conversation's payload.
 * - PreToolUse -> `tool_start` for every tool (matcher `*`), with the same
 *   name and detail directives as PostToolUse. The hooks reference makes
 *   `decision` REQUIRED and agy treats a response without one as a DENY
 *   (observed on 1.1.13: `{}` put the model in a tool-denied retry loop), so
 *   the entry carries `replyJson({ decision: 'allow' })`, which the bridge
 *   writes to stdout before anything else. `allow` "proceed[s], deferring to
 *   the next hook or default policy" (hooks reference), and on 1.3.4 the
 *   question and command dialogs still showed under it. The cost: a handler
 *   that fails before it answers now denies whatever tool it fired for. With
 *   no `node` on PATH every handler fails that way and the agent cannot run a
 *   tool, so the entry is left out there (`isNodeOnPath`). Such a session runs
 *   with no tool starts and no question waits. For `ask_question` alone the
 *   same entry appends a question wait (`appendPermissionWaitForTool`), since
 *   that dialog always waits on the user (#452). Approvals are not read here.
 *   agy's policy decides whether a tool asks, so a PreToolUse cannot tell an
 *   approval from a tool that just runs; the status line's
 *   `tool_confirmation_pending` reports them
 *   (`AntigravityStatusParser.parseStatusEvents`), and attributes the wait to
 *   the newest tool these entries started. Each tool call now starts the
 *   bridge, which agy waits on for the reply before the tool runs. Not wired
 *   for a WSL agy, whose hook transport carries no reply.
 * - PostToolUse -> `tool_end`, with the tool name at `toolCall.name` and the
 *   primary argument under `toolCall.args` (path-addressed directives).
 * - Stop -> `idle`. Fires when the execution loop terminates (payload carries
 *   `fullyIdle`), the authoritative turn-end.
 * - PostInvocation is skipped as pure noise (fires with PreInvocation's
 *   cadence, carries nothing Stop/Prompt do not).
 *
 * `eventCommand`, for an agy installed in a WSL distro, builds each command in
 * place of `node <bridge> <events>` with the same event types and directives
 * (`wslAgentsHookCommand`).
 */
export function buildHooks(
  bridgeToken: string,
  eventsToken: string,
  existingRoot: AntigravityHooksFile,
  eventCommand?: (eventType: string, ...directives: string[]) => string,
): AntigravityHooksFile {
  const bridge = (eventType: string, ...directives: string[]): string => (eventCommand
    ? eventCommand(eventType, ...directives)
    : ['node', bridgeToken, eventsToken, eventType, ...directives].join(' '));

  // A PreToolUse handler must answer `allow` on stdout, or agy denies the
  // tool. The WSL hook transport carries no reply, and a machine with no node
  // cannot run the bridge, so neither gets the entry. Those sessions record no
  // tool starts and raise no question wait.
  const nodeMissing = !eventCommand && !isNodeOnPath();
  if (nodeMissing) {
    console.warn('[antigravity] No node on PATH; skipping the PreToolUse hook, which would deny every tool');
  }
  const toolStart: AntigravityHookGroup[] | undefined = eventCommand || nodeMissing
    ? undefined
    : [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: bridge(
              EventType.ToolStart,
              extractToolPath(['toolCall', 'name']),
              extractDetailPath(['toolCall', 'args'], TOOL_DETAIL_ARGS),
              appendPermissionWaitForTool({ toolPath: ['toolCall', 'name'], tool: AGY_QUESTION_TOOL, waitKind: 'question' }),
              replyJson({ decision: 'allow' }),
            ),
            timeout: 10,
          },
        ],
      },
    ];

  return {
    ...filterOurHooks(existingRoot),
    [KANGENTIC_HOOK_NAME]: {
      SessionStart: [
        {
          type: 'command',
          command: bridge(EventType.SessionStart),
          timeout: 10,
        },
      ],
      ...(toolStart ? { PreToolUse: toolStart } : {}),
      PreInvocation: [
        {
          type: 'command',
          command: bridge(EventType.Prompt, captureHookContext()),
          timeout: 10,
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: bridge(
                EventType.ToolEnd,
                extractToolPath(['toolCall', 'name']),
                extractDetailPath(['toolCall', 'args'], TOOL_DETAIL_ARGS),
              ),
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          type: 'command',
          command: bridge(EventType.Idle),
          timeout: 10,
        },
      ],
    },
  };
}

let nodeWasFound = false;

/**
 * Whether a bare `node` resolves on main's PATH, the one a session's shell
 * starts from. Only a hit is kept, so a miss is asked again at the next spawn.
 * A node that only a Windows shell profile adds reads as a miss, which costs
 * the session its tool starts. A wrong hit would deny every tool.
 */
function isNodeOnPath(): boolean {
  nodeWasFound ||= which.sync('node', { nothrow: true }) !== null;
  return nodeWasFound;
}

/** Path to a workspace's Antigravity hooks file. */
export function antigravityHooksPath(directory: string): string {
  return path.join(directory, '.agents', 'hooks.json');
}

/**
 * Remove Kangentic's named hook from `<directory>/.agents/hooks.json`
 * (deleting the file, and the `.agents` dir when it becomes empty, via
 * safelyUpdateSettingsFile's empty-object contract), and delete the
 * Kangentic MCP plugin directory the command builder wrote. Preserves all
 * user hooks and plugins. The workspace bridge copy under `.kangentic/` is
 * left in place - it is inert without hooks.json referencing it, lives in a
 * gitignored runtime dir, and the next spawn refreshes it anyway.
 */
export function removeHooks(directory: string): void {
  safelyUpdateSettingsFile(antigravityHooksPath(directory), (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = parsed as AntigravityHooksFile;
    const kept = filterOurHooks(root);
    if (Object.keys(kept).length === Object.keys(root).length) return null;
    return kept;
  }, 'antigravity-removeHooks');

  const pluginDir = path.join(directory, '.agents', 'plugins', 'kangentic');
  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    // Best-effort: fold up now-empty parents so a clean exit leaves no husk.
    try { fs.rmdirSync(path.join(directory, '.agents', 'plugins')); } catch { /* not empty */ }
    try { fs.rmdirSync(path.join(directory, '.agents')); } catch { /* not empty */ }
  } catch (error) {
    console.error('[antigravity] Failed to remove MCP plugin dir', error);
  }
}
