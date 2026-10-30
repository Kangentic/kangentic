// kangentic-activity
// OpenCode plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline. Discovered automatically by
// OpenCode via the project-shared `.opencode/plugins/` directory.
//
// The plugin runs inline in the OpenCode process and writes JSONL
// entries that match the shape produced by Kangentic's other agent
// adapters (see src/main/agent/event-bridge.js). The events file path
// is supplied via the KANGENTIC_EVENTS_PATH env var, which Kangentic's
// PTY spawn flow exports whenever a session has an events output path.
//
// The leading sentinel comment ("// kangentic-activity") is required:
// hook-manager.ts uses it to identify files it authored before
// deletion, so it never removes user-authored plugins.
//
// The pure event-extraction helpers (extractSessionEvent /
// extractWaitEvent / extractToolStartEvent / extractToolEndEvent) are
// exported so they can be unit-tested against OpenCode event fixtures
// (tests/fixtures/opencode-plugin-events.json).
import fs from 'node:fs';

/**
 * Extract a Kangentic JSONL event from an OpenCode `event` payload.
 * Returns null when the event type is not one we surface.
 *
 * Recognized OpenCode event types (from https://opencode.ai/docs/plugins/,
 * verified against the cmux reference plugin):
 *  - `session.created`: emit a `session_start` with the OpenCode
 *    session id captured into hookContext for resume support.
 *  - `session.idle`:    emit `idle` (the agent has stopped working).
 *  - `session.error`:   emit `idle` with `detail: 'error'`.
 */
export function extractSessionEvent(event, now = Date.now()) {
  if (!event || typeof event !== 'object') return null;
  const eventType = event.type;
  if (eventType === 'session.created' || eventType === 'session.start') {
    const properties = event.properties ?? {};
    const sessionInfo = properties.info ?? {};
    const sessionID = sessionInfo.id ?? properties.sessionID ?? null;
    const hookContext = sessionID
      ? JSON.stringify({ sessionID }).slice(0, 2048)
      : undefined;
    return {
      ts: now,
      type: 'session_start',
      ...(hookContext ? { hookContext } : {}),
    };
  }
  if (eventType === 'session.idle') {
    return { ts: now, type: 'idle' };
  }
  if (eventType === 'session.error') {
    return { ts: now, type: 'idle', detail: 'error' };
  }
  return null;
}

/**
 * Extract a wait on the user from an OpenCode 1.x `event` payload: the
 * question tool's prompt (`question.asked`) or a permission prompt
 * (`permission.asked`). Both are published from inside the tool's own
 * execution, after `tool.execute.before` wrote the tool's `tool_start`, so the
 * wait lands after the start (a start after it would clear it), and the
 * tool's `tool.execute.after` (a depth-0 `tool_end`) ends it once answered.
 *
 * The answers (`question.replied`, `question.rejected`, `permission.replied`)
 * are logged as notifications. They need no clearing event of their own: a
 * reply lets the tool finish, and a rejection ends the tool or the turn, whose
 * next `tool_start` or `session.idle` clears the wait. A plain idle here would
 * be read as the agent's own turn end, which a reply is not.
 *
 * OpenCode v2 does not run v1 plugins, so a v2 session reports no waits.
 */
export function extractWaitEvent(event, now = Date.now()) {
  if (!event || typeof event !== 'object') return null;
  const eventType = event.type;
  if (eventType === 'question.asked') {
    return { ts: now, type: 'idle', detail: 'permission', waitKind: 'question' };
  }
  if (eventType === 'permission.asked') {
    return { ts: now, type: 'idle', detail: 'permission', waitKind: 'approval' };
  }
  if (eventType === 'question.replied' || eventType === 'question.rejected' || eventType === 'permission.replied') {
    return { ts: now, type: 'notification', detail: eventType };
  }
  return null;
}

/**
 * Same cap as the hook bridge's `FIELD_CAP` (src/main/agent/event-bridge.js):
 * a Bash `command` is read back for its content (the `git push` capture), so
 * it must not be cut short.
 */
const FIELD_CAP = 2000;

function truncate(value) {
  if (value == null) return undefined;
  return String(value).slice(0, FIELD_CAP);
}

/**
 * Build the per-tool detail string from OpenCode's `output.args` payload.
 * Tries common arg field names in priority order; falls back to undefined
 * for unknown tools (the consumer is fine with no detail).
 */
export function extractToolDetail(args) {
  if (!args || typeof args !== 'object') return undefined;
  return truncate(args.command ?? args.filePath ?? args.path ?? args.pattern ?? null);
}

/**
 * Extract a `tool_start` event from OpenCode's `tool.execute.before`
 * (input, output) handler arguments.
 */
export function extractToolStartEvent(input, output, now = Date.now()) {
  const detail = extractToolDetail(output?.args);
  return {
    ts: now,
    type: 'tool_start',
    ...(input?.tool ? { tool: input.tool } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Extract a `tool_end` event from OpenCode's `tool.execute.after` input.
 */
export function extractToolEndEvent(input, now = Date.now()) {
  return {
    ts: now,
    type: 'tool_end',
    ...(input?.tool ? { tool: input.tool } : {}),
  };
}

const eventsPath = process.env.KANGENTIC_EVENTS_PATH;

function appendEvent(event) {
  if (!eventsPath || !event) return;
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort. The file may have been removed when the session ended.
  }
}

export const KangenticActivity = async () => ({
  event: async ({ event }) => {
    appendEvent(extractSessionEvent(event) ?? extractWaitEvent(event));
  },
  'tool.execute.before': async (input, output) => {
    appendEvent(extractToolStartEvent(input, output));
  },
  'tool.execute.after': async (input) => {
    appendEvent(extractToolEndEvent(input));
  },
});
