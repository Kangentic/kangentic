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
 *
 * Stdin: Agent CLIs pipe hook context as JSON. Directives control which
 * fields are extracted for each event type.
 */
// Stdout guard: Gemini CLI rejects any stdout output from hook scripts as
// malformed JSON (docs: "Strict JSON" rule). Codex/Claude tolerate noise on
// stdout but it still gets logged as hook output. We explicitly suppress
// stdout so a stray console.log added during debugging can never silently
// break hook parsing. All diagnostics must go to stderr.
process.stdout.write = () => true;

const fs = require('fs');
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
function logBridgeError(message) {
  if (!outputPath) return;
  try {
    const errorPath = outputPath.replace(/events\.jsonl$/, 'events-bridge.error.log');
    fs.appendFileSync(errorPath, `${new Date().toISOString()} ${eventType} ${message}\n`);
  } catch {
    // Truly nothing we can do
  }
}

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

/** First non-null value of `fields` in `container`, stringified and capped. */
function firstNonNull(container, fields) {
  if (!container || typeof container !== 'object' || !Array.isArray(fields)) return undefined;
  for (const field of fields) {
    const value = container[field];
    if (value != null) return String(value).slice(0, 200);
  }
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!outputPath) return;

  const event = { ts: Date.now(), type: eventType };

  // Parse stdin JSON once for all directives
  let ctx = null;
  if (input && input.length > 0) {
    try { ctx = JSON.parse(input); } catch { /* stdin not valid JSON */ }
  }

  // When an emitOnlyWhenDetailMatches directive fails its match, the whole
  // event is dropped (no append). Tracked here so the suppression survives the
  // rest of the directive loop.
  let suppressed = false;

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
        if (ctx && payload.field && ctx[payload.field] != null) event.tool = ctx[payload.field];
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
        if (value != null) event.tool = value;
        break;
      }
      case 'extractToolId': {
        if (event.toolId !== undefined) break;
        const container = payload.nested ? (ctx && ctx[payload.nested]) : ctx;
        const value = firstNonNull(container, payload.fields);
        if (value !== undefined) event.toolId = value;
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
        if (payload.value != null) event.detail = String(payload.value).slice(0, 200);
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
        if (match && match[1] != null) event.detail = String(match[1]).slice(0, 200);
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
      default:
        logBridgeError(`unknown directive kind: ${kind}`);
    }
  }

  // An emitOnlyWhenDetailMatches gate failed: drop the event entirely. The
  // early return skips the append, so nothing lands in the JSONL.
  if (suppressed) return;

  // Capture the full stdin payload as hookContext on session_start only (so
  // adapters can extract the agent-assigned session id). Skipped for other
  // event types to avoid bloating the JSONL file.
  if (eventType === 'session_start' && ctx && Object.keys(ctx).length > 0) {
    event.hookContext = JSON.stringify(ctx).slice(0, 2048);
  }

  try {
    fs.appendFileSync(outputPath, JSON.stringify(event) + '\n');
  } catch (err) {
    // Don't swallow silently - surface genuine pipeline failures (file
    // locked, path missing, disk full) to the sibling error log.
    logBridgeError(err && err.message ? err.message : String(err));
  }
});
