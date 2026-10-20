import { quoteBridgePath, type HookShell } from './hook-utils';

/**
 * The contract between an adapter and the background shell hint hook
 * (`src/main/agent/background-shell-hint-bridge.js`), task #857.
 *
 * A background shell holds its session `thinking` until it exits, because the
 * agent may be waiting on it. Only the agent knows whether a shell is a build it
 * waits on or a dev server it leaves up, so the hook tells it, beside the tool
 * result, how to say which: the `kangentic_mark_background_service` MCP tool.
 * Everything agent-specific (the tool names, where the command and the shell
 * id sit, the reply the CLI reads as added context) is the adapter's
 * `BackgroundShellHintSpec`; the bridge knows none of it.
 */

/** The string the bridge replaces with the shell id, anywhere inside a `reply` string. */
export const BACKGROUND_SHELL_HINT_SHELL_ID = '{{shellId}}';

/** A JSON value a reply template can hold. */
export type BackgroundShellHintReplyValue =
  | string
  | number
  | boolean
  | null
  | BackgroundShellHintReplyValue[]
  | { [key: string]: BackgroundShellHintReplyValue };

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
  reply: BackgroundShellHintReplyValue;
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
  spec: BackgroundShellHintSpec,
): string {
  const encodedSpec = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  return `node ${quoteBridgePath(bridgePath, windowsShell)} ${encodedSpec}`;
}
