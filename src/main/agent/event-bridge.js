#!/usr/bin/env node
/**
 * Event Bridge - Generic hook-to-JSONL bridge for all agent adapters.
 *
 * Agent CLIs invoke this script via hooks. Appends a single JSON line
 * to the events log. All agent-specific knowledge (field names, event
 * types, stdin formats) is passed via command-line directives from each
 * adapter's hook-manager.
 *
 * Usage:
 *   node event-bridge.js <events-file-path> <event-type> [directives...]
 *
 * Directives are produced by the typed builders in
 * src/main/agent/shared/directive-builders.ts and have the wire form
 * `<kind>:<base64(JSON(payload))>`. The CLI runs the hook command in SHELL
 * form (the whole command string is tokenized on whitespace), so encoding the
 * payload as base64 keeps every directive a single shell token regardless of
 * the values it carries (spaces, quotes, ':' , unicode). Never hand-author the
 * wire string - use the builders.
 *
 *   extractTool                { field }             -> event.tool = ctx[field]
 *   extractToolPath            { path[] }            -> event.tool = value at the nested
 *                                 ctx location (e.g. ['toolCall','name']). Own kind so a
 *                                 stale copy rejects it via `default` instead of misreading
 *                                 the payload (see directive-builders.ts).
 *   extractToolId              { fields[], nested? } -> event.toolId = first non-null
 *   extractSubagentId          { fields[] }          -> event.subagentId = first non-null
 *                                 top-level field (a subagent's correlation id)
 *   extractPlanMode            { field, planValues[], unlessField? } -> event.planMode =
 *                                 whether the top-level string field is one of
 *                                 planValues. No-op when the field is absent or not a
 *                                 string, or when unlessField is present.
 *   extractDetail              { fields[], nested? } -> event.detail = first non-null
 *   extractDetailPath          { parents[], fields[] } -> event.detail = first non-null of
 *                                 fields under the nested container at parents
 *                                 (e.g. ['toolCall','args']). Own kind, same reason.
 *   captureHookContext         { }                   -> event.hookContext = full stdin JSON
 *                                 (2048 cap) regardless of event type, for agents whose
 *                                 hook schema has no once-per-session event to ride the
 *                                 automatic session_start capture below.
 *   extractDetailWhenTool      { fields[], nested?, whenTool }
 *                                 -> same as extractDetail, but only when
 *                                 ctx.tool_name === whenTool. A SEPARATE kind rather
 *                                 than a flag on extractDetail so a stale copy of this
 *                                 script rejects it via `default` instead of silently
 *                                 ignoring the scoping and extracting for every tool.
 *   setDetail                  { value }            -> event.detail = value
 *   setTypeWhen                { whenTool?, nested?:[p,f], field?, equals, to }
 *                                 -> if (no whenTool or ctx.tool_name===whenTool) AND
 *                                    String(addressed field's value) === equals, event.type = to
 *   markSubagentLaunch         { tools[] }          -> event.launchesSubagent = true when
 *                                 ctx.tool_name is one of tools (the call starts a subagent)
 *   setToolWhen                { whenTool, toolField?, nested:[p,f], startsWith, to }
 *                                 -> if ctx[toolField || 'tool_name']===whenTool AND the addressed
 *                                    string field starts with `startsWith`,
 *                                    event.tool = to
 *   setTypeWhenDetailContains  { contains, to }     -> if event.detail (already
 *                                 extracted) contains `contains` (case-insensitive),
 *                                 event.type = to. Must be listed AFTER an extractDetail.
 *   setTypeWhenDetailMatches   { pattern, to }      -> if event.detail (already
 *                                 extracted) matches the regex `pattern`,
 *                                 event.type = to. Must be listed AFTER an extractDetail.
 *   extractDetailPattern       { field, pattern }   -> event.detail = capture group 1
 *                                 of `pattern` matched against String(ctx[field]).
 *                                 First-extraction-wins (skips if detail is set).
 *   emitOnlyWhenDetailMatches  { pattern }          -> suppress the whole event
 *                                 (no append) UNLESS event.detail (already extracted)
 *                                 matches the regex `pattern`. Fail-closed: a missing
 *                                 detail or malformed pattern suppresses. Must be
 *                                 listed AFTER an extract directive.
 *   appendBackgroundLaunch     { toolField, tools, when, unless, idSources,
 *                                commandPath, optOutFlag }
 *                              -> when the payload is that background launch, ALSO
 *                                 write a background_shell_start (detail = the id,
 *                                 noActivityHold when the command carries
 *                                 optOutFlag) before the hook's own event.
 *   appendBackgroundStop       { toolField, tools, when, unless, idSources }
 *                              -> likewise a background_shell_end for the id the
 *                                 stop names. Both read the BackgroundCallMatch shape
 *                                 (src/shared/background-command-spec.ts), and both
 *                                 take only an id matching SHELL_ID_PATTERN.
 *   setWaitKind                { kind }             -> event.waitKind = kind, when kind is
 *                                 'question' or 'approval' (`PermissionWaitKind`).
 *   setWaitKindWhen            { path[], equals, to } -> event.waitKind = to when
 *                                 String(value at path) === equals. List it after a
 *                                 setWaitKind so it overrides that default.
 *   appendPermissionWaitForTool { toolPath[], tool, waitKind }
 *                              -> when the value at toolPath is `tool`, ALSO write an
 *                                 idle:permission carrying waitKind AFTER the hook's own
 *                                 event. One process writes both, in order, so a CLI that
 *                                 runs hooks concurrently cannot land the wait before the
 *                                 tool's own tool_start (which would clear it).
 *   replyJson                  { reply }            -> the hook's answer on stdout: the
 *                                 process writes JSON(reply) before it touches the events
 *                                 file, and it is the only stdout the bridge ever writes.
 *                                 For a CLI that reads a decision from the hook (agy's
 *                                 PreToolUse treats a reply with no `decision` as a deny).
 *                                 Own kind, so a stale copy writes nothing and logs it.
 *
 * Stdin: Agent CLIs pipe hook context as JSON. Directives control which
 * fields are extracted for each event type.
 *
 * Main also loads this file, for a CLI installed in a WSL distro: there a hook
 * publishes its raw call to a file (`wsl-hook-transport.ts`) and Kangentic runs
 * `transformHookEvent` on it, so both paths share one implementation. Loading
 * it has no side effect; everything that touches the process runs only when
 * this file is the script node started (`require.main === module`).
 */

const fs = require('fs');

/** Decode a `<kind>:<base64(JSON)>` directive. payload is undefined if malformed. */
function decodeDirective(directive) {
  const colonIndex = directive.indexOf(':');
  if (colonIndex <= 0) return { kind: directive, payload: undefined };
  const kind = directive.slice(0, colonIndex);
  try {
    const json = Buffer.from(directive.slice(colonIndex + 1), 'base64').toString('utf8');
    return { kind, payload: JSON.parse(json) };
  } catch {
    return { kind, payload: undefined };
  }
}

/**
 * Cap on every field value the bridge extracts (`tool`, `detail`).
 *
 * Sized for a Bash `command`, which is the one field a consumer reads back
 * for its CONTENT rather than its shape: the `git push` capture reads the
 * destination branch out of it (src/main/git/push-command.ts), and the
 * `--kangentic-no-activity-hold` flag is a substring match. At the old 200 a
 * chained `git commit -m "..." && git push -u origin <branch>` lost its push,
 * and a flag past the cut was invisible. Nothing downstream needs a tight
 * bound: the activity log truncates with CSS, the PR-command matcher is
 * prefix-anchored, and the per-session event cache is capped by count.
 *
 * `HOOK_DETAIL_CAP` in src/main/git/push-command.ts duplicates this value
 * (this file is unbundled CommonJS and cannot import it);
 * tests/unit/hook-detail-cap-parity.test.ts keeps the two equal.
 */
const FIELD_CAP = 2000;

/** First non-null value of `fields` in `container`, stringified and capped. */
function firstNonNull(container, fields) {
  if (!container || typeof container !== 'object' || !Array.isArray(fields)) return undefined;
  for (const field of fields) {
    const value = container[field];
    if (value != null) return String(value).slice(0, FIELD_CAP);
  }
  return undefined;
}

// BEGIN background-call-match
// Shared verbatim by event-bridge.js and background-shell-hint-bridge.js (a
// workspace copy of either bridge is one file, so it cannot require a module). The shape is
// BackgroundCallMatch in src/shared/background-command-spec.ts.
// tests/unit/background-call-match-parity.test.ts keeps the two copies equal.
const BACKGROUND_MATCH_SCAN_CAP = 64 * 1024;
// Mirrors `looksLikeShellId` (src/main/activity-engine/background-shell/looks-like-shell-id.ts).
// A literal, so no id regex is built from argv; the parity test pins it to SHELL_ID_PATTERN_SOURCE.
const SHELL_ID_PATTERN = /^[\w-]{1,64}$/;
// The characters SHELL_ID_PATTERN allows, read as one run after an id source's `before` text.
const ID_RUN = /^[\w-]+/;
// One past SHELL_ID_PATTERN's longest id, so a run that is too long still reads as too long.
// The parity test pins it to SHELL_ID_PATTERN_SOURCE.
const ID_RUN_SCAN_LENGTH = 65;

function valueAtPath(root, pathSegments) {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) return undefined;
  let value = root;
  for (const segment of pathSegments) {
    value = value && typeof value === 'object' ? value[segment] : undefined;
  }
  return value;
}

function conditionHolds(root, condition) {
  return Boolean(condition) && valueAtPath(root, condition.path) === condition.equals;
}

/** The id run that starts at `idStart` in `text`, when the literal `after` follows it directly. */
function idRunAt(text, idStart, after) {
  const run = ID_RUN.exec(text.slice(idStart, idStart + ID_RUN_SCAN_LENGTH));
  return run && text.startsWith(after, idStart + run[0].length) ? run[0] : null;
}

/**
 * The id `source` frames in `text`: the run of id characters right after the
 * literal `source.before`, with the literal `source.after` directly behind it.
 * With `source.atStart`, only a `before` that opens the text counts. Plain
 * string search, so no part of a source is ever read as a pattern.
 */
function idInText(text, source) {
  const before = source.before;
  if (before.length === 0) return null;
  const after = typeof source.after === 'string' ? source.after : '';
  const scanned = text.slice(0, BACKGROUND_MATCH_SCAN_CAP);
  if (source.atStart === true) return scanned.startsWith(before) ? idRunAt(scanned, before.length, after) : null;
  for (let index = scanned.indexOf(before); index >= 0; index = scanned.indexOf(before, index + 1)) {
    const id = idRunAt(scanned, index + before.length, after);
    if (id) return id;
  }
  return null;
}

function idFromSources(root, sources) {
  if (!Array.isArray(sources)) return null;
  for (const source of sources) {
    if (!source) continue;
    const value = valueAtPath(root, source.path);
    let candidate = null;
    if (typeof source.before === 'string') {
      if (typeof value === 'string') candidate = idInText(value, source);
    } else if (typeof source.pattern === 'string') {
      // Settings written before ids were framed by literal text can still send a regex. It is
      // never compiled, and the source reads nothing, not the whole text as the id.
      continue;
    } else if (typeof value === 'string' || typeof value === 'number') {
      candidate = String(value);
    }
    if (candidate && SHELL_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/** The id of a call `match` names, or null. Never throws. */
function matchBackgroundCall(root, match) {
  if (!root || typeof root !== 'object' || !match || typeof match !== 'object') return null;
  if (typeof match.toolField !== 'string' || !Array.isArray(match.tools)) return null;
  const tool = root[match.toolField];
  if (typeof tool !== 'string' || !match.tools.includes(tool)) return null;
  const when = Array.isArray(match.when) ? match.when : [];
  const unless = Array.isArray(match.unless) ? match.unless : [];
  if (!when.every((condition) => conditionHolds(root, condition))) return null;
  if (unless.some((condition) => conditionHolds(root, condition))) return null;
  const id = idFromSources(root, match.idSources);
  return id ? { tool, id } : null;
}

/** True when the command at `commandPath` carries `flag`. */
function commandCarries(root, commandPath, flag) {
  const command = valueAtPath(root, commandPath);
  return typeof command === 'string' && typeof flag === 'string' && flag.length > 0 && command.includes(flag);
}
// END background-call-match

/**
 * The kinds a permission wait may report: `PermissionWaitKind` in
 * src/shared/types.ts. Anything else in a directive is a logged no-op, so a
 * wait is never tagged with a kind the engine and the UI do not know.
 */
const WAIT_KINDS = ['question', 'approval'];

function isWaitKind(value) {
  return typeof value === 'string' && WAIT_KINDS.includes(value);
}

/**
 * The events.jsonl lines one hook call reports, in the order they are written:
 * any appended background events, then the hook's own event unless a gate
 * suppressed it, then any trailing permission wait. Pure apart from
 * `logError`, which receives each diagnostic.
 *
 * @param {{ eventType: string, directives: string[], input: string, now: number,
 *   logError: (message: string) => void }} options
 *   `input` is the hook's stdin as received; `now` is the event time in epoch ms.
 * @returns {string[]}
 */
function transformHookEvent(options) {
  const { eventType, directives, input, now } = options;
  const logBridgeError = options.logError;

  const event = { ts: now, type: eventType };

  // Parse stdin JSON once for all directives
  let ctx = null;
  if (input && input.length > 0) {
    try { ctx = JSON.parse(input); } catch { /* stdin not valid JSON */ }
  }

  // When an emitOnlyWhenDetailMatches directive fails its match, the whole
  // event is dropped (no append). Tracked here so the suppression survives the
  // rest of the directive loop.
  let suppressed = false;

  // Events an append* directive reports beside the hook's own event, written
  // before it. They do not depend on the main event: a suppressed main event
  // still lets them land.
  const appended = [];
  // Events written AFTER the hook's own event (appendPermissionWaitForTool).
  // A wait must follow its tool's tool_start, which clears any pending wait.
  const trailing = [];

  // Process directives in list order (setTypeWhenDetailContains relies on a
  // prior extractDetail directive having run).
  for (const directive of directives) {
    const { kind, payload } = decodeDirective(directive);
    // Every directive payload is a JSON object. Reject undefined (malformed
    // base64/JSON) AND any non-object (e.g. a literal `null`, which JSON.parse
    // accepts) so a switch case can never dereference a non-object and crash
    // the process before the event is written - it stays a logged no-op.
    if (payload === null || typeof payload !== 'object') {
      logBridgeError(`malformed directive: ${directive}`);
      continue;
    }

    switch (kind) {
      case 'extractTool': {
        // Stringify + cap like firstNonNull: a non-primitive landing on the
        // field must never embed an unbounded nested object into the JSONL.
        if (ctx && payload.field && ctx[payload.field] != null) {
          event.tool = String(ctx[payload.field]).slice(0, FIELD_CAP);
        }
        break;
      }
      case 'extractToolPath': {
        // Nested sibling of extractTool: walk payload.path segments from the
        // stdin root. Any missing segment makes the whole extraction a no-op.
        if (!ctx || !Array.isArray(payload.path) || payload.path.length === 0) break;
        let value = ctx;
        for (const segment of payload.path) {
          value = value && typeof value === 'object' ? value[segment] : undefined;
        }
        // Same stringify + cap contract as extractTool above.
        if (value != null) event.tool = String(value).slice(0, FIELD_CAP);
        break;
      }
      case 'extractToolId': {
        if (event.toolId !== undefined) break;
        const container = payload.nested ? (ctx && ctx[payload.nested]) : ctx;
        const value = firstNonNull(container, payload.fields);
        if (value !== undefined) event.toolId = value;
        break;
      }
      case 'extractSubagentId': {
        if (event.subagentId !== undefined) break;
        const value = firstNonNull(ctx, payload.fields);
        if (value !== undefined) event.subagentId = value;
        break;
      }
      case 'extractPlanMode': {
        // A boolean, not the mode string: the adapter names which values mean
        // plan mode, so no agent's vocabulary reaches the engine. A field the
        // payload does not carry reports nothing, which the engine reads as unknown.
        // `unlessField` marks a payload that is not the session's own (a
        // subagent's Stop carries its agent id), whose mode may be its own.
        if (!ctx || !payload.field || !Array.isArray(payload.planValues)) break;
        if (payload.unlessField && ctx[payload.unlessField] != null) break;
        const value = ctx[payload.field];
        if (typeof value === 'string') event.planMode = payload.planValues.includes(value);
        break;
      }
      // `extractDetailWhenTool` is the tool-scoped form. It is a SEPARATE kind
      // rather than a flag on `extractDetail` so an older copy of this script
      // rejects it via the `default` arm instead of silently ignoring the
      // scoping and extracting for every tool. Both share this body; the guard
      // is inert without a `whenTool` payload.
      case 'extractDetailWhenTool':
      case 'extractDetail': {
        if (event.detail !== undefined) break;
        // Optional tool scoping, same semantics as setTypeWhen's whenTool below.
        if (payload.whenTool && (!ctx || ctx.tool_name !== payload.whenTool)) break;
        const container = payload.nested ? (ctx && ctx[payload.nested]) : ctx;
        const value = firstNonNull(container, payload.fields);
        if (value !== undefined) event.detail = value;
        break;
      }
      case 'extractDetailPath': {
        // Multi-level sibling of extractDetail's `nested`: walk payload.parents
        // to the container, then first-non-null over payload.fields.
        // First-extraction-wins like extractDetail.
        if (event.detail !== undefined) break;
        if (!ctx || !Array.isArray(payload.parents) || payload.parents.length === 0) break;
        let container = ctx;
        for (const segment of payload.parents) {
          container = container && typeof container === 'object' ? container[segment] : undefined;
        }
        const nestedValue = firstNonNull(container, payload.fields);
        if (nestedValue !== undefined) event.detail = nestedValue;
        break;
      }
      case 'captureHookContext': {
        // Opt-in hookContext capture for agents with no once-per-session hook
        // event (the automatic capture below only fires for session_start).
        // Same 2048 cap as the automatic path.
        if (ctx && Object.keys(ctx).length > 0) {
          event.hookContext = JSON.stringify(ctx).slice(0, 2048);
        }
        break;
      }
      case 'setDetail': {
        // A fixed value, not an extraction: overwrites any prior detail by design.
        if (payload.value != null) event.detail = String(payload.value).slice(0, FIELD_CAP);
        break;
      }
      case 'setTypeWhen': {
        if (!ctx) break;
        if (payload.whenTool && ctx.tool_name !== payload.whenTool) break;
        const container = payload.nested ? ctx[payload.nested[0]] : ctx;
        const field = payload.nested ? payload.nested[1] : payload.field;
        if (container && typeof container === 'object' && String(container[field]) === payload.equals) {
          event.type = payload.to;
        }
        break;
      }
      case 'markSubagentLaunch': {
        // The tool that starts a subagent, named by the adapter, so the engine
        // can tell a subagent its own approved call started from a parallel
        // one: only the first may close a permission prompt it awaited.
        if (!ctx || !Array.isArray(payload.tools)) break;
        if (typeof ctx.tool_name === 'string' && payload.tools.includes(ctx.tool_name)) event.launchesSubagent = true;
        break;
      }
      case 'setToolWhen': {
        // One outcome of a tool renamed to the tool Kangentic reacts to, told
        // apart by how a nested string starts (Gemini's exit_plan_mode reports
        // an approved and a rejected plan alike; only its response text differs).
        if (!ctx || !Array.isArray(payload.nested)) break;
        const toolField = typeof payload.toolField === 'string' ? payload.toolField : 'tool_name';
        if (ctx[toolField] !== payload.whenTool) break;
        const container = ctx[payload.nested[0]];
        const value = container && typeof container === 'object' ? container[payload.nested[1]] : undefined;
        if (typeof value === 'string' && typeof payload.startsWith === 'string' && value.startsWith(payload.startsWith)) {
          event.tool = payload.to;
        }
        break;
      }
      case 'setTypeWhenDetailContains': {
        if (payload.to && typeof event.detail === 'string'
            && event.detail.toLowerCase().includes(String(payload.contains).toLowerCase())) {
          event.type = payload.to;
        }
        break;
      }
      case 'setTypeWhenDetailMatches': {
        // Regex sibling of setTypeWhenDetailContains. A malformed pattern must
        // not crash the bridge before the event is written - treat it as a
        // logged no-op so the event still lands.
        if (payload.to && typeof event.detail === 'string' && typeof payload.pattern === 'string') {
          let matched = false;
          try {
            matched = new RegExp(payload.pattern).test(event.detail);
          } catch {
            logBridgeError(`invalid setTypeWhenDetailMatches pattern: ${payload.pattern}`);
          }
          if (matched) event.type = payload.to;
        }
        break;
      }
      case 'extractDetailPattern': {
        // Regex sibling of extractDetail: pull capture group 1 out of one
        // top-level string field. First-extraction-wins. A malformed pattern
        // must not crash the bridge - treat it as a logged no-op.
        if (event.detail !== undefined) break;
        if (!ctx || typeof payload.field !== 'string' || typeof payload.pattern !== 'string') break;
        const value = ctx[payload.field];
        if (typeof value !== 'string') break;
        let match = null;
        try {
          match = value.match(new RegExp(payload.pattern));
        } catch {
          logBridgeError(`invalid extractDetailPattern pattern: ${payload.pattern}`);
        }
        if (match && match[1] != null) event.detail = String(match[1]).slice(0, FIELD_CAP);
        break;
      }
      case 'emitOnlyWhenDetailMatches': {
        // Fail-closed gate: suppress the entire event unless the already-
        // extracted detail matches. A missing detail or a malformed pattern
        // suppresses, because the event's base type is only valid on a match.
        let matched = false;
        if (typeof payload.pattern === 'string' && typeof event.detail === 'string') {
          try {
            matched = new RegExp(payload.pattern).test(event.detail);
          } catch {
            logBridgeError(`invalid emitOnlyWhenDetailMatches pattern: ${payload.pattern}`);
          }
        }
        if (!matched) suppressed = true;
        break;
      }
      case 'appendBackgroundLaunch': {
        // A background launch reported beside the tool's own tool_end. No
        // toolId: the tool_end closes the pending tool, and a start that
        // closed it too would decrement the count twice.
        const launch = matchBackgroundCall(ctx, payload);
        if (!launch) break;
        const start = { ts: event.ts, type: 'background_shell_start', tool: launch.tool.slice(0, FIELD_CAP), detail: launch.id };
        if (commandCarries(ctx, payload.commandPath, payload.optOutFlag)) start.noActivityHold = true;
        appended.push(start);
        break;
      }
      case 'appendBackgroundStop': {
        const stop = matchBackgroundCall(ctx, payload);
        if (stop) appended.push({ ts: event.ts, type: 'background_shell_end', tool: stop.tool.slice(0, FIELD_CAP), detail: stop.id });
        break;
      }
      case 'setWaitKind': {
        if (isWaitKind(payload.kind)) event.waitKind = payload.kind;
        else logBridgeError(`invalid setWaitKind kind: ${payload.kind}`);
        break;
      }
      case 'setWaitKindWhen': {
        if (!isWaitKind(payload.to)) {
          logBridgeError(`invalid setWaitKindWhen kind: ${payload.to}`);
          break;
        }
        const value = valueAtPath(ctx, payload.path);
        if (value != null && typeof value !== 'object' && String(value) === payload.equals) {
          event.waitKind = payload.to;
        }
        break;
      }
      case 'appendPermissionWaitForTool': {
        if (!isWaitKind(payload.waitKind) || typeof payload.tool !== 'string') {
          logBridgeError(`invalid appendPermissionWaitForTool payload: ${JSON.stringify(payload)}`);
          break;
        }
        if (valueAtPath(ctx, payload.toolPath) !== payload.tool) break;
        trailing.push({
          ts: event.ts,
          type: 'idle',
          detail: 'permission',
          tool: payload.tool.slice(0, FIELD_CAP),
          waitKind: payload.waitKind,
        });
        break;
      }
      case 'replyJson':
        // The process writes the reply (`hookReplyFrom`); it adds nothing to the event.
        break;
      default:
        logBridgeError(`unknown directive kind: ${kind}`);
    }
  }

  // An emitOnlyWhenDetailMatches gate failed: drop the hook's own event. An
  // appended background event still lands.
  const lines = appended.map((entry) => JSON.stringify(entry));

  if (!suppressed) {
    // Capture the full stdin payload as hookContext on session_start only (so
    // adapters can extract the agent-assigned session id). Skipped for other
    // event types to avoid bloating the JSONL file.
    if (eventType === 'session_start' && ctx && Object.keys(ctx).length > 0) {
      event.hookContext = JSON.stringify(ctx).slice(0, 2048);
    }
    lines.push(JSON.stringify(event));
  }
  for (const entry of trailing) lines.push(JSON.stringify(entry));
  return lines;
}

/**
 * The reply a `replyJson` directive asks the hook to print, as one JSON
 * string, or null when the command carries none (or only a malformed one).
 */
function hookReplyFrom(directives) {
  for (const directive of directives) {
    const { kind, payload } = decodeDirective(directive);
    if (kind !== 'replyJson') continue;
    if (!payload || typeof payload !== 'object' || !payload.reply || typeof payload.reply !== 'object') return null;
    return JSON.stringify(payload.reply);
  }
  return null;
}

module.exports = { transformHookEvent, hookReplyFrom };

if (require.main === module) {
  // Stdout guard: Gemini CLI rejects any stdout output from hook scripts as
  // malformed JSON (docs: "Strict JSON" rule). Codex/Claude tolerate noise on
  // stdout but it still gets logged as hook output. We explicitly suppress
  // stdout so a stray console.log added during debugging can never silently
  // break hook parsing. All diagnostics must go to stderr. The one exception
  // is a `replyJson` directive's reply, written through the saved writer.
  const writeHookReply = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;

  // The events path argument is either a literal path or the sentinel
  // `env:<NAME>`, which resolves the path from the hook process environment at
  // run time. Adapters whose CLI has no per-session settings mechanism (Grok)
  // write ONE static per-cwd hook file whose commands carry the sentinel; each
  // Kangentic PTY spawn supplies its own value, so concurrent sessions in the
  // same cwd route to their own events.jsonl - and a session WITHOUT the
  // variable (the user's own manual CLI run in that cwd) resolves to an empty
  // path, which the `if (!outputPath) return` below turns into a silent no-op
  // instead of writing into some task's activity log.
  const rawOutputPath = process.argv[2];
  const outputPath = rawOutputPath && rawOutputPath.startsWith('env:')
    ? (process.env[rawOutputPath.slice(4)] || '')
    : rawOutputPath;
  const eventType = process.argv[3] || 'idle';
  const directives = process.argv.slice(4);

  /**
   * Append a diagnostic line to the sibling error log so silent pipeline
   * failures (unknown/malformed directive, file locked, disk full) are
   * discoverable instead of vanishing. Best-effort: the error log may also fail.
   */
  const logBridgeError = (message) => {
    if (!outputPath) return;
    try {
      const errorPath = outputPath.replace(/events\.jsonl$/, 'events-bridge.error.log');
      fs.appendFileSync(errorPath, `${new Date().toISOString()} ${eventType} ${message}\n`);
    } catch {
      // Truly nothing we can do
    }
  };

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    // The reply first, before any file work and whatever the events path: a CLI
    // that waits on the answer must get it even when the append below fails.
    const reply = hookReplyFrom(directives);
    if (reply !== null) writeHookReply(reply);
    if (!outputPath) return;
    const lines = transformHookEvent({ eventType, directives, input, now: Date.now(), logError: logBridgeError });
    if (lines.length === 0) return;

    try {
      // One append, so a reader never sees the start without the tool_end beside it.
      fs.appendFileSync(outputPath, lines.join('\n') + '\n');
    } catch (err) {
      // Don't swallow silently - surface genuine pipeline failures (file
      // locked, path missing, disk full) to the sibling error log.
      logBridgeError(err && err.message ? err.message : String(err));
    }
  });
}
