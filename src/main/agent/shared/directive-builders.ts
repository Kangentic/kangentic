import type { AgentTool, EventType, PermissionWaitKind } from '../../../shared/types';
import type { BackgroundCallMatch, BackgroundLaunchMatch } from '../../../shared/background-command-spec';

/**
 * Typed builders for event-bridge directives.
 *
 * Naming follows the OpenTelemetry transform (OTTL) convention of a clear
 * action verb plus an explicit condition: `extract*` reads a value from the
 * hook payload, `set*` assigns directly, and `setTypeWhen*` changes the
 * emitted event's type when a condition holds.
 *
 * Each agent CLI runs its hook `command` in SHELL form: the whole command
 * string is handed to a shell, which tokenizes on whitespace. So a directive
 * must always be a single shell token. To make the wire robust AND the
 * authoring type-safe, every directive is encoded as
 * `<kind>:<base64(JSON(payload))>`. base64 contains no whitespace and no shell
 * metacharacters, so the directive survives any shell unchanged regardless of
 * the values it carries (spaces, quotes, ':' , unicode). The bridge decodes
 * with the inverse. These builders are the ONLY way directives are authored -
 * never hand-write the wire string. The wire is opaque on purpose; read the
 * builder calls in each adapter's hook-manager, not the encoded command.
 */

/** Encode a directive of `kind` carrying `payload` into its wire form. */
function encodeDirective(kind: string, payload: unknown): string {
  const json = JSON.stringify(payload);
  return `${kind}:${Buffer.from(json, 'utf8').toString('base64')}`;
}

/** Extract `event.tool` from the top-level stdin field `field`. */
export function extractTool(field: string): string {
  return encodeDirective('extractTool', { field });
}

/**
 * Extract `event.tool` from a NESTED stdin location addressed by `pathSegments`
 * (e.g. `['toolCall', 'name']` for Antigravity's `ctx.toolCall.name`).
 *
 * A SEPARATE kind rather than a `nested` flag on `extractTool`, for the same
 * fail-closed reason as `extractDetailWhenTool`: an older bridge copy ignores
 * unknown payload fields, so a flagged `extractTool` would silently read the
 * LAST segment as a top-level field there - extracting an unrelated value when
 * the payload happens to carry one under that generic name (`name`). An
 * unknown KIND instead hits the bridge's `default` arm and is a logged no-op.
 */
export function extractToolPath(pathSegments: string[]): string {
  if (pathSegments.length === 0) throw new Error('extractToolPath requires at least one segment');
  return encodeDirective('extractToolPath', { path: pathSegments });
}

/**
 * Extract `event.detail` from the first non-null of `fields`, read from the
 * NESTED stdin container addressed by `parents` (e.g. `['toolCall', 'args']`
 * for Antigravity's `ctx.toolCall.args.TargetFile`). The multi-level sibling
 * of `extractDetail`'s single-level `nested` option, as its own kind for the
 * same fail-closed stale-copy reason as `extractToolPath`.
 */
export function extractDetailPath(parents: string[], fields: string[]): string {
  if (parents.length === 0) throw new Error('extractDetailPath requires at least one parent segment');
  if (fields.length === 0) throw new Error('extractDetailPath requires at least one field');
  return encodeDirective('extractDetailPath', { parents, fields });
}

/**
 * Capture the ENTIRE stdin payload as `event.hookContext` (capped at 2048
 * chars), regardless of event type. The bridge does this automatically for
 * `session_start` events; this directive is for agents whose hook schema has
 * NO once-per-session event (Antigravity's earliest hook is the per-invocation
 * `PreInvocation`), so the session-id capture path
 * (`SessionTelemetry.captureHookSessionIds` -> `runtime.sessionId.fromHook`)
 * still gets a payload to parse. `captureHookSessionIds` is type-agnostic and
 * one-shot, so repeated captures cost only JSONL bytes, never a re-parse.
 * Unknown to older bridge copies -> logged no-op, and the adapter's other
 * capture paths (`fromOutput`) still function.
 */
export function captureHookContext(): string {
  return encodeDirective('captureHookContext', {});
}

/**
 * Extract `event.toolId` from the first non-null of `fields`, read from the
 * top-level stdin object or - when `nested` is given - from `ctx[nested]`.
 * The first directive (in list order) to resolve a value wins.
 */
export function extractToolId(fields: string[], options: { nested?: string } = {}): string {
  if (fields.length === 0) throw new Error('extractToolId requires at least one field');
  return encodeDirective('extractToolId', options.nested ? { fields, nested: options.nested } : { fields });
}

/**
 * Extract `event.subagentId` from the first non-null top-level stdin field of
 * `fields`. The subagent sibling of `extractToolId`: the engine uses it to
 * release each subagent's depth slot once (task #759).
 *
 * Its own kind, so a stale `event-bridge.js` copy rejects it via `default`
 * (a logged no-op). The event then carries no id and the engine falls back to
 * count-based depth tracking, which is the behavior before this directive.
 */
export function extractSubagentId(fields: string[]): string {
  if (fields.length === 0) throw new Error('extractSubagentId requires at least one field');
  return encodeDirective('extractSubagentId', { fields });
}

/**
 * Set `event.planMode` to whether the top-level stdin string field `field` is
 * one of `planValues`. The event carries a boolean, never the mode string, so
 * the adapter that names `planValues` is the only place an agent's mode
 * vocabulary lives. No-op when the field is absent or not a string: the engine
 * then has no report, which it reads as unknown.
 *
 * `unlessField` skips a payload that carries that top-level field. It is for a
 * hook that can fire for something other than the session's own agent. Claude
 * adds `agent_id` to a hook that fires inside a subagent, and a subagent can
 * run in its own mode while the session plans.
 *
 * Its own kind, so a stale `event-bridge.js` copy rejects it via `default` (a
 * logged no-op), which leaves the mode unknown as before this directive.
 */
export function extractPlanMode(field: string, planValues: string[], options: { unlessField?: string } = {}): string {
  if (planValues.length === 0) throw new Error('extractPlanMode requires at least one plan value');
  return encodeDirective('extractPlanMode', options.unlessField ? { field, planValues, unlessField: options.unlessField } : { field, planValues });
}

/**
 * Extract `event.detail` from the first non-null of `fields`, read from the
 * top-level stdin object or - when `nested` is given - from `ctx[nested]`.
 *
 * `whenTool` scopes the extraction to a single tool, with the same meaning it
 * has on `TypeWhenRule`. Use it whenever the source field name is generic
 * enough that another tool could carry it for an unrelated reason: a
 * tool-blind extraction feeding a downstream type remap is exactly how every
 * foreground Agent/Task completion was once mis-mapped to a background-shell
 * event (commit 4f0ec66f).
 */
export function extractDetail(
  fields: string[],
  options: { nested?: string; whenTool?: string } = {},
): string {
  if (fields.length === 0) throw new Error('extractDetail requires at least one field');
  const payload: { fields: string[]; nested?: string; whenTool?: string } = { fields };
  if (options.nested) payload.nested = options.nested;
  if (options.whenTool) payload.whenTool = options.whenTool;
  // A tool-scoped extraction encodes as its OWN kind so it FAILS CLOSED
  // against a stale `event-bridge.js` copy. The bridge is an unbundled
  // external script (external-scripts-parity.md) and has shipped stale before.
  // An older bridge silently IGNORES an unknown payload field, so encoding
  // this as a plain `extractDetail` would make it extract tool-blindly there -
  // reviving the defect commit 4f0ec66f fixed, now silently and across every
  // tool. An unknown KIND, by contrast, hits the bridge's `default` arm and is
  // a logged no-op: the scoped extraction simply does not happen.
  // Unscoped call sites keep byte-identical output.
  return encodeDirective(options.whenTool ? 'extractDetailWhenTool' : 'extractDetail', payload);
}

/** Set `event.detail` to a fixed value (no stdin lookup). */
export function setDetail(value: string): string {
  return encodeDirective('setDetail', { value });
}

/**
 * A tool-scopable type change. When `ctx.tool_name === whenTool` (or `whenTool`
 * is omitted) AND the addressed field stringifies to `equals`, the emitted
 * event's `type` becomes `to`.
 *
 * Carrying `whenTool` makes tool-scoping the default and prevents the
 * cross-tool collision that mis-mapped foreground Agent/Task completions
 * (which also report `status: "completed"`) to `background_shell_end`.
 */
export interface TypeWhenRule {
  /** Apply only when the top-level `tool_name` equals this. Omit for any tool. */
  whenTool?: string;
  /** Address a nested field as `[parent, field]`. Mutually exclusive with `field`. */
  nested?: [parent: string, field: string];
  /** Address a top-level field by name. Mutually exclusive with `nested`. */
  field?: string;
  /** The stringified value the addressed field must equal to trigger the change. */
  equals: string;
  /** The event type to set when the rule matches. */
  to: EventType;
}

/** Change `event.type` to `rule.to` when the rule's field condition holds. */
export function setTypeWhen(rule: TypeWhenRule): string {
  // `nested` and `field` are mutually exclusive; the decoder prefers `nested`
  // and silently ignores `field`, so catch the authoring mistake at build time.
  if (rule.nested && rule.field !== undefined) {
    throw new Error('setTypeWhen: `nested` and `field` are mutually exclusive');
  }
  return encodeDirective('setTypeWhen', rule);
}

/**
 * A tool rename for the one outcome of a tool that counts as something
 * Kangentic reacts to: when `ctx.tool_name === whenTool` AND the nested string
 * field starts with `startsWith`, the emitted event's `tool` becomes `to`.
 *
 * Gemini's `exit_plan_mode` fires AfterTool for an approved plan and a rejected
 * one alike, and only its response text tells them apart, while Kangentic's plan
 * exit (`AgentTool.ExitPlanMode` on a ToolEnd) must mean approved. Its own kind,
 * so a stale bridge copy no-ops instead of renaming every outcome.
 */
export interface ToolWhenRule {
  /** Apply only when the top-level tool name field equals this. */
  whenTool: string;
  /**
   * The top-level stdin field holding the tool name. Defaults to `tool_name`;
   * Copilot sends `toolName`. A stale bridge copy ignores it and reads
   * `tool_name`, which a camelCase payload lacks, so it renames nothing.
   */
  toolField?: string;
  /** The nested string field to test, as `[parent, field]`. */
  nested: [parent: string, field: string];
  /** The text the field must start with. */
  startsWith: string;
  /** The tool name to set when the rule matches. */
  to: AgentTool;
}

/** Change `event.tool` to `rule.to` when the rule's field starts with `rule.startsWith`. */
export function setToolWhen(rule: ToolWhenRule): string {
  return encodeDirective('setToolWhen', rule);
}

/**
 * Set `event.launchesSubagent` on a call to one of `tools`, the agent's own
 * tools that start a subagent (Claude's Agent tool). The engine closes a
 * permission prompt on a `subagent_start` only when the call the prompt
 * awaited is one of these: then the approved call itself started the
 * subagent. A parallel subagent's start says nothing about the prompt, and
 * once cleared one 4 ms after it opened, with the prompt still on screen.
 *
 * Its own kind, so a stale `event-bridge.js` copy rejects it via `default` (a
 * logged no-op). The flag is then never set, and an approved subagent call
 * reads as a permission prompt until its own end.
 */
export function markSubagentLaunch(tools: string[]): string {
  if (tools.length === 0) throw new Error('markSubagentLaunch requires at least one tool');
  return encodeDirective('markSubagentLaunch', { tools });
}

/**
 * Change `event.type` to `to` when the ALREADY-EXTRACTED `event.detail`
 * contains `contains` (case-insensitive substring). Must be listed AFTER an
 * extractDetail directive. Classifying on the resolved detail (not a source
 * field) makes it robust to which payload field carried the text.
 */
export function setTypeWhenDetailContains(contains: string, to: EventType): string {
  return encodeDirective('setTypeWhenDetailContains', { contains, to });
}

/**
 * Change `event.type` to `to` when the ALREADY-EXTRACTED `event.detail`
 * matches the `pattern` regular expression (the regex sibling of
 * `setTypeWhenDetailContains`). Must be listed AFTER an extractDetail
 * directive. Like the substring form, classifying on the resolved detail makes
 * it robust to which payload field carried the value. `pattern` is compiled
 * with `new RegExp(pattern)` in the bridge.
 */
export function setTypeWhenDetailMatches(pattern: string, to: EventType): string {
  return encodeDirective('setTypeWhenDetailMatches', { pattern, to });
}

/**
 * Extract `event.detail` from capture group 1 of `pattern` matched against the
 * top-level stdin string field `field`. The regex sibling of `extractDetail`:
 * where `extractDetail` copies a whole field value, this pulls a substring out
 * of one. No-op when the field is absent, not a string, the pattern does not
 * match, or group 1 is empty. First-extraction-wins like `extractDetail` (skips
 * if detail is already set). `pattern` is compiled with `new RegExp(pattern)`
 * in the bridge; a malformed pattern is a logged no-op.
 *
 * Used to pull a background shell's task id out of the `<task-notification>`
 * block Claude Code injects as a UserPromptSubmit `prompt` when a bg shell
 * reaches a terminal state.
 */
export function extractDetailPattern(field: string, pattern: string): string {
  return encodeDirective('extractDetailPattern', { field, pattern });
}

/**
 * Suppress the event ENTIRELY (nothing is appended to the JSONL) unless the
 * ALREADY-EXTRACTED `event.detail` matches `pattern`. Must be listed AFTER an
 * extract directive. Fail-closed: a missing detail or a malformed pattern
 * suppresses, because an entry carrying this directive has a base event type
 * (e.g. `background_shell_end`) that is only valid when the match succeeds and
 * is unsafe to emit unconditionally. This is the inverse polarity of
 * `setTypeWhenDetailMatches`, whose no-op keeps the safe base type.
 */
export function emitOnlyWhenDetailMatches(pattern: string): string {
  return encodeDirective('emitOnlyWhenDetailMatches', { pattern });
}

/**
 * `appendBackgroundLaunch`'s payload: the launch match plus the opt-out flag.
 * The id shape is not sent: the bridge holds it as a literal, pinned to
 * `SHELL_ID_PATTERN_SOURCE` by `background-call-match-parity.test.ts`.
 */
export interface BackgroundLaunchDirective extends BackgroundLaunchMatch {
  /** A command carrying this lands exempt (`SessionEvent.noActivityHold`). */
  optOutFlag: string;
}

/**
 * When the payload is a background launch (`BackgroundLaunchMatch`), write a
 * named `background_shell_start` for its id BEFORE the hook's own event, which
 * still lands as it would without this directive. One hook process reports
 * both, so a CLI that runs one event's hooks in turn (Copilot, Grok) pays no
 * extra hook per tool call. The start carries no `toolId`: the tool's own
 * `tool_end` closes its pending tool, and a start that closed it too would
 * decrement the count twice. A flagged command adds `noActivityHold: true`.
 *
 * Its own kind, so a stale bridge copy skips it as an unknown directive: the
 * hook's own event still lands and no start is reported, which is the behavior
 * before this directive.
 */
export function appendBackgroundLaunch(match: BackgroundLaunchDirective): string {
  return encodeDirective('appendBackgroundLaunch', match);
}

/**
 * When the payload is a background stop, write a `background_shell_end` for
 * the id it names before the hook's own event. Register it on the stop tool's
 * post-tool SUCCESS hook only. Its own kind, for the same stale-copy reason.
 */
export function appendBackgroundStop(match: BackgroundCallMatch): string {
  return encodeDirective('appendBackgroundStop', match);
}

/**
 * Set `event.waitKind`: what a permission wait is for. List it on the entry
 * that emits the `idle:permission`, and follow it with `setWaitKindWhen` for
 * the case that differs (an agent's catch-all prompt hook is an approval
 * except for its question tool).
 *
 * Its own kind, so a stale `event-bridge.js` copy rejects it via `default` (a
 * logged no-op). The wait then carries no kind and draws as unknown, never as
 * the wrong kind.
 */
export function setWaitKind(kind: PermissionWaitKind): string {
  return encodeDirective('setWaitKind', { kind });
}

/** `setWaitKindWhen`'s rule: the stdin value at `path` must stringify to `equals`. */
export interface WaitKindWhenRule {
  /** The stdin location, top-level first (`['tool_name']`, `['details', 'type']`). */
  path: string[];
  /** The stringified value that selects `to`. */
  equals: string;
  /** The kind to set when the value matches. */
  to: PermissionWaitKind;
}

/** Set `event.waitKind = rule.to` when the stdin value at `rule.path` equals `rule.equals`. */
export function setWaitKindWhen(rule: WaitKindWhenRule): string {
  if (rule.path.length === 0) throw new Error('setWaitKindWhen requires a non-empty path');
  return encodeDirective('setWaitKindWhen', rule);
}

/** `appendPermissionWaitForTool`'s rule. */
export interface PermissionWaitForToolRule {
  /** The stdin location of the tool name (`['tool_name']`, `['toolCall', 'name']`). */
  toolPath: string[];
  /** The tool whose start is a wait on the user. */
  tool: string;
  /** What that wait is for. */
  waitKind: PermissionWaitKind;
}

/**
 * When the tool at `rule.toolPath` is `rule.tool`, write an `idle:permission`
 * carrying `rule.waitKind` AFTER the hook's own event. Register it on the
 * pre-tool entry, whose own event is the tool's `tool_start`.
 *
 * For a question tool whose CLI raises no permission hook for it (Codex's
 * `request_user_input`): the tool's start is the wait. The engine records the
 * tool on top of its pending stack as the awaited one, so the tool's own
 * `tool_end` (the answer) ends the wait. One hook process writes both lines in
 * order, which a second hook entry could not promise on a CLI that runs a
 * hook event's entries concurrently. A wait written before the `tool_start`
 * would be cleared by it at once.
 *
 * Its own kind, so a stale bridge copy skips it as unknown: the tool start
 * still lands and no wait is reported, which is the behavior before this
 * directive.
 */
export function appendPermissionWaitForTool(rule: PermissionWaitForToolRule): string {
  if (rule.toolPath.length === 0) throw new Error('appendPermissionWaitForTool requires a non-empty toolPath');
  return encodeDirective('appendPermissionWaitForTool', rule);
}

/**
 * The hook's answer on stdout: the bridge process writes `JSON(reply)` before
 * it touches the events file, and nothing else ever reaches its stdout. For a
 * CLI that reads a decision from a hook it waits on: Antigravity's PreToolUse
 * treats a reply with no `decision` as a deny, and `{ decision: 'allow' }`
 * defers to its own policy (measured on agy 1.3.4: the question and command
 * dialogs still showed). Never put it on a CLI that rejects hook stdout
 * (Gemini). Its own kind, so a stale bridge copy writes no reply and logs it.
 */
export function replyJson(reply: Record<string, unknown>): string {
  return encodeDirective('replyJson', { reply });
}
