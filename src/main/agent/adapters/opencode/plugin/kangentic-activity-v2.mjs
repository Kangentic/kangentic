// kangentic-activity
// OpenCode 2 plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline. OpenCode 2 does not run OpenCode 1
// plugins (kangentic-activity.mjs), so hook-manager.ts installs this one for
// a V2 session, as `.opencode/plugins/kangentic-activity/index.js`: OpenCode 2
// discovers a local plugin as a directory with an `index` entry. OpenCode 1's
// loader reads only `{plugin,plugins}/*.{ts,js}`, one level deep, so it never
// sees this file.
//
// OpenCode 2's plugin contract (measured on 2.2.5): the module's default
// export is `{ id, setup(ctx) }`, a plain object, so no `@opencode/plugin`
// import is needed (a project could not resolve it). `setup` subscribes to
// `ctx.event.subscribe()` and registers `ctx.tool.hook('execute.before' |
// 'execute.after')`, and returns its cleanup.
//
// The leading sentinel comment ("// kangentic-activity") is required:
// hook-manager.ts uses it to identify files it authored before deletion, so
// it never removes a user-authored plugin.
import fs from 'node:fs';

/**
 * Same cap as the hook bridge's `FIELD_CAP` (src/main/agent/event-bridge.js):
 * a shell `command` is read back for its content (the `git push` capture), so
 * it must not be cut short.
 */
const FIELD_CAP = 2000;

function truncate(value) {
  if (value == null) return undefined;
  return String(value).slice(0, FIELD_CAP);
}

/** The session an OpenCode 2 event belongs to: every session event carries `data.sessionID`. */
function sessionIdOf(event) {
  const sessionID = event && typeof event === 'object' && event.data && typeof event.data === 'object'
    ? event.data.sessionID
    : undefined;
  return typeof sessionID === 'string' && sessionID.length > 0 ? sessionID : null;
}

/**
 * Map one OpenCode 2 event to a Kangentic JSONL event, or null.
 *
 * Measured on 2.2.5 (`run` and the TUI share the server that runs plugins):
 *  - `session.execution.started` opens a turn and `session.execution.succeeded`
 *    closes it.
 *  - `permission.asked` / `permission.replied` keep their OpenCode 1 names.
 *
 * Not measured, and kept on purpose: the names of a failed or interrupted
 * turn (`session.execution.failed`, `.interrupted` and their spellings, and
 * OpenCode 1's `session.idle` / `session.error`), and `question.*`, taken to
 * have kept its OpenCode 1 names. A failure reads as `idle` with
 * `detail: 'error'` and an interrupt as `interrupted`. A guess that misses
 * matches nothing, and the PTY fallback ends the turn, as with no branch.
 *
 * `session_start` is not an OpenCode 2 event: the plugin writes it for the
 * first event of each session it sees (`isNewSession`), with the id in
 * hookContext, which is how the adapter captures the session id.
 */
function extractEvent(event, isNewSession, now = Date.now()) {
  if (!event || typeof event !== 'object') return [];
  const eventType = typeof event.type === 'string' ? event.type : '';
  const sessionID = sessionIdOf(event);
  const out = [];
  if (sessionID && isNewSession(sessionID)) {
    out.push({ ts: now, type: 'session_start', hookContext: JSON.stringify({ sessionID }).slice(0, 2048) });
  }
  if (eventType === 'session.execution.started') {
    out.push({ ts: now, type: 'prompt' });
  } else if (eventType === 'session.execution.succeeded' || eventType === 'session.idle') {
    out.push({ ts: now, type: 'idle' });
  } else if (/^session\.execution\.(interrupted|cancell?ed|aborted)$/.test(eventType)) {
    out.push({ ts: now, type: 'interrupted' });
  } else if (/^session\.execution\.(failed|errored|error)$/.test(eventType) || eventType === 'session.error') {
    out.push({ ts: now, type: 'idle', detail: 'error' });
  } else if (eventType === 'question.asked') {
    out.push({ ts: now, type: 'idle', detail: 'permission', waitKind: 'question' });
  } else if (eventType === 'permission.asked') {
    out.push({ ts: now, type: 'idle', detail: 'permission', waitKind: 'approval' });
  } else if (eventType === 'question.replied' || eventType === 'question.rejected' || eventType === 'permission.replied') {
    out.push({ ts: now, type: 'notification', detail: eventType });
  }
  return out;
}

/** The detail for a tool's start, from the tool's input (`{ command }`, `{ path }`, ...). */
function extractToolDetail(input) {
  if (!input || typeof input !== 'object') return undefined;
  return truncate(input.command ?? input.path ?? input.filePath ?? input.pattern ?? null);
}

/** `execute.before` hands `{ tool, sessionID, input, ... }`. */
function extractToolStartEvent(hookEvent, now = Date.now()) {
  const detail = extractToolDetail(hookEvent?.input);
  return {
    ts: now,
    type: 'tool_start',
    ...(hookEvent?.tool ? { tool: hookEvent.tool } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** `execute.after` hands `{ tool, status, ... }`. */
function extractToolEndEvent(hookEvent, now = Date.now()) {
  return {
    ts: now,
    type: 'tool_end',
    ...(hookEvent?.tool ? { tool: hookEvent.tool } : {}),
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

export default {
  id: 'kangentic.activity',
  async setup(ctx) {
    if (!eventsPath) return undefined;
    const seenSessions = new Set();
    const isNewSession = (sessionID) => {
      if (seenSessions.has(sessionID)) return false;
      seenSessions.add(sessionID);
      return true;
    };
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          for (const line of extractEvent(event, isNewSession)) appendEvent(line);
        }
      } catch {
        // The subscription ends with the plugin (abort) or the server.
      }
    })();
    await ctx.tool.hook('execute.before', (hookEvent) => appendEvent(extractToolStartEvent(hookEvent)));
    await ctx.tool.hook('execute.after', (hookEvent) => appendEvent(extractToolEndEvent(hookEvent)));
    return () => controller.abort();
  },
  // For the unit tests. OpenCode reads only `id` and `setup`.
  helpers: { extractEvent, extractToolDetail, extractToolStartEvent, extractToolEndEvent },
};
