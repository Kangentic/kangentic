/**
 * The Conversation viewer's history-paging IPC handlers (`transcript:page`,
 * `transcript:locate`, `transcript:timeline` in `ipc/handlers/transcripts.ts`).
 *
 * Main validates a request field by field and relays the retrieval worker's
 * answer. A request nothing can be found from (no project, a malformed field)
 * answers `not_found` without calling the worker. A worker call that rejects
 * answers `unavailable` instead of throwing: `worker_unavailable` for a
 * `RetrievalUnavailableError`, `read_failed` for anything else. The renderer
 * retries a timeline only on `worker_unavailable`, so the reason is behavior.
 *
 * Page and locate answer JSON strings (main relays the worker's text unparsed);
 * timeline answers an object. Both shapes are pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => {
  // The handler tells the two failures apart with `instanceof`, so the class
  // the mocked module exports must be the class the test throws.
  class RetrievalUnavailableError extends Error {}
  return {
    RetrievalUnavailableError,
    call: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// `collectRemoteTargets` runs inside the handlers' try block, so a registry
// without `list` would throw a TypeError there and answer `read_failed` for the
// wrong reason.
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: hoisted.RetrievalUnavailableError,
  retrievalClient: { call: hoisted.call },
}));

import { registerTranscriptHandlers } from '../../src/main/ipc/handlers/transcripts';
import { IPC } from '../../src/shared/ipc-channels';

const CONTEXT_PROJECT_ID = 'project-from-context';

function register(currentProjectId: string | null): void {
  capturedHandlers.clear();
  registerTranscriptHandlers({ currentProjectId } as Parameters<typeof registerTranscriptHandlers>[0]);
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`${channel} handler not registered`);
  return handler(undefined, request);
}

interface ForwardedParams {
  projectId: string;
  request: Record<string, unknown>;
  remoteTargets: unknown;
}

/** What the handler sent the worker on its one call. */
function forwardedCall(): { method: string; params: ForwardedParams } {
  expect(hoisted.call).toHaveBeenCalledTimes(1);
  const [method, params] = hoisted.call.mock.calls[0];
  return { method, params: params as ForwardedParams };
}

interface Endpoint {
  label: string;
  channel: string;
  method: string;
  /** Page and locate answer a JSON string; timeline answers the object itself. */
  answersJson: boolean;
  /** A request that is valid on every field except, in a test, what it removes. */
  validRequest: Record<string, unknown>;
  notFoundAnswer: unknown;
}

const ENDPOINTS: Endpoint[] = [
  {
    label: 'page',
    channel: IPC.TRANSCRIPT_PAGE,
    method: 'transcript.page',
    answersJson: true,
    validRequest: { conversationId: 'conversation-1', direction: 'before' },
    notFoundAnswer: { status: 'unavailable', reason: 'not_found' },
  },
  {
    label: 'locate',
    channel: IPC.TRANSCRIPT_LOCATE,
    method: 'transcript.locate',
    answersJson: true,
    validRequest: { sessionId: 'session-1', turnUuid: 'turn-1' },
    notFoundAnswer: { status: 'not_found' },
  },
  {
    label: 'timeline',
    channel: IPC.TRANSCRIPT_TIMELINE,
    method: 'transcript.timeline',
    answersJson: false,
    validRequest: { conversationId: 'conversation-1' },
    notFoundAnswer: { status: 'unavailable', reason: 'not_found' },
  },
];

/** The answer as the renderer's bridge sees it, after checking its wire shape. */
function decodeAnswer(reply: unknown, answersJson: boolean): unknown {
  if (answersJson) {
    expect(typeof reply).toBe('string');
    return JSON.parse(reply as string);
  }
  expect(typeof reply).toBe('object');
  return reply;
}

beforeEach(() => {
  hoisted.call.mockReset();
  register(CONTEXT_PROJECT_ID);
});

describe.each(ENDPOINTS)('$label: answers shared by every history channel', (endpoint) => {
  it('answers not_found without calling the worker when neither the request nor the context has a project', async () => {
    register(null);

    const reply = await invoke(endpoint.channel, endpoint.validRequest);

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual(endpoint.notFoundAnswer);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('answers not_found for an empty-string projectId rather than reaching the worker', async () => {
    register(null);

    const reply = await invoke(endpoint.channel, { ...endpoint.validRequest, projectId: '' });

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual(endpoint.notFoundAnswer);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('answers not_found, and does not throw, for a missing request', async () => {
    const reply = await invoke(endpoint.channel, undefined);

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual(endpoint.notFoundAnswer);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('calls the worker with the request projectId when it has one', async () => {
    hoisted.call.mockResolvedValue('{"status":"busy"}');

    await invoke(endpoint.channel, { ...endpoint.validRequest, projectId: 'project-from-request' });

    const { method, params } = forwardedCall();
    expect(method).toBe(endpoint.method);
    expect(params.projectId).toBe('project-from-request');
  });

  it('falls back to the context project when the request names none', async () => {
    hoisted.call.mockResolvedValue('{"status":"busy"}');

    await invoke(endpoint.channel, endpoint.validRequest);

    expect(forwardedCall().params.projectId).toBe(CONTEXT_PROJECT_ID);
  });

  it('answers worker_unavailable when the worker call rejects with RetrievalUnavailableError', async () => {
    hoisted.call.mockRejectedValue(new hoisted.RetrievalUnavailableError('the index is restarting'));

    const reply = await invoke(endpoint.channel, endpoint.validRequest);

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual({ status: 'unavailable', reason: 'worker_unavailable' });
    // The worker call is what rejected, not something before it.
    expect(forwardedCall().method).toBe(endpoint.method);
  });

  it('answers read_failed when the worker call rejects with any other error', async () => {
    hoisted.call.mockRejectedValue(new Error('the transcript read blew up'));

    const reply = await invoke(endpoint.channel, endpoint.validRequest);

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual({ status: 'unavailable', reason: 'read_failed' });
    expect(forwardedCall().method).toBe(endpoint.method);
  });

  it('answers read_failed for a rejection that is not an Error at all', async () => {
    hoisted.call.mockRejectedValue('a bare string');

    const reply = await invoke(endpoint.channel, endpoint.validRequest);

    expect(decodeAnswer(reply, endpoint.answersJson)).toEqual({ status: 'unavailable', reason: 'read_failed' });
  });
});

describe('transcript:page request validation', () => {
  const PAGE_CHANNEL = IPC.TRANSCRIPT_PAGE;
  const NOT_FOUND = { status: 'unavailable', reason: 'not_found' };

  it.each([
    ['an empty string', ''],
    ['a missing id', undefined],
    ['a number', 42],
    ['null', null],
  ])('answers the not_found JSON string for a conversationId that is %s, without calling the worker', async (_label, conversationId) => {
    const reply = await invoke(PAGE_CHANNEL, { conversationId, direction: 'before' });

    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply as string)).toEqual(NOT_FOUND);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown word', 'sideways'],
    ['an empty string', ''],
    ['a missing direction', undefined],
    ['the wrong case', 'BEFORE'],
    ['a number', 1],
  ])('answers the not_found JSON string for a direction that is %s, without calling the worker', async (_label, direction) => {
    const reply = await invoke(PAGE_CHANNEL, { conversationId: 'conversation-1', direction });

    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply as string)).toEqual(NOT_FOUND);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it.each(['before', 'after', 'around'])('forwards the %s direction to the worker', async (direction) => {
    hoisted.call.mockResolvedValue('{"status":"busy"}');

    await invoke(PAGE_CHANNEL, { conversationId: 'conversation-1', direction });

    expect(forwardedCall().params.request.direction).toBe(direction);
  });

  it.each(['position', 'untilPosition'])('drops, floors, or keeps %s exactly as its value dictates', async (field) => {
    const cases: Array<[unknown, number | undefined]> = [
      [-5, undefined],
      [-0.5, undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      ['7', undefined],
      [12.7, 12],
      [0, 0],
      [41, 41],
    ];
    for (const [sent, expected] of cases) {
      hoisted.call.mockReset();
      hoisted.call.mockResolvedValue('{"status":"busy"}');

      await invoke(PAGE_CHANNEL, { conversationId: 'conversation-1', direction: 'around', [field]: sent });

      const forwarded = forwardedCall().params.request[field];
      expect(forwarded, `${field} sent as ${String(sent)}`).toBe(expected);
    }
  });

  it('forwards only the fields it validated, with empty strings dropped', async () => {
    hoisted.call.mockResolvedValue('{"status":"busy"}');

    await invoke(PAGE_CHANNEL, {
      projectId: 'project-from-request',
      conversationId: 'conversation-1',
      direction: 'after',
      cursor: '',
      sourceToken: 'token-1',
      requestKey: '',
      position: 3,
      unexpected: 'dropped',
    });

    const { params } = forwardedCall();
    expect(params.request.conversationId).toBe('conversation-1');
    expect(params.request.cursor).toBeUndefined();
    expect(params.request.requestKey).toBeUndefined();
    expect(params.request.sourceToken).toBe('token-1');
    expect(params.request.position).toBe(3);
    expect(params.request).not.toHaveProperty('unexpected');
    expect(params.request).not.toHaveProperty('projectId');
    expect(params.remoteTargets).toEqual([]);
  });

  it('relays the worker\'s JSON string unchanged', async () => {
    const workerAnswer = '{"status":"reset","conversationId":"conversation-1"}';
    hoisted.call.mockResolvedValue(workerAnswer);

    const reply = await invoke(PAGE_CHANNEL, { conversationId: 'conversation-1', direction: 'before' });

    expect(reply).toBe(workerAnswer);
  });
});

describe('transcript:locate request validation', () => {
  const LOCATE_CHANNEL = IPC.TRANSCRIPT_LOCATE;

  it.each([
    ['a missing sessionId', { turnUuid: 'turn-1' }],
    ['a non-string sessionId', { sessionId: 9, turnUuid: 'turn-1' }],
    ['a missing turnUuid', { sessionId: 'session-1' }],
    ['a non-string turnUuid', { sessionId: 'session-1', turnUuid: 9 }],
  ])('answers the not_found JSON string for %s, without calling the worker', async (_label, request) => {
    const reply = await invoke(LOCATE_CHANNEL, request);

    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply as string)).toEqual({ status: 'not_found' });
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('forwards a finite turnTs and an integer chunkId, and nulls anything else', async () => {
    hoisted.call.mockResolvedValue('{"status":"in_tail"}');

    await invoke(LOCATE_CHANNEL, {
      sessionId: 'session-1',
      turnUuid: 'turn-1',
      turnTs: 1_700_000_000_000,
      chunkId: 17,
      requestKey: 'window-1',
    });
    const valid = forwardedCall().params.request;
    expect(valid).toEqual({
      sessionId: 'session-1',
      turnUuid: 'turn-1',
      turnTs: 1_700_000_000_000,
      chunkId: 17,
      requestKey: 'window-1',
    });

    hoisted.call.mockReset();
    hoisted.call.mockResolvedValue('{"status":"in_tail"}');
    await invoke(LOCATE_CHANNEL, {
      sessionId: 'session-1',
      turnUuid: 'turn-1',
      turnTs: Number.NaN,
      chunkId: 1.5,
      requestKey: '',
    });
    const malformed = forwardedCall().params.request;
    expect(malformed.turnTs).toBeNull();
    expect(malformed.chunkId).toBeNull();
    expect(malformed.requestKey).toBeUndefined();
  });

  it('relays the worker\'s JSON string unchanged', async () => {
    const workerAnswer = '{"status":"in_tail"}';
    hoisted.call.mockResolvedValue(workerAnswer);

    const reply = await invoke(LOCATE_CHANNEL, { sessionId: 'session-1', turnUuid: 'turn-1' });

    expect(reply).toBe(workerAnswer);
  });
});

describe('transcript:timeline request validation', () => {
  const TIMELINE_CHANNEL = IPC.TRANSCRIPT_TIMELINE;

  it.each([
    ['an empty string', ''],
    ['a missing id', undefined],
    ['a number', 7],
  ])('answers the not_found object for a conversationId that is %s, without calling the worker', async (_label, conversationId) => {
    const reply = await invoke(TIMELINE_CHANNEL, { conversationId });

    expect(typeof reply).toBe('object');
    expect(reply).toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('forwards the conversation and the window key, and relays the worker\'s object itself', async () => {
    const workerAnswer = { status: 'ok', conversationId: 'conversation-1', samples: [{ position: 0, ts: 1 }] };
    hoisted.call.mockResolvedValue(workerAnswer);

    const reply = await invoke(TIMELINE_CHANNEL, { conversationId: 'conversation-1', requestKey: 'window-1' });

    expect(forwardedCall().params.request).toEqual({ conversationId: 'conversation-1', requestKey: 'window-1' });
    expect(reply).toBe(workerAnswer);
  });
});
