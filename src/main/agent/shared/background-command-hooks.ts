import { toForwardSlash } from '../../../shared/paths';
import type { BackgroundCommandSpec } from '../../../shared/background-command-spec';
import { NO_ACTIVITY_HOLD_FLAG } from '../../../shared/background-shell-hold';
import { urlNamesTaskSessionCaller } from '../mcp-http/caller-url';
import type { CommandOptions } from '../agent-adapter';
import { resolveBridgeScript } from './bridge-utils';
import {
  appendBackgroundLaunch,
  appendBackgroundStop,
  type BackgroundLaunchDirective,
} from './directive-builders';
import { buildBackgroundShellHintCommand, type BackgroundShellHintSpecV2 } from './background-shell-hint-hook';
import { encodeHookSpec, type HookShell } from './hook-utils';
import type { CliPlace } from './cli-target';
import { wslHookReplyCommand, type WslHookPaths } from './wsl-hook-transport';

/**
 * Shared builders that turn an adapter's `BackgroundCommandSpec` into its
 * hook pieces (task #859): the event bridge directives that report a launch
 * and a stop, and the launch hint. The directive and the hint read one launch
 * match, built once here, so they answer exactly the same calls.
 *
 * Placement, for every adapter: the launch directive rides the shell tool's
 * existing post-tool (success) entry, the stop directive the stop tool's, and
 * the hint is one more post-tool entry, matcher-scoped to the shell tools where
 * the CLI has matchers. Neither directive adds a hook process.
 */

/** The launch match the directive and the hint both carry. */
function launchMatchOf(spec: BackgroundCommandSpec): BackgroundLaunchDirective {
  return { ...spec.launch, optOutFlag: NO_ACTIVITY_HOLD_FLAG };
}

/** `appendBackgroundLaunch` for the spec's launch. */
export function backgroundLaunchDirective(spec: BackgroundCommandSpec): string {
  return appendBackgroundLaunch(launchMatchOf(spec));
}

/** `appendBackgroundStop` for the spec's stop, as a list to spread: empty when the CLI has no stop tool. */
export function backgroundStopDirectives(spec: BackgroundCommandSpec): string[] {
  if (!spec.stop) return [];
  return [appendBackgroundStop(spec.stop)];
}

/** The hint bridge's v2 spec, or null when the CLI cannot add context beside a tool result. */
export function backgroundShellHintSpecOf(spec: BackgroundCommandSpec): BackgroundShellHintSpecV2 | null {
  if (spec.hintReply === undefined) return null;
  return { launch: launchMatchOf(spec), reply: spec.hintReply };
}

/**
 * A hook matcher for these tool names, `a|b` the way Claude's are written. A
 * CLI that matches a whole name exactly (one tool) or by a regex that must
 * match fully (Copilot, Codex) reads it the same.
 */
export function backgroundToolMatcher(tools: readonly string[]): string {
  return tools.map((tool) => tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Whether the session will be offered `kangentic_mark_background_service`, so
 * a hint pointing at it may be shown: the MCP server is on with a token, and
 * the session's MCP URL names it as the caller (`/mcp/<project>/<session>`). A
 * Command Terminal, a workflow's own agent and an answer run have no such URL.
 */
export function offersMarkBackgroundService(
  options: Pick<CommandOptions, 'mcpServerEnabled' | 'mcpServerToken' | 'mcpServerUrl'>,
): boolean {
  return options.mcpServerEnabled !== false
    && Boolean(options.mcpServerToken)
    && urlNamesTaskSessionCaller(options.mcpServerUrl);
}

/** The name a nested hint entry carries in the CLI's settings file. */
const BACKGROUND_SHELL_HINT_HOOK_NAME = 'kangentic-background-shell-hint';

/** A hook entry in the `{ matcher, hooks: [...] }` shape (Qwen, Gemini). */
export interface NestedHookEntry {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/**
 * The hint's entry for a CLI whose post-tool entries are `{ matcher, hooks }`,
 * matcher-scoped to the launch tools, as a list to spread: empty when the
 * session gets no hint command.
 */
export function nestedBackgroundShellHintEntries(
  spec: BackgroundCommandSpec,
  hintCommand: string | null | undefined,
): NestedHookEntry[] {
  if (!hintCommand) return [];
  return [{
    matcher: backgroundToolMatcher(spec.launch.tools),
    hooks: [{ name: BACKGROUND_SHELL_HINT_HOOK_NAME, type: 'command', command: hintCommand }],
  }];
}

/** The shipped hint bridge, forward-slashed for a hook command. */
export function shippedHintBridgePath(): string {
  return toForwardSlash(resolveBridgeScript('background-shell-hint-bridge'));
}

/**
 * The hint hook's command for this spawn, or null when the session is not
 * offered the MCP tool or the CLI cannot add context. `hintBridgePath` is the
 * shipped bridge, or a workspace copy for a CLI whose hooks take bare tokens.
 */
export function backgroundShellHintCommandFor(
  options: Pick<CommandOptions, 'mcpServerEnabled' | 'mcpServerToken' | 'mcpServerUrl'>,
  spec: BackgroundCommandSpec,
  windowsShell: HookShell,
  hintBridgePath: string,
): string | null {
  if (!offersMarkBackgroundService(options)) return null;
  const hintSpec = backgroundShellHintSpecOf(spec);
  if (!hintSpec) return null;
  return buildBackgroundShellHintCommand(windowsShell, hintBridgePath, hintSpec);
}

/**
 * The hint hook's command for a CLI installed in a WSL distro: the WSL hook
 * transport's `reply`, which Kangentic answers with the hint bridge's own
 * logic (`backgroundShellHintReply`), so a distro with no node gets the same
 * hint. Null whenever `backgroundShellHintCommandFor` would be.
 */
export function wslBackgroundShellHintCommandFor(
  options: Pick<CommandOptions, 'mcpServerEnabled' | 'mcpServerToken' | 'mcpServerUrl'>,
  spec: BackgroundCommandSpec,
  paths: WslHookPaths,
  place: CliPlace,
): string | null {
  if (!offersMarkBackgroundService(options)) return null;
  const hintSpec = backgroundShellHintSpecOf(spec);
  if (!hintSpec) return null;
  return wslHookReplyCommand(paths, place, 'background-shell-hint', encodeHookSpec(hintSpec));
}
