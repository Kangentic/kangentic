/**
 * The TRANSCRIPT_GET IPC handler hands the retrieval worker's JSON to the
 * renderer as is, and the worker's `transcript.task` answers a caller's
 * `knownRevision`: a matching revision returns only `{ unchanged: true,
 * revision }`, while a differing one (with no earlier revision kept for a
 * delta) or none at all (the first fetch) returns the whole response.
 *
 * The worker runs in-process (`inProcessRetrievalClientModule`), and
 * `resolveTaskTranscript` is stubbed so the test sets the resolved revision
 * directly rather than driving it through real DB and file state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptGetResponse, TranscriptUnchangedResponse } from '../../src/shared/types';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

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

const resolveTaskTranscript = vi.fn();
vi.mock('../../src/main/agent/transcript-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/transcript-service')>()),
  resolveTaskTranscript: (...args: unknown[]) => resolveTaskTranscript(...args),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));

import { registerTranscriptHandlers } from '../../src/main/ipc/handlers/transcripts';
import { IPC } from '../../src/shared/ipc-channels';

function makeContext(currentProjectId: string | null) {
  return { currentProjectId } as Parameters<typeof registerTranscriptHandlers>[0];
}

async function invokeTranscriptGet(request: {
  sessionId: string;
  projectId?: string | null;
  knownRevision?: number;
}): Promise<TranscriptGetResponse | TranscriptUnchangedResponse> {
  const handler = capturedHandlers.get(IPC.TRANSCRIPT_GET);
  if (!handler) throw new Error(`${IPC.TRANSCRIPT_GET} handler not registered`);
  const reply = await handler(undefined, request);
  // Main relays a string; the preload parses it.
  expect(typeof reply).toBe('string');
  return JSON.parse(reply as string) as TranscriptGetResponse | TranscriptUnchangedResponse;
}

function makeResolved(revision: number) {
  return {
    record: {
      id: 'session-1',
      task_id: 'task-1',
      started_at: '2026-06-01T10:00:00Z',
      status: 'running',
    },
    taskTitle: 'Wire the auth flow',
    agentName: 'Claude Code',
    source: 'live' as const,
    sourcePath: '/history/x.jsonl',
    entries: [{ kind: 'user' as const, uuid: 'u1', ts: 1, text: 'hi' }],
    degraded: false,
    sessions: [],
    revision,
  };
}

describe('TRANSCRIPT_GET relays the worker answer to knownRevision', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    resolveTaskTranscript.mockReset();
    registerTranscriptHandlers(makeContext('proj-1'));
  });

  it('returns { unchanged: true, revision } with no entries when knownRevision matches the resolved revision', async () => {
    resolveTaskTranscript.mockResolvedValue(makeResolved(4));

    const result = await invokeTranscriptGet({ sessionId: 'session-1', knownRevision: 4 });

    expect(result).toEqual({ unchanged: true, revision: 4 });
    expect('entries' in result).toBe(false);
  });

  it('returns the full response including entries when knownRevision differs and no delta base is kept', async () => {
    resolveTaskTranscript.mockResolvedValue(makeResolved(5));

    const result = await invokeTranscriptGet({ sessionId: 'session-1', knownRevision: 4 });

    expect('unchanged' in result).toBe(false);
    if (!('unchanged' in result)) {
      expect(result.entries).toEqual([{ kind: 'user', uuid: 'u1', ts: 1, text: 'hi' }]);
      expect(result.revision).toBe(5);
      expect(result.taskTitle).toBe('Wire the auth flow');
    }
  });

  it('returns the full response including entries when knownRevision is omitted (the first fetch for a session)', async () => {
    resolveTaskTranscript.mockResolvedValue(makeResolved(1));

    const result = await invokeTranscriptGet({ sessionId: 'session-1' });

    expect('unchanged' in result).toBe(false);
    if (!('unchanged' in result)) {
      expect(result.entries).toEqual([{ kind: 'user', uuid: 'u1', ts: 1, text: 'hi' }]);
      expect(result.revision).toBe(1);
    }
  });

  it('answers an empty response, without asking the worker, when no project is open', async () => {
    capturedHandlers.clear();
    registerTranscriptHandlers(makeContext(null));

    const result = await invokeTranscriptGet({ sessionId: 'session-1' });

    expect(result).toMatchObject({ source: 'none', entries: [], revision: 0 });
    expect(resolveTaskTranscript).not.toHaveBeenCalled();
  });
});
