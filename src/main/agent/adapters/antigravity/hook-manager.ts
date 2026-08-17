import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { toForwardSlash } from '../../../../shared/paths';
import { isKangenticHookCommand, safelyUpdateSettingsFile } from '../../shared/hook-utils';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import {
  captureHookContext,
  extractDetailPath,
  extractToolPath,
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
 * invocation/stop events are flat handler lists.
 */
export interface AntigravityNamedHook {
  enabled?: boolean;
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
 * Copy the deployed event-bridge script into `<cwd>/.kangentic/` so the hook
 * command can reference it space-free relative to `.agents/`. Re-copied on
 * every spawn so an app upgrade can never leave a stale bridge behind (the
 * external-scripts-parity lesson). Returns the `.agents`-relative token, or
 * null when the copy or relativization failed.
 */
export function deployWorkspaceBridgeCopy(cwd: string): string | null {
  try {
    const sourcePath = resolveBridgeScript('event-bridge');
    const runtimeDir = path.join(cwd, '.kangentic');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const copyPath = path.join(runtimeDir, AGY_BRIDGE_COPY_NAME);
    fs.copyFileSync(sourcePath, copyPath);
    return spaceFreeAgentsToken(cwd, copyPath);
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
    PreToolUse: filterGroups(entry.PreToolUse),
    PostToolUse: filterGroups(entry.PostToolUse),
    PreInvocation: filterHandlers(entry.PreInvocation),
    PostInvocation: filterHandlers(entry.PostInvocation),
    Stop: filterHandlers(entry.Stop),
  };

  const survivingHandlerCount =
    (survivor.PreToolUse ?? []).reduce((count, group) => count + group.hooks.length, 0)
    + (survivor.PostToolUse ?? []).reduce((count, group) => count + group.hooks.length, 0)
    + (survivor.PreInvocation ?? []).length
    + (survivor.PostInvocation ?? []).length
    + (survivor.Stop ?? []).length;
  const originalHandlerCount =
    (entry.PreToolUse ?? []).reduce((count, group) => count + (group.hooks ?? []).length, 0)
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

/**
 * Build the merged hooks.json content: user hooks preserved, one fresh
 * Kangentic named hook injected. `bridgeToken` and `eventsToken` are the
 * `.agents`-relative space-free tokens produced by the command builder.
 *
 * Event mapping (agy has five hook events; see the adapter's runtime notes):
 * - PreInvocation -> `prompt`. The turn-initiating signal (ModelStart is NOT
 *   in TURN_INITIATING_EVENTS), fired before every model call. Also carries
 *   `captureHookContext` so `runtime.sessionId.fromHook` can read
 *   `conversationId` from the payload - agy has no once-per-session hook for
 *   the bridge's automatic session_start capture to ride.
 * - PostToolUse -> `tool_end`, with the tool name at `toolCall.name` and the
 *   primary argument under `toolCall.args` (path-addressed directives).
 * - Stop -> `idle`. Fires when the execution loop terminates (payload carries
 *   `fullyIdle: true`), the authoritative turn-end.
 * - PreToolUse is NEVER hooked: agy treats a handler response without a
 *   `decision` field as a DENY (observed: `{}` put the model in a
 *   tool-denied retry loop), and answering `allow` would bypass the CLI's
 *   own permission system. PostInvocation is skipped as pure noise (fires
 *   with PreInvocation's cadence, carries nothing Stop/Prompt do not).
 */
export function buildHooks(
  bridgeToken: string,
  eventsToken: string,
  existingRoot: AntigravityHooksFile,
): AntigravityHooksFile {
  const bridge = (eventType: string, ...directives: string[]): string =>
    ['node', bridgeToken, eventsToken, eventType, ...directives].join(' ');

  return {
    ...filterOurHooks(existingRoot),
    [KANGENTIC_HOOK_NAME]: {
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
                extractDetailPath(
                  ['toolCall', 'args'],
                  ['TargetFile', 'CommandLine', 'DirectoryPath', 'AbsolutePath', 'Query'],
                ),
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
