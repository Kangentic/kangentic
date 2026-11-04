import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pluginExports from '../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs';
import { KangenticActivity } from '../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import type { SessionEvent } from '../../src/shared/types';

// The helpers ride on the plugin, not on the module's exports (see the next test).
const {
  extractSessionEvent,
  extractToolDetail,
  extractToolStartEvent,
  extractToolEndEvent,
  extractWaitEvent,
  createSessionTracker,
} = KangenticActivity.helpers;

const fixturePath = path.join(__dirname, '..', 'fixtures', 'opencode-plugin-events.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

const FIXED_TIMESTAMP = 1717000000000;

interface PluginHooks {
  event: (payload: { event: unknown }) => Promise<void>;
  'chat.message': (input: unknown) => Promise<void>;
  'chat.params': (input: unknown) => Promise<void>;
  'experimental.session.compacting': (input: unknown) => Promise<void>;
  'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
  'tool.execute.after': (input: unknown) => Promise<void>;
}

interface PluginModule {
  KangenticActivity: () => Promise<PluginHooks>;
}

describe('opencode-plugin', () => {
  describe('the module OpenCode loads', () => {
    it('exports the plugin and nothing else, since OpenCode calls every export as a plugin', () => {
      // OpenCode 1.18.31's loader walks Object.values(module), calls each
      // function as a plugin factory and throws on any other value. An exported
      // helper would run as a plugin and leave its return value among the hooks.
      expect(Object.keys(pluginExports)).toEqual(['KangenticActivity']);
      expect(typeof pluginExports.KangenticActivity).toBe('function');
    });
  });

  describe('extractSessionEvent', () => {
    it('maps session.created to session_start with sessionID hookContext', () => {
      const result = extractSessionEvent(fixtures.event_session_created, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }),
      });
    });

    it('maps session.idle to idle', () => {
      const result = extractSessionEvent(fixtures.event_session_idle, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'idle' });
    });

    it('maps session.error to idle with detail=error', () => {
      const result = extractSessionEvent(fixtures.event_session_error, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'error' });
    });

    it('returns null for unrecognized session event types', () => {
      const result = extractSessionEvent(fixtures.event_session_unknown, FIXED_TIMESTAMP);

      expect(result).toBeNull();
    });

    it('returns null when event is null/undefined/non-object', () => {
      expect(extractSessionEvent(null, FIXED_TIMESTAMP)).toBeNull();
      expect(extractSessionEvent(undefined, FIXED_TIMESTAMP)).toBeNull();
      expect(extractSessionEvent('string', FIXED_TIMESTAMP)).toBeNull();
    });

    it('handles session.created without properties.info gracefully', () => {
      const event = { type: 'session.created', properties: {} };
      const result = extractSessionEvent(event, FIXED_TIMESTAMP);

      // No sessionID anywhere -> session_start without hookContext
      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'session_start' });
    });

    it('falls back to properties.sessionID when properties.info.id is missing', () => {
      const event = {
        type: 'session.created',
        properties: { sessionID: 'ses_fallback123' },
      };
      const result = extractSessionEvent(event, FIXED_TIMESTAMP);

      expect(result?.hookContext).toBe(JSON.stringify({ sessionID: 'ses_fallback123' }));
    });
  });

  describe('extractWaitEvent', () => {
    it('maps question.asked to a question wait', () => {
      expect(extractWaitEvent(fixtures.event_question_asked, FIXED_TIMESTAMP))
        .toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'question' });
    });

    it('maps permission.asked to an approval wait', () => {
      expect(extractWaitEvent(fixtures.event_permission_asked, FIXED_TIMESTAMP))
        .toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'approval' });
    });

    it('logs each answer as a notification, never as an idle a turn end would read', () => {
      for (const fixture of [fixtures.event_question_replied, fixtures.event_question_rejected, fixtures.event_permission_replied]) {
        expect(extractWaitEvent(fixture, FIXED_TIMESTAMP)).toEqual({ ts: FIXED_TIMESTAMP, type: 'notification', detail: fixture.type });
      }
    });

    it('returns null for every other event, and for a non-object', () => {
      expect(extractWaitEvent(fixtures.event_session_idle, FIXED_TIMESTAMP)).toBeNull();
      expect(extractWaitEvent(null, FIXED_TIMESTAMP)).toBeNull();
      expect(extractWaitEvent('question.asked', FIXED_TIMESTAMP)).toBeNull();
    });

    it('a session event is never read as a wait, so the event hook writes one line at most', () => {
      for (const fixture of [fixtures.event_session_created, fixtures.event_session_idle, fixtures.event_session_error]) {
        expect(extractWaitEvent(fixture, FIXED_TIMESTAMP)).toBeNull();
      }
    });

    it('in OpenCode\'s order (tool start, wait, tool end) the wait shows and its tool\'s end clears it', () => {
      // OpenCode 1.18.31 triggers tool.execute.before, then runs the tool, whose `ask`
      // publishes the request, then triggers tool.execute.after (also after a throw).
      const engine = new ActivityEngine({ onActivityChange() { /* unused */ } }, { idleStabilityWindowMs: 0 });
      const sessionId = 'opencode-session';
      engine.initSession(sessionId);
      const feed = (event: SessionEvent | null): void => { if (event) engine.processEvent(sessionId, event); };

      feed(extractToolStartEvent({ tool: 'question' }, { args: {} }, FIXED_TIMESTAMP) as SessionEvent);
      feed(extractWaitEvent(fixtures.event_question_asked, FIXED_TIMESTAMP + 1) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('permission');
      expect(engine.getState(sessionId)?.permissionWaitKind).toBe('question');

      feed(extractWaitEvent(fixtures.event_question_replied, FIXED_TIMESTAMP + 2) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('permission');

      feed(extractToolEndEvent({ tool: 'question' }, FIXED_TIMESTAMP + 3) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('thinking');
      expect(engine.getState(sessionId)?.permissionWaitKind).toBeNull();
      engine.dispose();
    });
  });

  describe('the KangenticActivity event hook', () => {
    // The module reads KANGENTIC_EVENTS_PATH once, at load, so each test points
    // it at its own temp file and loads a fresh copy of the plugin after.
    let eventsDirectory: string;
    let eventsFilePath: string;
    let previousEventsPath: string | undefined;

    beforeEach(() => {
      previousEventsPath = process.env.KANGENTIC_EVENTS_PATH;
      eventsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-events-'));
      eventsFilePath = path.join(eventsDirectory, 'events.jsonl');
      process.env.KANGENTIC_EVENTS_PATH = eventsFilePath;
      vi.resetModules();
    });

    afterEach(() => {
      if (previousEventsPath === undefined) {
        delete process.env.KANGENTIC_EVENTS_PATH;
      } else {
        process.env.KANGENTIC_EVENTS_PATH = previousEventsPath;
      }
      fs.rmSync(eventsDirectory, { recursive: true, force: true });
      vi.resetModules();
    });

    async function loadHooks(): Promise<PluginHooks> {
      const pluginModule = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs') as unknown as PluginModule;
      return pluginModule.KangenticActivity();
    }

    function readEvents(): unknown[] {
      if (!fs.existsSync(eventsFilePath)) return [];
      return fs.readFileSync(eventsFilePath, 'utf-8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown);
    }

    it('writes a question wait, an approval wait, and a plain idle as one line each, in order', async () => {
      const hooks = await loadHooks();

      await hooks.event({ event: fixtures.event_question_asked });
      await hooks.event({ event: fixtures.event_permission_asked });
      await hooks.event({ event: fixtures.event_session_idle });

      // Exact shapes: the idle line must carry no detail or waitKind of its own.
      expect(readEvents()).toEqual([
        { ts: expect.any(Number), type: 'idle', detail: 'permission', waitKind: 'question' },
        { ts: expect.any(Number), type: 'idle', detail: 'permission', waitKind: 'approval' },
        { ts: expect.any(Number), type: 'idle' },
      ]);
    });

    it('writes nothing for an event that is neither a session event nor a wait', async () => {
      const hooks = await loadHooks();

      await hooks.event({ event: fixtures.event_session_unknown });

      expect(readEvents()).toEqual([]);
    });

    it('writes the prompt, the subagent around its tools, and one root idle, in order', async () => {
      const hooks = await loadHooks();

      await hooks.event({ event: fixtures.event_session_created });
      await hooks['chat.message'](fixtures.chat_message_root);
      await hooks['tool.execute.before'](fixtures.tool_before_task.input, fixtures.tool_before_task.output);
      await hooks.event({ event: fixtures.event_child_session_created });
      await hooks['chat.message']({ ...fixtures.chat_message_root, sessionID: 'ses_child0000000000000000aa', agent: 'explore' });
      await hooks['tool.execute.before'](fixtures.tool_before_child_grep.input, fixtures.tool_before_child_grep.output);
      await hooks['tool.execute.after'](fixtures.tool_after_child_grep.input);
      await hooks.event({ event: fixtures.event_child_session_idle });
      await hooks['tool.execute.after'](fixtures.tool_after_task.input);
      await hooks.event({ event: fixtures.event_session_idle });

      expect(readEvents().map((line) => {
        const { ts: _ts, hookContext: _hookContext, detail: _detail, ...rest } = line as Record<string, unknown>;
        return rest;
      })).toEqual([
        { type: 'session_start' },
        { type: 'prompt' },
        { type: 'tool_start', tool: 'task', toolId: 'call_task_1' },
        { type: 'subagent_start', subagentId: 'ses_child0000000000000000aa' },
        { type: 'tool_start', tool: 'grep', toolId: 'call_grep_1', subagentId: 'ses_child0000000000000000aa' },
        { type: 'tool_end', tool: 'grep', toolId: 'call_grep_1', subagentId: 'ses_child0000000000000000aa' },
        { type: 'subagent_stop', subagentId: 'ses_child0000000000000000aa' },
        { type: 'tool_end', tool: 'task', toolId: 'call_task_1' },
        { type: 'idle' },
      ]);
    });

    it('keeps status.json beside events.jsonl, rewritten whole as messages update', async () => {
      const hooks = await loadHooks();
      const statusPath = path.join(eventsDirectory, 'status.json');

      await hooks['chat.params'](fixtures.chat_params_root);
      await hooks.event({ event: fixtures.event_message_updated_root_1 });
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf-8')).context.input).toBe(1200);

      await hooks.event({ event: fixtures.event_message_updated_root_2 });
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      expect(status.context).toEqual({ input: 600, output: 900, reasoning: 0, cacheRead: 9600, cacheWrite: 200 });
      // Written in place, as the reader's watch on the file expects.
      expect(fs.readdirSync(eventsDirectory).sort()).toEqual(['status.json']);
    });

    it('writes a compact line when the compacting hook fires, for the root session only', async () => {
      const hooks = await loadHooks();
      await hooks.event({ event: fixtures.event_child_session_created });

      await hooks['experimental.session.compacting']({ sessionID: 'ses_child0000000000000000aa' });
      expect(readEvents().filter((line) => (line as { type: string }).type === 'compact')).toEqual([]);

      await hooks['experimental.session.compacting']({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' });
      expect(readEvents().filter((line) => (line as { type: string }).type === 'compact')).toEqual([
        { ts: expect.any(Number), type: 'compact' },
      ]);
    });

    it('writes status.json from chat.params alone, and rewrites it only when something changed', async () => {
      const hooks = await loadHooks();
      const statusPath = path.join(eventsDirectory, 'status.json');

      await hooks['chat.params'](fixtures.chat_params_root);
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      expect(status.model).toEqual({ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' });
      expect(status.contextLimit).toBe(200000);

      // Nothing changed: neither the same params again nor an idle may recreate the file.
      fs.rmSync(statusPath);
      await hooks['chat.params'](fixtures.chat_params_root);
      await hooks.event({ event: fixtures.event_session_idle });
      expect(fs.existsSync(statusPath)).toBe(false);

      // A changed number does rewrite it.
      await hooks.event({ event: fixtures.event_message_updated_root_1 });
      expect(fs.existsSync(statusPath)).toBe(true);
    });
  });

  describe('createSessionTracker', () => {
    it('reads a child session (parentID) as a subagent, never as the task\'s own start or idle', () => {
      const tracker = createSessionTracker();
      expect(tracker.onEvent(fixtures.event_session_created, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'session_start', hookContext: JSON.stringify({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }) },
      ]);
      expect(tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'subagent_start', subagentId: 'ses_child0000000000000000aa' },
      ]);
      expect(tracker.onEvent(fixtures.event_child_session_idle, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'subagent_stop', subagentId: 'ses_child0000000000000000aa' },
      ]);
      // A second idle of the same child stops nothing.
      expect(tracker.onEvent(fixtures.event_child_session_idle, FIXED_TIMESTAMP)).toEqual([]);
    });

    it('starts a continued child again when it turns busy, with no second session.created', () => {
      const tracker = createSessionTracker();
      tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP);
      tracker.onEvent(fixtures.event_child_session_idle, FIXED_TIMESTAMP);
      expect(tracker.onEvent(fixtures.event_child_session_busy, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'subagent_start', subagentId: 'ses_child0000000000000000aa' },
      ]);
      // A busy root is nothing to report.
      expect(tracker.onEvent({ type: 'session.status', properties: { sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq', status: { type: 'busy' } } }, FIXED_TIMESTAMP)).toEqual([]);
    });

    it('stops every subagent still open before the root\'s idle', () => {
      const tracker = createSessionTracker();
      tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP);
      expect(tracker.onEvent(fixtures.event_session_idle, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'subagent_stop', subagentId: 'ses_child0000000000000000aa' },
        { ts: FIXED_TIMESTAMP, type: 'idle' },
      ]);
    });

    it('writes a prompt and a compaction for the root session only', () => {
      const tracker = createSessionTracker();
      tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP);
      expect(tracker.onChatMessage(fixtures.chat_message_root, FIXED_TIMESTAMP)).toEqual({ ts: FIXED_TIMESTAMP, type: 'prompt' });
      expect(tracker.onChatMessage({ sessionID: 'ses_child0000000000000000aa' }, FIXED_TIMESTAMP)).toBeNull();
      expect(tracker.onCompacting({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }, FIXED_TIMESTAMP)).toEqual({ ts: FIXED_TIMESTAMP, type: 'compact' });
      expect(tracker.onCompacting({ sessionID: 'ses_child0000000000000000aa' }, FIXED_TIMESTAMP)).toBeNull();
    });

    it('pairs a tool\'s start and end by OpenCode\'s callID', () => {
      const tracker = createSessionTracker();
      expect(tracker.onToolBefore(fixtures.tool_before_task.input, fixtures.tool_before_task.output, FIXED_TIMESTAMP))
        .toMatchObject({ type: 'tool_start', tool: 'task', toolId: 'call_task_1' });
      expect(tracker.onToolAfter(fixtures.tool_after_task.input, FIXED_TIMESTAMP))
        .toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end', tool: 'task', toolId: 'call_task_1' });
    });

    it('a subagent\'s finished turn no longer ends the task\'s turn', () => {
      // Before the tracker, a child's session.idle was written as the task's idle,
      // which cleared the running `task` tool and read as the turn's end.
      const engine = new ActivityEngine({ onActivityChange() { /* unused */ } }, { idleStabilityWindowMs: 0 });
      const sessionId = 'opencode-subagent-session';
      engine.initSession(sessionId);
      const tracker = createSessionTracker();
      const feed = (lines: Array<SessionEvent | null>): void => {
        for (const line of lines) if (line) engine.processEvent(sessionId, line);
      };

      feed([tracker.onChatMessage(fixtures.chat_message_root, FIXED_TIMESTAMP) as SessionEvent]);
      feed([tracker.onToolBefore(fixtures.tool_before_task.input, fixtures.tool_before_task.output, FIXED_TIMESTAMP + 1) as SessionEvent]);
      feed(tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP + 2) as SessionEvent[]);
      feed(tracker.onEvent(fixtures.event_child_session_idle, FIXED_TIMESTAMP + 3) as SessionEvent[]);
      expect(engine.getState(sessionId)?.activity).toBe('thinking');

      feed([tracker.onToolAfter(fixtures.tool_after_task.input, FIXED_TIMESTAMP + 4) as SessionEvent]);
      feed(tracker.onEvent(fixtures.event_session_idle, FIXED_TIMESTAMP + 5) as SessionEvent[]);
      expect(engine.getState(sessionId)?.activity).toBe('idle');
      engine.dispose();
    });

    it('knows a child from session.updated carrying parentID, and a child\'s error and waits are written', () => {
      const tracker = createSessionTracker();
      const childId = 'ses_child0000000000000000bb';
      // Learned from session.updated: no start line yet, and it is no root session_start.
      expect(tracker.onEvent({ type: 'session.updated', properties: { info: { id: childId, parentID: 'ses_2349b5c91ffeKd6qajuUTR4clq' } } }, FIXED_TIMESTAMP)).toEqual([]);
      expect(tracker.onChatMessage({ sessionID: childId }, FIXED_TIMESTAMP)).toBeNull();
      expect(tracker.onToolBefore({ tool: 'grep', sessionID: childId }, { args: {} }, FIXED_TIMESTAMP)).toMatchObject({ subagentId: childId });

      tracker.onEvent({ type: 'session.status', properties: { sessionID: childId, status: { type: 'busy' } } }, FIXED_TIMESTAMP);
      // A subagent's wait on the user is written whichever session asked.
      expect(tracker.onEvent({ type: 'question.asked', properties: { sessionID: childId } }, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'question' },
      ]);
      expect(tracker.onEvent({ type: 'permission.asked', properties: { sessionID: childId } }, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'approval' },
      ]);
      expect(tracker.onEvent({ type: 'session.error', properties: { sessionID: childId } }, FIXED_TIMESTAMP)).toEqual([
        { ts: FIXED_TIMESTAMP, type: 'subagent_stop', subagentId: childId },
      ]);
    });

    describe('status()', () => {
      function rootAnswer(messageId: string, created: number, modelID: string, input: number) {
        return {
          type: 'message.updated',
          properties: {
            info: {
              id: messageId, sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq', role: 'assistant', providerID: 'anthropic', modelID,
              time: { created }, cost: 0,
              tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        };
      }

      it('keeps the context on the previous answer when a newer one opens with every token count 0', () => {
        const tracker = createSessionTracker();
        tracker.onEvent(rootAnswer('msg_a', 1000, 'model-a', 500), FIXED_TIMESTAMP);
        tracker.onEvent(rootAnswer('msg_b', 2000, 'model-b', 0), FIXED_TIMESTAMP);
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/model-b' });
        expect(tracker.status()?.context.input).toBe(500);

        tracker.onEvent(rootAnswer('msg_b', 2000, 'model-b', 700), FIXED_TIMESTAMP);
        expect(tracker.status()?.context.input).toBe(700);
      });

      it('does not move the model or context back when an older answer is sent again', () => {
        const tracker = createSessionTracker();
        tracker.onEvent(rootAnswer('msg_a', 1000, 'model-a', 500), FIXED_TIMESTAMP);
        tracker.onEvent(rootAnswer('msg_b', 2000, 'model-b', 700), FIXED_TIMESTAMP);
        tracker.onEvent(rootAnswer('msg_a', 1000, 'model-a', 900), FIXED_TIMESTAMP);
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/model-b' });
        expect(tracker.status()?.context.input).toBe(700);
        // The older answer's numbers still count toward the totals.
        expect(tracker.status()?.totals.input).toBe(1600);
      });

      it('reports no change for a repeated answer or a repeated chat.params, and a change for a new number', () => {
        const tracker = createSessionTracker();
        tracker.onChatParams(fixtures.chat_params_root);
        tracker.onEvent(fixtures.event_message_updated_root_1, FIXED_TIMESTAMP);
        expect(tracker.takeStatusChange()).toBe(true);

        tracker.onEvent(structuredClone(fixtures.event_message_updated_root_1), FIXED_TIMESTAMP);
        tracker.onChatParams(structuredClone(fixtures.chat_params_root));
        expect(tracker.takeStatusChange()).toBe(false);

        const costlier = structuredClone(fixtures.event_message_updated_root_1);
        costlier.properties.info.cost = 0.5;
        tracker.onEvent(costlier, FIXED_TIMESTAMP);
        expect(tracker.takeStatusChange()).toBe(true);

        const larger = structuredClone(fixtures.chat_params_root);
        larger.model.limit.context = 400000;
        tracker.onChatParams(larger);
        expect(tracker.takeStatusChange()).toBe(true);
      });

      it('is null until a model is known', () => {
        expect(createSessionTracker().status()).toBeNull();
      });

      it('takes the model from chat.params, the context from the root\'s newest answer, and cost from every session', () => {
        const tracker = createSessionTracker();
        tracker.onEvent(fixtures.event_child_session_created, FIXED_TIMESTAMP);
        tracker.onChatParams(fixtures.chat_params_root);
        for (const event of [fixtures.event_message_updated_user, fixtures.event_message_updated_root_1, fixtures.event_message_updated_child, fixtures.event_message_updated_root_2]) {
          tracker.onEvent(event, FIXED_TIMESTAMP);
        }
        const status = tracker.status();
        expect(status).toEqual({
          kangenticOpenCodeStatus: 1,
          model: { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
          contextLimit: 200000,
          context: { input: 600, output: 900, reasoning: 0, cacheRead: 9600, cacheWrite: 200 },
          totals: { input: 1800, output: 1200, reasoning: 50, cacheRead: 17600, cacheWrite: 600 },
          costUsd: expect.closeTo(0.035, 10),
        });
      });

      it('counts a message streamed twice once, at its latest numbers', () => {
        const tracker = createSessionTracker();
        tracker.onEvent(fixtures.event_message_updated_root_1, FIXED_TIMESTAMP);
        const grown = structuredClone(fixtures.event_message_updated_root_1);
        grown.properties.info.tokens.output = 700;
        tracker.onEvent(grown, FIXED_TIMESTAMP);
        expect(tracker.status()?.totals.output).toBe(700);
        // No chat.params seen (a resumed session's first answer): the answer names the model.
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/claude-sonnet-4-5' });
        expect(tracker.status()?.contextLimit).toBe(0);
      });

      it('shows the model the newest answer came from, not the last chat.params', () => {
        // A hidden agent (title, summary) may request another model; until that
        // model answers in the session, the card keeps the one that did.
        const tracker = createSessionTracker();
        tracker.onChatParams(fixtures.chat_params_root);
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' });
        tracker.onEvent(fixtures.event_message_updated_root_1, FIXED_TIMESTAMP);
        tracker.onChatParams({
          ...fixtures.chat_params_root,
          model: { id: 'claude-haiku-4-5', providerID: 'anthropic', name: 'Claude Haiku 4.5', limit: { context: 100000, output: 8000 } },
        });
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' });
        expect(tracker.status()?.contextLimit).toBe(200000);

        // The switched model answering moves the card to it, named and sized by its own chat.params.
        const switched = structuredClone(fixtures.event_message_updated_root_2);
        switched.properties.info.modelID = 'claude-haiku-4-5';
        tracker.onEvent(switched, FIXED_TIMESTAMP);
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' });
        expect(tracker.status()?.contextLimit).toBe(100000);
      });

      it('registers a child\'s model name and size without showing it, until a root answer names that model', () => {
        const tracker = createSessionTracker();
        const rootId = 'ses_2349b5c91ffeKd6qajuUTR4clq';
        const childId = 'ses_child0000000000000000cc';
        const paramsFor = (sessionID: string, id: string, name: string, context: number) => ({
          sessionID,
          model: { providerID: 'anthropic', id, name, limit: { context } },
        });
        tracker.onEvent({ type: 'session.created', properties: { info: { id: childId, parentID: rootId } } }, FIXED_TIMESTAMP);

        tracker.onChatParams(paramsFor(rootId, 'model-a', 'Model A', 200000));
        expect(tracker.takeStatusChange()).toBe(true);
        tracker.onChatParams(paramsFor(childId, 'model-b', 'Model B', 100000));
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/model-a', name: 'Model A' });
        expect(tracker.status()?.contextLimit).toBe(200000);

        // The root's answer from model B shows it, with the name and size the child's params registered.
        tracker.onEvent(rootAnswer('msg_b', 2000, 'model-b', 300), FIXED_TIMESTAMP);
        expect(tracker.status()?.model).toEqual({ id: 'anthropic/model-b', name: 'Model B' });
        expect(tracker.status()?.contextLimit).toBe(100000);
      });

      it('says when it changed, once', () => {
        const tracker = createSessionTracker();
        expect(tracker.takeStatusChange()).toBe(false);
        tracker.onEvent(fixtures.event_message_updated_root_1, FIXED_TIMESTAMP);
        expect(tracker.takeStatusChange()).toBe(true);
        expect(tracker.takeStatusChange()).toBe(false);
        tracker.onEvent(fixtures.event_session_idle, FIXED_TIMESTAMP);
        expect(tracker.takeStatusChange()).toBe(false);
      });
    });
  });

  describe('extractToolDetail', () => {
    it('extracts command for shell tools', () => {
      expect(extractToolDetail(fixtures.tool_before_bash.output.args)).toBe('ls -la /tmp');
    });

    it('extracts filePath for file-read tools', () => {
      expect(extractToolDetail(fixtures.tool_before_read.output.args)).toBe('/repo/src/main.ts');
    });

    it('extracts path for glob/grep tools (preferred over pattern)', () => {
      expect(extractToolDetail(fixtures.tool_before_glob.output.args)).toBe('/repo');
    });

    it('keeps a long command whole below the field cap, and truncates at 2000 characters', () => {
      // The cap is sized for a Bash command, which the git push capture reads
      // for its content (a chained commit-and-push lost its push at the old
      // 200). tests/unit/hook-detail-cap-parity.test.ts pins the value against
      // the hook bridge's.
      const longCommand = extractToolDetail(fixtures.tool_before_long_command.output.args);
      expect(longCommand).toBe(fixtures.tool_before_long_command.output.args.command);
      expect(longCommand!.length).toBeGreaterThan(200);

      const capped = extractToolDetail({ command: 'a'.repeat(2500) });
      expect(capped).toBeDefined();
      expect(capped!.length).toBe(2000);
    });

    it('returns undefined for empty args', () => {
      expect(extractToolDetail(fixtures.tool_before_no_args.output.args)).toBeUndefined();
    });

    it('returns undefined for null/non-object args', () => {
      expect(extractToolDetail(null)).toBeUndefined();
      expect(extractToolDetail(undefined)).toBeUndefined();
      expect(extractToolDetail('string')).toBeUndefined();
    });
  });

  describe('extractToolStartEvent', () => {
    it('builds tool_start with tool name and detail from a bash invocation', () => {
      const fixture = fixtures.tool_before_bash;
      const result = extractToolStartEvent(fixture.input, fixture.output, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        tool: 'bash',
        detail: 'ls -la /tmp',
      });
    });

    it('omits detail when args contain no recognized field', () => {
      const fixture = fixtures.tool_before_no_args;
      const result = extractToolStartEvent(fixture.input, fixture.output, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        tool: 'list',
      });
      expect('detail' in result).toBe(false);
    });

    it('omits tool when input.tool is missing', () => {
      const result = extractToolStartEvent({}, { args: { command: 'echo hi' } }, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        detail: 'echo hi',
      });
    });
  });

  describe('extractToolEndEvent', () => {
    it('builds tool_end with tool name', () => {
      const result = extractToolEndEvent(fixtures.tool_after_bash.input, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end', tool: 'bash' });
    });

    it('omits tool when input.tool is missing', () => {
      const result = extractToolEndEvent({}, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end' });
    });

    it('handles undefined input', () => {
      const result = extractToolEndEvent(undefined, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end' });
    });
  });
});
