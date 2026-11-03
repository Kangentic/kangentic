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
