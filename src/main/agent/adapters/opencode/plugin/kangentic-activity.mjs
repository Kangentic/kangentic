// kangentic-activity
// OpenCode plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline. Discovered automatically by
// OpenCode via the project-shared `.opencode/plugins/` directory, where
// hook-manager.ts installs it as `kangentic-activity.js`: OpenCode 1.18.31
// loads only `{plugin,plugins}/*.{ts,js}`, so a `.mjs` copy never ran.
//
// The plugin runs inline in the OpenCode process and writes JSONL
// entries that match the shape produced by Kangentic's other agent
// adapters (see src/main/agent/event-bridge.js). The events file path
// is supplied via the KANGENTIC_EVENTS_PATH env var, which Kangentic's
// PTY spawn flow exports whenever a session has an events output path.
// On a remote host that path would name a file on another computer, so
// the spawn exports KANGENTIC_WSL_HOOK_DIR instead and the plugin
// publishes each event as a record into that folder's `inbox/`.
//
// The leading sentinel comment ("// kangentic-activity") is required:
// hook-manager.ts uses it to identify files it authored before
// deletion, so it never removes user-authored plugins.
//
// The module exports the plugin and nothing else. OpenCode 1.18.31 calls
// every export of a plugin module as a plugin factory. Its loader walks
// `Object.values(module)` and throws on a value that is not a function, so
// an exported helper would run as a plugin and leave its return value among
// the hooks. The pure event-extraction helpers ride on the plugin as
// `KangenticActivity.helpers` instead, for the unit tests against OpenCode
// event fixtures (tests/fixtures/opencode-plugin-events.json).
import fs from 'node:fs';
import path from 'node:path';

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
function extractSessionEvent(event, now = Date.now()) {
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
 * OpenCode 2 does not run this plugin; kangentic-activity-v2.mjs reports its waits.
 */
function extractWaitEvent(event, now = Date.now()) {
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
function extractToolDetail(args) {
  if (!args || typeof args !== 'object') return undefined;
  return truncate(args.command ?? args.filePath ?? args.path ?? args.pattern ?? null);
}

/**
 * Extract a `tool_start` event from OpenCode's `tool.execute.before`
 * (input, output) handler arguments.
 */
function extractToolStartEvent(input, output, now = Date.now()) {
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
function extractToolEndEvent(input, now = Date.now()) {
  return {
    ts: now,
    type: 'tool_end',
    ...(input?.tool ? { tool: input.tool } : {}),
  };
}

const eventsPath = process.env.KANGENTIC_EVENTS_PATH;
// A session on a remote host has no events file on its own disk (the path would name a file on the
// computer running Kangentic). It is given the hook folder instead, which Kangentic's helper watches
// on the host, so the plugin publishes into it as the hook scripts of other agents do. Only when no
// events path is set: an agent in a WSL distro has both and keeps appending to the events file.
const hookDirectory = eventsPath ? undefined : (process.env.KANGENTIC_WSL_HOOK_DIR || undefined);

/** A bridge directive on the wire: `<kind>:<base64 of the JSON payload>` (directive-builders.ts). */
function encodeDirective(kind, payload) {
  return `${kind}:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

/**
 * One event as the hook transport's record (wsl-hook-transport.ts): a header line, the event type,
 * the directives on one line, then the hook's stdin. Kangentic reads it back with the event bridge's
 * own logic, so the line that lands in events.jsonl is the one `appendEvent` would have written.
 * A session_start carries its hookContext as stdin, which the bridge captures whole.
 */
function hookRecordFor(event) {
  const directives = [];
  let input = '';
  if (event.hookContext) {
    input = event.hookContext;
  } else {
    const fields = {};
    if (event.tool) {
      fields.tool = event.tool;
      directives.push(encodeDirective('extractTool', { field: 'tool' }));
    }
    if (event.detail) {
      fields.detail = event.detail;
      directives.push(encodeDirective('extractDetail', { fields: ['detail'] }));
    }
    if (Object.keys(fields).length > 0) input = JSON.stringify(fields);
  }
  if (event.waitKind) directives.push(encodeDirective('setWaitKind', { kind: event.waitKind }));
  return `K1\n${event.type}\n${directives.join(' ')}\n${input}`;
}

let publishSequence = 0;

/**
 * Publish one event into `<directory>/inbox`: written under a dot name and renamed into place, named
 * `<epoch ms><6-digit sequence>-<pid>.rec` like the hook script's files (19 digits, sorting in the
 * order the events happened), then one byte to `signal`, which the watcher on the host listens to.
 */
function publishToHookDirectory(directory, event, now = Date.now()) {
  publishSequence = (publishSequence + 1) % 1000000;
  const name = `${String(now).padStart(13, '0')}${String(publishSequence).padStart(6, '0')}-${process.pid}`;
  const inbox = path.join(directory, 'inbox');
  const staging = path.join(inbox, `.${name}.tmp`);
  fs.writeFileSync(staging, hookRecordFor(event));
  fs.renameSync(staging, path.join(inbox, `${name}.rec`));
  try {
    fs.appendFileSync(path.join(directory, 'signal'), 'x');
  } catch {
    // The watcher also polls the folder.
  }
}

function appendEvent(event) {
  if (!event) return;
  if (hookDirectory) {
    try {
      publishToHookDirectory(hookDirectory, event, event.ts);
    } catch {
      // Best effort. The folder may have been removed when the session ended.
    }
    return;
  }
  if (!eventsPath) return;
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

// Not exports: see the header. A property on the plugin function is invisible
// to OpenCode's loader, which reads only the module's export values.
KangenticActivity.helpers = {
  extractSessionEvent,
  extractWaitEvent,
  extractToolDetail,
  extractToolStartEvent,
  extractToolEndEvent,
  hookRecordFor,
  publishToHookDirectory,
};
