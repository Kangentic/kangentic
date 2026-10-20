/**
 * How an agent's hook payloads say it started or stopped a background command
 * (task #859). One spec per adapter is the single place that knowledge lives:
 * the shared builders in `src/main/agent/shared/background-command-hooks.ts`
 * turn it into the event bridge's `appendBackgroundLaunch` /
 * `appendBackgroundStop` directives AND the launch hint's spec, so the hold and
 * the hint can never disagree about what a background launch is.
 *
 * Types only, so `AgentParser` in `types.ts` can name the capability.
 */

/**
 * What an id must look like for the engine to track a shell by name
 * (`looksLikeShellId`). One source: the engine, both bridges (sent in each
 * directive's payload) and the MCP tool read it from here.
 */
export const SHELL_ID_PATTERN_SOURCE = '^[\\w-]{1,64}$';

/** A path into a hook's stdin JSON, from the root. */
export type PayloadPath = readonly string[];

/** A value at `path` that must equal `equals` exactly (no coercion: `true` is not `"true"`). */
export interface PayloadCondition {
  path: PayloadPath;
  equals: string | number | boolean | null;
}

/**
 * Where a background command's id can be read. Without `pattern` the value at
 * `path` is the id (a string or a number). With it, `pattern`'s first capture
 * group is read out of the string at `path` (Gemini and Qwen put the id in the
 * tool's result text).
 */
export interface BackgroundIdSource {
  path: PayloadPath;
  pattern?: string;
}

/** One kind of tool call: which tools, under which conditions, and where its id sits. */
export interface BackgroundCallMatch {
  /** The stdin field naming the tool: `tool_name`, or `toolName` (Copilot, Grok). */
  toolField: string;
  tools: readonly string[];
  /** Every condition must hold. Empty: the presence of an id decides. */
  when: readonly PayloadCondition[];
  /** Any condition holding means this is not such a call (Copilot's `detach: true`). */
  unless: readonly PayloadCondition[];
  /** Read in order; the first id-shaped value wins. */
  idSources: readonly BackgroundIdSource[];
}

/** A background launch: the call match plus where the command text is, for the opt-out flag. */
export interface BackgroundLaunchMatch extends BackgroundCallMatch {
  commandPath: PayloadPath;
}

/** A JSON value a hint reply can hold. `{{shellId}}` inside any string becomes the id. */
export type BackgroundHintReplyValue =
  | string
  | number
  | boolean
  | null
  | BackgroundHintReplyValue[]
  | { [key: string]: BackgroundHintReplyValue };

/**
 * An adapter's background-command hooks. `launch` is read on the shell tool's
 * post-tool SUCCESS hook (the launch has returned an id by then). `stop` is read
 * on the stop tool's post-tool success hook too, never pre-tool: a stop that is
 * denied or fails would otherwise drain a shell that is still running.
 */
export interface BackgroundCommandSpec {
  launch: BackgroundLaunchMatch;
  stop?: BackgroundCallMatch;
  /** The CLI's "added context" reply. Absent: the CLI cannot add context beside a tool result. */
  hintReply?: BackgroundHintReplyValue;
}

/**
 * `AgentAdapter.backgroundCommands`: this agent reports its background commands,
 * so a launch holds the session and the agent is offered
 * `kangentic_mark_background_service`. Declared only when the agent's activity is
 * hook-driven, its MCP URL is per-session, its payloads are pinned as captured
 * fixtures, and the probe saw the hold stay while the process ran and release
 * when it exited (`background-commands-declaration.test.ts`).
 */
export interface BackgroundCommandSupport {
  /**
   * Where the starts come from: the adapter's hook entries (Claude's remaps, or
   * directives built from a `BackgroundCommandSpec`), or its session-history
   * parser (Codex's rollout, Kimi's wire.jsonl).
   */
  source: 'hooks' | 'session-history';
  /** True when a launch is answered with the mark-as-service hint beside its result. */
  launchHint: boolean;
}
