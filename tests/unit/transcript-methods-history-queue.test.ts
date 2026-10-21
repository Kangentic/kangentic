/**
 * The retrieval worker's history-paging methods (`transcript.page`,
 * `transcript.locate`, `transcript.timeline` in `worker/transcript-methods.ts`).
 *
 * Each runs its read through `historyReadQueue`, which answers a request that
 * did not run with `busy` (too many queued, waited too long, past its deadline)
 * or `superseded` (a newer request from the same window took its place). The
 * method must hand that reason to the caller as the response, and pass the
 * caller's `requestKey` to the queue (dropping it silently disables
 * superseding). A project whose database cannot be opened answers `not_found`.
 *
 * The queue's own behavior is pinned in `history-read-queue.test.ts`; here the
 * queue is a stand-in, so a test decides the outcome without waiting on timers
 * and no state leaks between tests. `transcript-history` is mocked too, so the
 * read a queued job runs is observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';

const hoisted = vi.hoisted(() => ({
  run: vi.fn(),
  readHistoryPage: vi.fn(),
  locateHistoryTurn: vi.fn(),
  readHistoryTimeline: vi.fn(),
}));

// `adoptRemoteTargets` lists the registry before any read, outside any try.
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

vi.mock('../../src/main/retrieval/worker/history-read-queue', () => ({
  historyReadQueue: { run: hoisted.run },
}));

vi.mock('../../src/main/agent/transcript-history', () => ({
  readHistoryPage: hoisted.readHistoryPage,
  locateHistoryTurn: hoisted.locateHistoryTurn,
  readHistoryTimeline: hoisted.readHistoryTimeline,
}));

import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';

const OPEN_PROJECT = 'project-open';
const GONE_PROJECT = 'project-closed-for-deletion';
const REQUEST_KEY = 'window-1';
const PROJECT_DATABASE = { name: 'the open project database' };

const getDb = vi.fn((projectId: string) => {
  if (projectId === GONE_PROJECT) throw new Error('the project database is closed for deletion');
  return PROJECT_DATABASE;
});
const context = {
  getDb,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
} as unknown as WorkerContext;

const PAGE_REQUEST = { conversationId: 'conversation-1', direction: 'before' as const, requestKey: REQUEST_KEY };
const LOCATE_REQUEST = { sessionId: 'session-1', turnUuid: 'turn-1', turnTs: null, chunkId: null, requestKey: REQUEST_KEY };
const TIMELINE_REQUEST = { conversationId: 'conversation-1', requestKey: REQUEST_KEY };

async function callPage(projectId: string): Promise<string> {
  return transcriptHandlers['transcript.page']({ projectId, request: PAGE_REQUEST, remoteTargets: [] }, context);
}
async function callLocate(projectId: string): Promise<string> {
  return transcriptHandlers['transcript.locate']({ projectId, request: LOCATE_REQUEST, remoteTargets: [] }, context);
}
async function callTimeline(projectId: string) {
  return transcriptHandlers['transcript.timeline']({ projectId, request: TIMELINE_REQUEST, remoteTargets: [] }, context);
}

beforeEach(() => {
  hoisted.run.mockReset();
  hoisted.readHistoryPage.mockReset();
  hoisted.locateHistoryTurn.mockReset();
  hoisted.readHistoryTimeline.mockReset();
  getDb.mockClear();
});

describe('a read the queue did not run', () => {
  it.each(['busy', 'superseded'] as const)('transcript.page answers the %s response as JSON', async (reason) => {
    hoisted.run.mockResolvedValue({ ran: false, reason });

    const answer = await callPage(OPEN_PROJECT);

    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual({ status: reason });
    expect(hoisted.readHistoryPage).not.toHaveBeenCalled();
  });

  it.each(['busy', 'superseded'] as const)('transcript.locate answers the %s response as JSON', async (reason) => {
    hoisted.run.mockResolvedValue({ ran: false, reason });

    const answer = await callLocate(OPEN_PROJECT);

    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual({ status: reason });
    expect(hoisted.locateHistoryTurn).not.toHaveBeenCalled();
  });

  it.each(['busy', 'superseded'] as const)('transcript.timeline answers the %s response as an object', async (reason) => {
    hoisted.run.mockResolvedValue({ ran: false, reason });

    const answer = await callTimeline(OPEN_PROJECT);

    expect(typeof answer).toBe('object');
    expect(answer).toEqual({ status: reason });
    expect(hoisted.readHistoryTimeline).not.toHaveBeenCalled();
  });
});

describe('the queue is given the caller\'s requestKey and the read as its job', () => {
  it('transcript.page queues under the request\'s requestKey', async () => {
    hoisted.run.mockResolvedValue({ ran: false, reason: 'busy' });

    await callPage(OPEN_PROJECT);

    expect(hoisted.run).toHaveBeenCalledTimes(1);
    expect(hoisted.run).toHaveBeenCalledWith(REQUEST_KEY, expect.any(Function));
  });

  it('transcript.locate queues under the request\'s requestKey', async () => {
    hoisted.run.mockResolvedValue({ ran: false, reason: 'busy' });

    await callLocate(OPEN_PROJECT);

    expect(hoisted.run).toHaveBeenCalledTimes(1);
    expect(hoisted.run).toHaveBeenCalledWith(REQUEST_KEY, expect.any(Function));
  });

  it('transcript.timeline queues under the request\'s requestKey', async () => {
    hoisted.run.mockResolvedValue({ ran: false, reason: 'busy' });

    await callTimeline(OPEN_PROJECT);

    expect(hoisted.run).toHaveBeenCalledTimes(1);
    expect(hoisted.run).toHaveBeenCalledWith(REQUEST_KEY, expect.any(Function));
  });

  it('transcript.page reads the open project\'s database with the request, and answers the page it read as JSON', async () => {
    const okPage = { status: 'ok', conversationId: 'conversation-1', entries: [] };
    hoisted.readHistoryPage.mockResolvedValue(okPage);
    hoisted.run.mockImplementation(async (_requestKey: string, job: () => Promise<unknown>) => ({ ran: true, value: await job() }));

    const answer = await callPage(OPEN_PROJECT);

    expect(hoisted.readHistoryPage).toHaveBeenCalledWith(PROJECT_DATABASE, PAGE_REQUEST);
    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual(okPage);
  });

  it('transcript.locate reads the open project\'s database with the request, and answers what it found as JSON', async () => {
    hoisted.locateHistoryTurn.mockResolvedValue({ status: 'in_tail' });
    hoisted.run.mockImplementation(async (_requestKey: string, job: () => Promise<unknown>) => ({ ran: true, value: await job() }));

    const answer = await callLocate(OPEN_PROJECT);

    expect(hoisted.locateHistoryTurn).toHaveBeenCalledWith(PROJECT_DATABASE, LOCATE_REQUEST);
    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual({ status: 'in_tail' });
  });

  it('transcript.timeline reads the open project\'s database for the conversation id, and answers the timeline itself', async () => {
    const timeline = { status: 'ok', conversationId: 'conversation-1', samples: [{ position: 0, ts: 5 }] };
    hoisted.readHistoryTimeline.mockResolvedValue(timeline);
    hoisted.run.mockImplementation(async (_requestKey: string, job: () => Promise<unknown>) => ({ ran: true, value: await job() }));

    const answer = await callTimeline(OPEN_PROJECT);

    expect(hoisted.readHistoryTimeline).toHaveBeenCalledWith(PROJECT_DATABASE, 'conversation-1');
    expect(answer).toEqual(timeline);
  });
});

describe('a project whose database cannot be opened', () => {
  it('transcript.page answers the not_found JSON string and never queues a read', async () => {
    const answer = await callPage(GONE_PROJECT);

    expect(getDb).toHaveBeenCalledWith(GONE_PROJECT);
    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(hoisted.run).not.toHaveBeenCalled();
    expect(hoisted.readHistoryPage).not.toHaveBeenCalled();
  });

  it('transcript.locate answers the not_found JSON string and never queues a read', async () => {
    const answer = await callLocate(GONE_PROJECT);

    expect(getDb).toHaveBeenCalledWith(GONE_PROJECT);
    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toEqual({ status: 'not_found' });
    expect(hoisted.run).not.toHaveBeenCalled();
    expect(hoisted.locateHistoryTurn).not.toHaveBeenCalled();
  });

  it('transcript.timeline answers the not_found object and never queues a read', async () => {
    const answer = await callTimeline(GONE_PROJECT);

    expect(getDb).toHaveBeenCalledWith(GONE_PROJECT);
    expect(typeof answer).toBe('object');
    expect(answer).toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(hoisted.run).not.toHaveBeenCalled();
    expect(hoisted.readHistoryTimeline).not.toHaveBeenCalled();
  });
});
