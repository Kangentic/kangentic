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
// It also keeps the session's `status.json` beside that file (model,
// context, tokens and cost), which the adapter's `parseOpenCodeStatus` reads
// (not on a remote host, which has no events path to put it beside).
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
//
// Hook and event shapes are OpenCode 1.18.31's own: the `Hooks` interface in
// `packages/plugin/src/index.ts` and the `Event` union of `@opencode-ai/sdk`
// (`packages/sdk/js/src/gen/types.gen.ts`), both at tag v1.18.31. The subagent,
// prompt, compaction and telemetry mappings below were built from those types
// and have not been run against a real OpenCode session.
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
 *
 * These are the ROOT session's lines; `createSessionTracker` decides first
 * whether the event belongs to a `task` subagent's child session.
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
 * A subagent's wait is a wait on the user too, so it is written whichever
 * session asked.
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

/** The call id OpenCode hands both tool hooks (`input.callID`), which pairs a start with its end. */
function toolIdOf(input) {
  const callID = input && typeof input === 'object' ? input.callID : undefined;
  return typeof callID === 'string' && callID.length > 0 ? callID : undefined;
}

/**
 * Extract a `tool_start` event from OpenCode's `tool.execute.before`
 * (input, output) handler arguments. `input` is `{ tool, sessionID, callID }`.
 */
function extractToolStartEvent(input, output, now = Date.now()) {
  const detail = extractToolDetail(output?.args);
  const toolId = toolIdOf(input);
  return {
    ts: now,
    type: 'tool_start',
    ...(input?.tool ? { tool: input.tool } : {}),
    ...(toolId ? { toolId } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Extract a `tool_end` event from OpenCode's `tool.execute.after` input,
 * `{ tool, sessionID, callID, args }`.
 */
function extractToolEndEvent(input, now = Date.now()) {
  const toolId = toolIdOf(input);
  return {
    ts: now,
    type: 'tool_end',
    ...(input?.tool ? { tool: input.tool } : {}),
    ...(toolId ? { toolId } : {}),
  };
}

// The V2 plugin (kangentic-activity-v2.mjs) keeps its own copy of the helpers
// below and of the status shape: each plugin is one file OpenCode loads alone.
// Edit the two together.
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `providerID/modelID`, the form `--model` takes, or null without a model id. */
function modelKey(providerID, modelID) {
  const model = nonEmptyString(modelID);
  if (!model) return null;
  const provider = nonEmptyString(providerID);
  return provider ? `${provider}/${model}` : model;
}

/** An assistant message's `tokens` (`AssistantMessage.tokens` in the SDK types). */
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
 * One OpenCode process's sessions, as the plugin sees them. OpenCode's `task`
 * tool runs a subagent in a CHILD session, created with `parentID` set
 * (`Session.parentID` in the SDK types), and the `event` hook receives every
 * session's events with no filter (`packages/opencode/src/plugin/index.ts`).
 * A child's `session.created` and `session.idle` write `subagent_start` and
 * `subagent_stop`, keyed by the child's session id, never the task's own
 * `session_start` or `idle`, so the task's turn does not end while the
 * subagent runs.
 *
 * A session is a child once a `session.created` or `session.updated` shows its
 * `parentID`; every other session is the root (the TUI's own session, or the
 * one a resume opened, which raises no `session.created`).
 *
 * The tracker also folds `chat.params` and `message.updated` into the
 * session's live telemetry (`status()`): the model the root's newest answer
 * came from (`providerID`, `modelID`), named and sized by the `Model` a
 * `chat.params` input carried for it (`name`, `limit.context`), and each
 * assistant message's `tokens` and `cost` from `message.updated`. Tokens and
 * context are the root's; cost adds the subagents', since they are paid too.
 * OpenCode stores an answer when its step starts, with every token count 0,
 * and updates it as the step ends, so the context is the newest root answer
 * that has any usage: a just-opened answer does not reset the bar to 0.
 */
function createSessionTracker() {
  const childSessions = new Set();
  const openChildren = new Set();
  // `providerID/modelID` -> `{ name, contextLimit }`, from every `chat.params`.
  const modelFacts = new Map();
  // The model of the root's newest `chat.params`, shown until an answer names one.
  let requestedModel = null;
  const rootTokensByMessage = new Map();
  const costByMessage = new Map();
  // The root's newest answer (its model is the one shown), and its newest with usage (the context).
  let lastRootMessage = null;
  let contextMessage = null;
  let statusDirty = false;

  function learnSession(info) {
    if (!info || typeof info !== 'object') return null;
    const id = nonEmptyString(info.id);
    if (id && nonEmptyString(info.parentID)) childSessions.add(id);
    return id;
  }

  function isChild(sessionID) {
    return typeof sessionID === 'string' && childSessions.has(sessionID);
  }

  function startChild(sessionID, now) {
    if (openChildren.has(sessionID)) return [];
    openChildren.add(sessionID);
    return [{ ts: now, type: 'subagent_start', subagentId: sessionID }];
  }

  function stopChild(sessionID, now) {
    if (!openChildren.delete(sessionID)) return [];
    return [{ ts: now, type: 'subagent_stop', subagentId: sessionID }];
  }

  function sameTokens(first, second) {
    return Boolean(first && second) && Object.keys(first).every((key) => first[key] === second[key]);
  }

  function noteAssistantMessage(info) {
    if (!info || typeof info !== 'object' || info.role !== 'assistant') return;
    const messageID = nonEmptyString(info.id);
    if (!messageID) return;
    // OpenCode re-sends an answer on every update; only a changed number rewrites status.json.
    const cost = finiteNumber(info.cost);
    if (costByMessage.get(messageID) !== cost) {
      costByMessage.set(messageID, cost);
      statusDirty = true;
    }
    if (isChild(info.sessionID)) return;
    const tokens = readTokens(info.tokens);
    if (!sameTokens(rootTokensByMessage.get(messageID), tokens)) {
      rootTokensByMessage.set(messageID, tokens);
      statusDirty = true;
    }
    const created = finiteNumber(info.time?.created);
    const model = modelKey(info.providerID, info.modelID);
    if (!lastRootMessage || created >= lastRootMessage.created) {
      if (lastRootMessage?.id !== messageID || lastRootMessage.model !== model) statusDirty = true;
      lastRootMessage = { id: messageID, created, model };
    }
    const hasUsage = Object.values(tokens).some((count) => count > 0);
    if (hasUsage && (!contextMessage || created >= contextMessage.created)) {
      if (contextMessage?.id !== messageID) statusDirty = true;
      contextMessage = { id: messageID, created };
    }
  }

  return {
    /** Lines for one `event` hook payload. */
    onEvent(event, now = Date.now()) {
      if (!event || typeof event !== 'object') return [];
      const eventType = event.type;
      const properties = event.properties && typeof event.properties === 'object' ? event.properties : {};
      if (eventType === 'session.created' || eventType === 'session.updated') {
        const sessionID = learnSession(properties.info);
        if (sessionID && isChild(sessionID)) return eventType === 'session.created' ? startChild(sessionID, now) : [];
        const line = extractSessionEvent(event, now);
        return line ? [line] : [];
      }
      if (eventType === 'session.status') {
        // A child the `task` tool continues (its `task_id` parameter) raises
        // no second `session.created`, only `busy` again.
        const sessionID = properties.sessionID;
        if (isChild(sessionID) && properties.status?.type === 'busy') return startChild(sessionID, now);
        return [];
      }
      if (eventType === 'session.idle' || eventType === 'session.error') {
        const sessionID = properties.sessionID;
        if (isChild(sessionID)) return stopChild(sessionID, now);
        // The root's turn is over, so no subagent of it is still running.
        const lines = [];
        for (const child of [...openChildren]) lines.push(...stopChild(child, now));
        const line = extractSessionEvent(event, now);
        if (line) lines.push(line);
        return lines;
      }
      if (eventType === 'message.updated') {
        noteAssistantMessage(properties.info);
        return [];
      }
      const wait = extractWaitEvent(event, now);
      return wait ? [wait] : [];
    },

    /** `tool.execute.before`: a subagent's call names its child session. */
    onToolBefore(input, output, now = Date.now()) {
      const line = extractToolStartEvent(input, output, now);
      return isChild(input?.sessionID) ? { ...line, subagentId: input.sessionID } : line;
    },

    /** `tool.execute.after`. */
    onToolAfter(input, now = Date.now()) {
      const line = extractToolEndEvent(input, now);
      return isChild(input?.sessionID) ? { ...line, subagentId: input.sessionID } : line;
    },

    /**
     * `chat.message`, `{ sessionID, agent?, model?, messageID? }`: the user's
     * message reached the root session, which starts its turn. A subagent's
     * prompt is the `task` tool's, inside a turn already running.
     */
    onChatMessage(input, now = Date.now()) {
      if (!input || typeof input !== 'object' || isChild(input.sessionID)) return null;
      return { ts: now, type: 'prompt' };
    },

    /**
     * `experimental.session.compacting`, `{ sessionID }`: called before
     * OpenCode compacts a session's context (the plugin docs' compaction hook).
     */
    onCompacting(input, now = Date.now()) {
      if (!input || typeof input !== 'object' || isChild(input.sessionID)) return null;
      return { ts: now, type: 'compact' };
    },

    /**
     * `chat.params`, `{ sessionID, agent, model: Model, provider, message }`.
     * Its model names and sizes a model; which model the session shows is the
     * one its newest answer came from, since nothing documents that only the
     * main agent's requests pass through here (OpenCode's hidden title,
     * summary and compaction agents may use another model).
     */
    onChatParams(input) {
      if (!input || typeof input !== 'object') return;
      const chosen = input.model;
      if (!chosen || typeof chosen !== 'object') return;
      const key = modelKey(chosen.providerID, chosen.id);
      if (!key) return;
      const facts = { name: nonEmptyString(chosen.name), contextLimit: finiteNumber(chosen.limit?.context) };
      const known = modelFacts.get(key);
      if (!known || known.name !== facts.name || known.contextLimit !== facts.contextLimit) {
        modelFacts.set(key, facts);
        statusDirty = true;
      }
      if (!isChild(input.sessionID) && requestedModel !== key) {
        requestedModel = key;
        statusDirty = true;
      }
    },

    /** `onEvent` folded a message, or `onChatParams` a model, since the last call. */
    takeStatusChange() {
      const changed = statusDirty;
      statusDirty = false;
      return changed;
    },

    /**
     * The session's telemetry as `status.json` holds it, or null before a model
     * is known. `context` is the root's newest assistant message with usage:
     * what it sent (`input` plus the cache reads and writes) is the context in use.
     */
    status() {
      const shownModel = lastRootMessage?.model ?? requestedModel;
      if (!shownModel) return null;
      const facts = modelFacts.get(shownModel);
      const totals = readTokens(undefined);
      for (const tokens of rootTokensByMessage.values()) {
        for (const key of Object.keys(totals)) totals[key] += tokens[key];
      }
      let costUsd = 0;
      for (const cost of costByMessage.values()) costUsd += cost;
      const last = contextMessage ? rootTokensByMessage.get(contextMessage.id) : null;
      return {
        kangenticOpenCodeStatus: 1,
        model: {
          id: shownModel,
          ...(facts?.name ? { name: facts.name } : {}),
        },
        contextLimit: facts?.contextLimit ?? 0,
        context: last ?? readTokens(undefined),
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

// The session's status file sits beside its events file
// (`.kangentic/sessions/<id>/status.json`, transition-engine/session-paths.ts),
// so it needs no variable of its own, and in a WSL distro it is already the
// path the distro sees.
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

/**
 * Rewrite the status file whole, in place, as Claude's status bridge does
 * (src/main/agent/status-bridge.js). The reader watches the file itself
 * (pty/readers/file-watcher.ts), and a rename over it would swap the file under
 * that watch. A read that lands mid-write gets bad JSON, which the parser drops;
 * the write's own change event follows with the whole file.
 */
function writeStatus(status) {
  if (!statusPath || !status) return;
  try {
    fs.writeFileSync(statusPath, JSON.stringify(status));
  } catch {
    // Best effort. The session may have ended and its folder gone.
  }
}

export const KangenticActivity = async () => {
  const tracker = createSessionTracker();
  const flushStatus = () => {
    if (tracker.takeStatusChange()) writeStatus(tracker.status());
  };
  return {
    event: async ({ event }) => {
      for (const line of tracker.onEvent(event)) appendEvent(line);
      flushStatus();
    },
    'chat.message': async (input) => {
      appendEvent(tracker.onChatMessage(input));
    },
    'chat.params': async (input) => {
      tracker.onChatParams(input);
      flushStatus();
    },
    'experimental.session.compacting': async (input) => {
      appendEvent(tracker.onCompacting(input));
    },
    'tool.execute.before': async (input, output) => {
      appendEvent(tracker.onToolBefore(input, output));
    },
    'tool.execute.after': async (input) => {
      appendEvent(tracker.onToolAfter(input));
    },
  };
};

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
  createSessionTracker,
};
