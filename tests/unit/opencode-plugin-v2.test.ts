/**
 * OpenCode 2's activity plugin (`plugin/kangentic-activity-v2.mjs`).
 *
 * OpenCode 2 does not run OpenCode 1 plugins, so without this one a V2 session's
 * activity came from PTY silence alone and its session id from a database poll.
 * The event shapes below are the ones OpenCode 2.2.5 handed a probe plugin
 * (`session.execution.*`, `permission.*`, every session event carrying
 * `data.sessionID`) and its tool hooks (`{ tool, sessionID, input, status }`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION = 'ses_e600592c7ffeD6Gcp4un8RyjJ2';

interface PluginEventLine { type: string; hookContext?: string; detail?: string; waitKind?: string; tool?: string }
interface V2Plugin {
  id: string;
  setup(ctx: unknown): Promise<(() => void) | undefined>;
  helpers: {
    extractEvent(event: unknown, isNewSession: (sessionID: string) => boolean): PluginEventLine[];
    extractToolStartEvent(hookEvent: unknown): PluginEventLine;
  };
}

let directory: string;
let eventsPath: string;

/** Import a fresh copy, since the plugin reads `KANGENTIC_EVENTS_PATH` once at module load. */
async function loadPlugin(): Promise<V2Plugin> {
  vi.resetModules();
  const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs');
  return module.default as V2Plugin;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-v2-plugin-'));
  eventsPath = path.join(directory, 'events.jsonl');
  vi.stubEnv('KANGENTIC_EVENTS_PATH', eventsPath);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the OpenCode 2 activity plugin', () => {
  it('is the default export OpenCode 2 loads: an id and a setup function', async () => {
    const plugin = await loadPlugin();
    expect(plugin.id).toBe('kangentic.activity');
    expect(typeof plugin.setup).toBe('function');
  });

  it('maps a turn: session start with the id once, prompt, idle', async () => {
    const { helpers } = await loadPlugin();
    const seen = new Set<string>();
    const isNew = (sessionID: string) => (seen.has(sessionID) ? false : (seen.add(sessionID), true));
    const lines = [
      { type: 'session.inbox.enqueued', data: { sessionID: SESSION } },
      { type: 'session.execution.started', data: { sessionID: SESSION } },
      { type: 'session.step.started', data: { sessionID: SESSION } },
      { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
      { type: 'provider.updated', data: {} },
    ].flatMap((event) => helpers.extractEvent(event, isNew));
    expect(lines.map((line) => line.type)).toEqual(['session_start', 'prompt', 'idle']);
    expect(JSON.parse(lines[0].hookContext ?? '{}')).toEqual({ sessionID: SESSION });
  });

  it('maps the waits on the user and their answers, as OpenCode 1 did', async () => {
    const { helpers } = await loadPlugin();
    const never = () => false;
    expect(helpers.extractEvent({ type: 'permission.asked', data: { sessionID: SESSION, action: 'read' } }, never))
      .toEqual([expect.objectContaining({ type: 'idle', detail: 'permission', waitKind: 'approval' })]);
    expect(helpers.extractEvent({ type: 'question.asked', data: { sessionID: SESSION } }, never))
      .toEqual([expect.objectContaining({ type: 'idle', detail: 'permission', waitKind: 'question' })]);
    expect(helpers.extractEvent({ type: 'permission.replied', data: { sessionID: SESSION, reply: 'reject' } }, never))
      .toEqual([expect.objectContaining({ type: 'notification', detail: 'permission.replied' })]);
  });

  it('ends a turn that fails or is interrupted', async () => {
    const { helpers } = await loadPlugin();
    const never = () => false;
    expect(helpers.extractEvent({ type: 'session.execution.failed', data: { sessionID: SESSION } }, never))
      .toEqual([expect.objectContaining({ type: 'idle', detail: 'error' })]);
    expect(helpers.extractEvent({ type: 'session.execution.interrupted', data: { sessionID: SESSION } }, never))
      .toEqual([expect.objectContaining({ type: 'interrupted' })]);
  });

  it('reads a tool\'s detail from its input', async () => {
    const { helpers } = await loadPlugin();
    expect(helpers.extractToolStartEvent({ tool: 'shell', sessionID: SESSION, input: { command: 'npm test' } }))
      .toMatchObject({ type: 'tool_start', tool: 'shell', detail: 'npm test' });
    expect(helpers.extractToolStartEvent({ tool: 'read', sessionID: SESSION, input: { path: '.env' } }))
      .toMatchObject({ type: 'tool_start', tool: 'read', detail: '.env' });
  });

  it.each([
    ['session.idle', { type: 'idle' }],
    ['session.error', { type: 'idle', detail: 'error' }],
    ['session.execution.failed', { type: 'idle', detail: 'error' }],
    ['session.execution.errored', { type: 'idle', detail: 'error' }],
    ['session.execution.error', { type: 'idle', detail: 'error' }],
    ['session.execution.interrupted', { type: 'interrupted' }],
    ['session.execution.cancelled', { type: 'interrupted' }],
    ['session.execution.canceled', { type: 'interrupted' }],
    ['session.execution.aborted', { type: 'interrupted' }],
    ['question.replied', { type: 'notification', detail: 'question.replied' }],
    ['question.rejected', { type: 'notification', detail: 'question.rejected' }],
  ])('maps the unmeasured event name %s', async (eventType, expected) => {
    const { helpers } = await loadPlugin();
    const lines = helpers.extractEvent({ type: eventType, data: { sessionID: SESSION } }, () => false);
    expect(lines).toEqual([expect.objectContaining(expected)]);
  });

  it('maps an unrelated event name to nothing', async () => {
    const { helpers } = await loadPlugin();
    expect(helpers.extractEvent({ type: 'session.usage.updated', data: { sessionID: SESSION } }, () => false)).toEqual([]);
  });

  it('setup returns undefined and subscribes to nothing when KANGENTIC_EVENTS_PATH is unset', async () => {
    delete process.env.KANGENTIC_EVENTS_PATH;
    const plugin = await loadPlugin();
    const subscribe = vi.fn();
    const hook = vi.fn();
    const cleanup = await plugin.setup({ event: { subscribe }, tool: { hook } });
    expect(cleanup).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  it('replays a real OpenCode 2.2.5 capture (a rejected .env read) through setup into the expected lines', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/opencode-v2-plugin-events.jsonl');
    const records = fs.readFileSync(fixturePath, 'utf-8').split('\n').filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: 'event' | 'execute.before' | 'execute.after'; payload: unknown });
    expect(records.map((record) => record.kind)).toContain('execute.before');
    expect(records.map((record) => record.kind)).toContain('execute.after');

    const plugin = await loadPlugin();
    const hooks = new Map<string, (event: unknown) => void>();
    let release: () => void = () => undefined;
    const delivered = new Promise<void>((resolve) => { release = resolve; });
    const ctx = {
      event: {
        subscribe: () => (async function* () {
          // setup registers its tool hooks after it starts the subscription.
          while (hooks.size < 2) await new Promise((resolve) => setTimeout(resolve, 0));
          for (const record of records) {
            if (record.kind === 'event') yield record.payload;
            else hooks.get(record.kind)?.(record.payload);
          }
          release();
        })(),
      },
      tool: { hook: async (name: string, handler: (event: unknown) => void) => { hooks.set(name, handler); } },
    };
    const cleanup = await plugin.setup(ctx);
    await delivered;
    cleanup?.();

    const written = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as PluginEventLine);
    expect(written.map((line) => line.type)).toEqual([
      'session_start', 'prompt', 'tool_start', 'idle', 'tool_end', 'notification', 'idle',
    ]);
    expect(JSON.parse(written[0].hookContext ?? '{}')).toEqual({ sessionID: 'ses_e60042ee8ffeAy5Cq2RJH2s4gd' });
    expect(written[2]).toMatchObject({ tool: 'read', detail: '.env' });
    expect(written[3]).toMatchObject({ detail: 'permission', waitKind: 'approval' });
    expect(written[4]).toMatchObject({ tool: 'read' });
    expect(written[5]).toMatchObject({ detail: 'permission.replied' });
  });

  it('writes the lines a turn with a tool produces, in order, through setup', async () => {
    const plugin = await loadPlugin();
    const hooks = new Map<string, (event: unknown) => void>();
    const events = [
      { type: 'session.execution.started', data: { sessionID: SESSION } },
      { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
    ];
    let release: () => void = () => undefined;
    const delivered = new Promise<void>((resolve) => { release = resolve; });
    const ctx = {
      event: {
        subscribe: () => (async function* () {
          // setup registers its tool hooks after it starts the subscription.
          while (hooks.size < 2) await new Promise((resolve) => setTimeout(resolve, 0));
          yield events[0];
          hooks.get('execute.before')?.({ tool: 'shell', sessionID: SESSION, input: { command: 'ls' } });
          hooks.get('execute.after')?.({ tool: 'shell', sessionID: SESSION, status: 'completed' });
          yield events[1];
          release();
        })(),
      },
      tool: { hook: async (name: string, handler: (event: unknown) => void) => { hooks.set(name, handler); } },
    };
    const cleanup = await plugin.setup(ctx);
    await delivered;
    cleanup?.();
    const written = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => (JSON.parse(line) as PluginEventLine).type);
    expect(written).toEqual(['session_start', 'prompt', 'tool_start', 'tool_end', 'idle']);
  });
});

/**
 * Subagents, compaction and telemetry, from the 2.2.5 event schema
 * (`packages/schema/src/session-event.ts`, `token-usage.ts`, `model.ts`): a
 * child session's `session.created` carries `parentID`; `session.step.started`
 * carries the `Model.Ref` and `session.step.ended` the step's `cost` and
 * `tokens`. Built from the schema, not from a captured run.
 */
describe('createV2SessionTracker', () => {
  const CHILD = 'ses_child0000000000000000000';
  interface Tracker {
    onEvent(event: unknown, now?: number): Array<Record<string, unknown>>;
    toolStart(hookEvent: unknown, now?: number): Record<string, unknown>;
    toolEnd(hookEvent: unknown, now?: number): Record<string, unknown>;
    takeStatusChange(): boolean;
    status(): Record<string, unknown> | null;
  }
  async function createTracker(): Promise<Tracker> {
    const plugin = await loadPlugin() as unknown as { helpers: { createV2SessionTracker(): Tracker } };
    return plugin.helpers.createV2SessionTracker();
  }
  const types = (lines: Array<Record<string, unknown>>) => lines.map(({ ts: _ts, hookContext: _hookContext, ...rest }) => rest);

  it('reads a child session as a subagent, never as the task\'s own start or idle', async () => {
    const tracker = await createTracker();
    const lines = [
      { type: 'session.execution.started', data: { sessionID: SESSION } },
      { type: 'session.created', data: { sessionID: CHILD, parentID: SESSION, projectID: 'prj', title: 'Explore' } },
      { type: 'session.execution.started', data: { sessionID: CHILD } },
      { type: 'session.execution.succeeded', data: { sessionID: CHILD } },
      { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
    ].flatMap((event) => tracker.onEvent(event, 1));
    expect(types(lines)).toEqual([
      { type: 'session_start' },
      { type: 'prompt' },
      { type: 'subagent_start', subagentId: CHILD },
      { type: 'subagent_stop', subagentId: CHILD },
      { type: 'idle' },
    ]);
    expect(tracker.toolStart({ tool: 'grep', sessionID: CHILD, input: { pattern: 'x' } }, 1)).toMatchObject({ type: 'tool_start', subagentId: CHILD });
  });

  it('stops a subagent still open before the root\'s turn ends, and keeps a subagent\'s wait', async () => {
    const tracker = await createTracker();
    tracker.onEvent({ type: 'session.created', data: { sessionID: CHILD, parentID: SESSION } }, 1);
    expect(types(tracker.onEvent({ type: 'question.asked', data: { sessionID: CHILD } }, 1)))
      .toEqual([{ type: 'idle', detail: 'permission', waitKind: 'question' }]);
    expect(types(tracker.onEvent({ type: 'session.execution.interrupted', data: { sessionID: SESSION } }, 1))).toEqual([
      { type: 'session_start' },
      { type: 'subagent_stop', subagentId: CHILD },
      { type: 'interrupted' },
    ]);
  });

  it('writes a compaction of the root', async () => {
    const tracker = await createTracker();
    tracker.onEvent({ type: 'session.execution.started', data: { sessionID: SESSION } }, 1);
    expect(types(tracker.onEvent({ type: 'session.compaction.started', data: { sessionID: SESSION, reason: 'auto' } }, 1)))
      .toEqual([{ type: 'compact' }]);
  });

  it('keeps telemetry from the root\'s steps, and cost from every session', async () => {
    const tracker = await createTracker();
    expect(tracker.status()).toBeNull();
    const step = (sessionID: string, messageID: string, cost: number, input: number) => ({
      type: 'session.step.ended',
      data: { sessionID, assistantMessageID: messageID, finish: 'stop', cost, tokens: { input, output: 10, reasoning: 2, cache: { read: 100, write: 5 } } },
    });
    tracker.onEvent({ type: 'session.step.started', data: { sessionID: SESSION, assistantMessageID: 'msg_1', agent: 'build', model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' }, started: 1 } }, 1);
    tracker.onEvent({ type: 'session.created', data: { sessionID: CHILD, parentID: SESSION } }, 1);
    tracker.onEvent(step(SESSION, 'msg_1', 0.01, 300), 1);
    tracker.onEvent(step(CHILD, 'msg_c1', 0.002, 9000), 1);
    tracker.onEvent(step(SESSION, 'msg_2', 0.02, 400), 1);
    expect(tracker.takeStatusChange()).toBe(true);
    expect(tracker.status()).toEqual({
      kangenticOpenCodeStatus: 1,
      model: { id: 'anthropic/claude-sonnet-4-5' },
      contextLimit: 0,
      context: { input: 400, output: 10, reasoning: 2, cacheRead: 100, cacheWrite: 5 },
      totals: { input: 700, output: 20, reasoning: 4, cacheRead: 200, cacheWrite: 10 },
      costUsd: expect.closeTo(0.032, 10),
    });
  });

  it('adds a compaction\'s cost whether it ended or failed, and counts a failed step like an ended one', async () => {
    const tracker = await createTracker();
    tracker.onEvent({ type: 'session.step.started', data: { sessionID: SESSION, assistantMessageID: 'msg_1', model: { id: 'm', providerID: 'p' } } }, 1);
    tracker.onEvent({ type: 'session.compaction.ended', data: { sessionID: SESSION, cost: 0.1 } }, 1);
    tracker.onEvent({ type: 'session.compaction.failed', data: { sessionID: SESSION, cost: 0.2 } }, 1);
    tracker.onEvent({
      type: 'session.step.failed',
      data: { sessionID: SESSION, assistantMessageID: 'msg_1', cost: 0.4, tokens: { input: 30, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } },
    }, 1);
    const status = tracker.status() as { costUsd: number; totals: { input: number }; context: { input: number } };
    expect(status.costUsd).toBeCloseTo(0.7, 10);
    expect(status.totals.input).toBe(30);
    expect(status.context.input).toBe(30);
  });

  it('keeps the root\'s shown model when a child\'s step starts, and carries the child id on its tool end', async () => {
    const tracker = await createTracker();
    tracker.onEvent({ type: 'session.step.started', data: { sessionID: SESSION, assistantMessageID: 'msg_1', model: { id: 'big', providerID: 'p' } } }, 1);
    tracker.onEvent({ type: 'session.created', data: { sessionID: CHILD, parentID: SESSION } }, 1);
    tracker.onEvent({ type: 'session.step.started', data: { sessionID: CHILD, assistantMessageID: 'msg_c', model: { id: 'small', providerID: 'p' } } }, 1);
    expect(tracker.status()).toMatchObject({ model: { id: 'p/big' } });
    expect(tracker.toolEnd({ tool: 'grep', sessionID: CHILD }, 1)).toMatchObject({ type: 'tool_end', subagentId: CHILD });
    expect(tracker.toolEnd({ tool: 'grep', sessionID: SESSION }, 1)).not.toHaveProperty('subagentId');
  });

  it('starts a continued child again after it stopped, and stops it on a failed or interrupted run', async () => {
    const tracker = await createTracker();
    tracker.onEvent({ type: 'session.created', data: { sessionID: CHILD, parentID: SESSION } }, 1);
    tracker.onEvent({ type: 'session.execution.succeeded', data: { sessionID: CHILD } }, 1);
    for (const endType of ['session.execution.failed', 'session.execution.interrupted']) {
      expect(types(tracker.onEvent({ type: 'session.execution.started', data: { sessionID: CHILD } }, 1)))
        .toEqual([{ type: 'subagent_start', subagentId: CHILD }]);
      expect(types(tracker.onEvent({ type: endType, data: { sessionID: CHILD } }, 1)))
        .toEqual([{ type: 'subagent_stop', subagentId: CHILD }]);
    }
  });

  it('opens a never-seen session with its start before the compaction', async () => {
    const tracker = await createTracker();
    const lines = tracker.onEvent({ type: 'session.compaction.started', data: { sessionID: SESSION, reason: 'auto' } }, 1);
    expect(types(lines)).toEqual([{ type: 'session_start' }, { type: 'compact' }]);
    expect(JSON.parse(lines[0].hookContext as string)).toEqual({ sessionID: SESSION });
  });

  it('reports a status change for a new step model only, not for the same model again', async () => {
    const tracker = await createTracker();
    const started = (id: string) => ({ type: 'session.step.started', data: { sessionID: SESSION, assistantMessageID: 'msg_1', model: { id, providerID: 'p' } } });
    tracker.onEvent(started('one'), 1);
    expect(tracker.takeStatusChange()).toBe(true);
    tracker.onEvent(started('one'), 1);
    expect(tracker.takeStatusChange()).toBe(false);
    tracker.onEvent(started('two'), 1);
    expect(tracker.takeStatusChange()).toBe(true);
  });

  it('writes status.json beside the events file from the subscription', async () => {
    const plugin = await loadPlugin();
    const events = [
      { type: 'session.step.started', data: { sessionID: SESSION, assistantMessageID: 'msg_1', agent: 'build', model: { id: 'gpt-5', providerID: 'openai' }, started: 1 } },
      { type: 'session.step.ended', data: { sessionID: SESSION, assistantMessageID: 'msg_1', finish: 'stop', cost: 0.5, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    ];
    let delivered: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { delivered = resolve; });
    const ctx = {
      event: {
        subscribe: () => (async function* () {
          for (const event of events) yield event;
          delivered();
        })(),
      },
      tool: { hook: async () => undefined },
    };
    const cleanup = await plugin.setup(ctx);
    await done;
    await vi.waitFor(() => expect(fs.existsSync(path.join(directory, 'status.json'))).toBe(true));
    cleanup?.();
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf-8')).model).toEqual({ id: 'openai/gpt-5' });
  });
});
