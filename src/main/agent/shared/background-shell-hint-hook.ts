import { quoteBridgePath, type HookShell } from './hook-utils';
import type { BackgroundHintReplyValue } from '../../../shared/background-command-spec';
import { MARK_BACKGROUND_SERVICE_TOOL } from '../../../shared/background-shell-hold';
import type { BackgroundLaunchDirective } from './directive-builders';

/**
 * The contract between an adapter and the background shell hint hook
 * (`src/main/agent/background-shell-hint-bridge.js`), task #857.
 *
 * A background shell holds its session `thinking` until it exits, because the
 * agent may be waiting on it. Only the agent knows whether a shell is a build it
 * waits on or a dev server it leaves up, so the hook tells it, beside the tool
 * result, how to say which: the `kangentic_mark_background_service` MCP tool.
 * Everything agent-specific (the tool names, where the command and the shell
 * id sit, the reply the CLI reads as added context) is the adapter's spec; the
 * bridge knows none of it.
 */

/** The string the bridge replaces with the shell id, anywhere inside a `reply` string. */
export const BACKGROUND_SHELL_HINT_SHELL_ID = '{{shellId}}';

/**
 * What every CLI's hint says, inside its own reply envelope. One text, so the
 * agents are told the same thing whichever CLI runs them.
 */
export const BACKGROUND_SHELL_HINT_TEXT =
  `Kangentic keeps this task marked as working, and holds its column's turn-end automations, until background shell ${BACKGROUND_SHELL_HINT_SHELL_ID} exits. `
  + `If it is a server or watcher meant to keep running after your turn, not work you are waiting on, call ${MARK_BACKGROUND_SERVICE_TOOL} with shellIds ["${BACKGROUND_SHELL_HINT_SHELL_ID}"].`;

/** v1, Claude's: top-level field names, the id read one level into an object response. */
export interface BackgroundShellHintSpec {
  /** The stdin field naming the tool that ran. */
  toolField: string;
  /** The tools that can start a background shell. Any other tool is never answered. */
  tools: string[];
  /** The stdin field holding the tool's input. */
  inputField: string;
  /** The input field holding the command, read for `optOutFlag`. */
  commandField: string;
  /** The stdin field holding the tool's result. */
  responseField: string;
  /** Result fields that can carry the background shell id, in the order they are read. */
  idFields: string[];
  /** A command carrying this already opted out of the hold, so it gets no hint. */
  optOutFlag: string;
  /** What the hook prints, with `BACKGROUND_SHELL_HINT_SHELL_ID` in place. */
  reply: BackgroundHintReplyValue;
}

/**
 * v2 (task #859): the exact launch match the event bridge's
 * `appendBackgroundLaunch` directive carries, built from the same
 * `BackgroundCommandSpec`, so the hint answers exactly the launches that hold.
 * A bridge older than v2 requires `tools` at the top level and prints nothing.
 */
export interface BackgroundShellHintSpecV2 {
  launch: BackgroundLaunchDirective;
  reply: BackgroundHintReplyValue;
}

/**
 * Build the hook command: `node "<bridge>" <base64 spec>`, the bridge path
 * quoted for the adapter's declared `windowsShell`. Base64 keeps the spec one
 * shell token whatever it holds, as the event bridge's directives do
 * (`directive-builders.ts`).
 */
export function buildBackgroundShellHintCommand(
  windowsShell: HookShell,
  bridgePath: string,
  spec: BackgroundShellHintSpec | BackgroundShellHintSpecV2,
): string {
  const encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return `node ${quoteBridgePath(bridgePath, windowsShell)} ${encodedSpec}`;
}
