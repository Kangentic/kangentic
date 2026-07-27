import type { EventType } from '../../../shared/types';

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
 * Extract `event.toolId` from the first non-null of `fields`, read from the
 * top-level stdin object or - when `nested` is given - from `ctx[nested]`.
 * The first directive (in list order) to resolve a value wins.
 */
export function extractToolId(fields: string[], options: { nested?: string } = {}): string {
  if (fields.length === 0) throw new Error('extractToolId requires at least one field');
  return encodeDirective('extractToolId', options.nested ? { fields, nested: options.nested } : { fields });
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
