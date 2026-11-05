// kangentic-activity
// OpenCode 2 plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline, and keeps the session's status.json
// (model, context, tokens, cost) beside it for `parseOpenCodeStatus`
// (status-parser.ts). OpenCode 2 does not run OpenCode 1
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
import path from 'node:path';

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

// The OpenCode 1 plugin (kangentic-activity.mjs) keeps its own copy of the
// helpers below and of the status shape: each plugin is one file OpenCode loads
// alone. Edit the two together.
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A line that ends the root's turn: its idle (not a permission wait) or an interrupt. */
function endsRootTurn(line) {
  return (line.type === 'idle' && line.detail !== 'permission') || line.type === 'interrupted';
}

/** `TokenUsage.Info` (`packages/schema/src/token-usage.ts` at v2.2.5): input, output, reasoning, cache.read, cache.write. */
function readTokens(tokens) {
  const cache = tokens && typeof tokens === 'object' && tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  return {
    input: finiteNumber(tokens?.input),
    output: finiteNumber(tokens?.output),
    reasoning: finiteNumber(tokens?.reasoning),
    cacheRead: finiteNumber(cache.read),
    cacheWrite: finiteNumber(cache.write),
  };
}

/**
 * One OpenCode 2 process's sessions. The `task` subagent runs in a child
 * session whose `session.created` carries `data.parentID`
 * (`packages/schema/src/session-event.ts` at v2.2.5), and the event stream
 * holds every session's events. A child's start and its execution end write
 * `subagent_start` and `subagent_stop`, keyed by its session id, never the
 * task's own `session_start` or `idle`, so the task's turn does not end while
 * the subagent runs.
 *
 * It also keeps the session's telemetry for `status.json` (the same shape the
 * OpenCode 1 plugin writes, read by `parseOpenCodeStatus`): the model from the
 * root's `session.step.started` (`Model.Ref`: `id`, `providerID`), and each
 * step's `tokens` and `cost` from `session.step.ended`, keyed by
 * `assistantMessageID`. The events name no context limit, so the size is 0, the
 * unknown sentinel. Cost adds the subagents' steps and compactions.
 *
 * Built from the 2.2.5 schema; the `step`, `compaction` and child events have
 * not been seen in a live run.
 */
function createV2SessionTracker() {
  const seenSessions = new Set();
  const childSessions = new Set();
  const openChildren = new Set();
  const rootTokensByMessage = new Map();
  const costByKey = new Map();
  let model = null;
  let lastRootMessage = null;
  let compactionCount = 0;
  let statusDirty = false;

  const isNewSession = (sessionID) => {
    if (seenSessions.has(sessionID)) return false;
    seenSessions.add(sessionID);
    return true;
  };
  const isChild = (sessionID) => typeof sessionID === 'string' && childSessions.has(sessionID);

  function startChild(sessionID, now) {
    if (openChildren.has(sessionID)) return [];
    openChildren.add(sessionID);
    return [{ ts: now, type: 'subagent_start', subagentId: sessionID }];
  }

  function stopChild(sessionID, now) {
    if (!openChildren.delete(sessionID)) return [];
    return [{ ts: now, type: 'subagent_stop', subagentId: sessionID }];
  }

  function noteStepEnded(sessionID, data) {
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : null;
    if (!messageID) return;
    costByKey.set(`step:${messageID}`, finiteNumber(data.cost));
    statusDirty = true;
    if (isChild(sessionID)) return;
    rootTokensByMessage.set(messageID, readTokens(data.tokens));
    lastRootMessage = messageID;
  }

  return {
    onEvent(event, now = Date.now()) {
      if (!event || typeof event !== 'object') return [];
      const eventType = typeof event.type === 'string' ? event.type : '';
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const sessionID = sessionIdOf(event);
      if (eventType === 'session.created' && sessionID && typeof data.parentID === 'string' && data.parentID.length > 0) {
        childSessions.add(sessionID);
        seenSessions.add(sessionID);
        return startChild(sessionID, now);
      }
      if (eventType === 'session.step.ended' || eventType === 'session.step.failed') noteStepEnded(sessionID, data);
      if (eventType === 'session.compaction.ended' || eventType === 'session.compaction.failed') {
        compactionCount += 1;
        costByKey.set(`compaction:${compactionCount}`, finiteNumber(data.cost));
        statusDirty = true;
      }
      if (isChild(sessionID)) {
        if (eventType === 'session.execution.started') return startChild(sessionID, now);
        if (/^session\.execution\./.test(eventType)) return stopChild(sessionID, now);
        // A subagent's wait is on the user too.
        if (/^(question|permission)\./.test(eventType)) return extractEvent(event, () => false, now);
        return [];
      }
      if (eventType === 'session.step.started' && data.model && typeof data.model === 'object' && typeof data.model.id === 'string') {
        const stepModel = typeof data.model.providerID === 'string' && data.model.providerID ? `${data.model.providerID}/${data.model.id}` : data.model.id;
        if (stepModel !== model) {
          model = stepModel;
          statusDirty = true;
        }
      }
      if (eventType === 'session.compaction.started') {
        const lines = sessionID && isNewSession(sessionID)
          ? [{ ts: now, type: 'session_start', hookContext: JSON.stringify({ sessionID }).slice(0, 2048) }]
          : [];
        return [...lines, { ts: now, type: 'compact' }];
      }
      const lines = extractEvent(event, isNewSession, now);
      if (!lines.some(endsRootTurn)) return lines;
      // The root's turn is over, so no subagent of it is still running. The
      // stops go after a `session_start` this event opened and before the idle.
      const stops = [];
      for (const child of [...openChildren]) stops.push(...stopChild(child, now));
      const starts = lines.filter((line) => line.type === 'session_start');
      const rest = lines.filter((line) => line.type !== 'session_start');
      return [...starts, ...stops, ...rest];
    },

    toolStart(hookEvent, now = Date.now()) {
      const line = extractToolStartEvent(hookEvent, now);
      return isChild(hookEvent?.sessionID) ? { ...line, subagentId: hookEvent.sessionID } : line;
    },

    toolEnd(hookEvent, now = Date.now()) {
      const line = extractToolEndEvent(hookEvent, now);
      return isChild(hookEvent?.sessionID) ? { ...line, subagentId: hookEvent.sessionID } : line;
    },

    takeStatusChange() {
      const changed = statusDirty;
      statusDirty = false;
      return changed;
    },

    status() {
      if (!model) return null;
      const totals = readTokens(undefined);
      for (const tokens of rootTokensByMessage.values()) {
        for (const key of Object.keys(totals)) totals[key] += tokens[key];
      }
      let costUsd = 0;
      for (const cost of costByKey.values()) costUsd += cost;
      return {
        kangenticOpenCodeStatus: 1,
        model: { id: model },
        contextLimit: 0,
        context: (lastRootMessage && rootTokensByMessage.get(lastRootMessage)) || readTokens(undefined),
        totals,
        costUsd,
      };
    },
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
    if (event.toolId) {
      fields.toolId = event.toolId;
      directives.push(encodeDirective('extractToolId', { fields: ['toolId'] }));
    }
    if (event.subagentId) {
      fields.subagentId = event.subagentId;
      directives.push(encodeDirective('extractSubagentId', { fields: ['subagentId'] }));
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

// Beside the events file, as the OpenCode 1 plugin keeps it (none on a remote host, which has no events path).
const statusPath = eventsPath ? path.join(path.dirname(eventsPath), 'status.json') : null;

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

/** Rewrite the status file whole, in place, as the OpenCode 1 plugin does. */
function writeStatus(status) {
  if (!statusPath || !status) return;
  try {
    fs.writeFileSync(statusPath, JSON.stringify(status));
  } catch {
    // Best effort. The session may have ended and its folder gone.
  }
}

export default {
  id: 'kangentic.activity',
  async setup(ctx) {
    if (!eventsPath && !hookDirectory) return undefined;
    const tracker = createV2SessionTracker();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          for (const line of tracker.onEvent(event)) appendEvent(line);
          if (tracker.takeStatusChange()) writeStatus(tracker.status());
        }
      } catch {
        // The subscription ends with the plugin (abort) or the server.
      }
    })();
    await ctx.tool.hook('execute.before', (hookEvent) => appendEvent(tracker.toolStart(hookEvent)));
    await ctx.tool.hook('execute.after', (hookEvent) => appendEvent(tracker.toolEnd(hookEvent)));
    return () => controller.abort();
  },
  // For the unit tests. OpenCode reads only `id` and `setup`.
  helpers: { extractEvent, extractToolDetail, extractToolStartEvent, extractToolEndEvent, createV2SessionTracker, hookRecordFor, publishToHookDirectory },
};
