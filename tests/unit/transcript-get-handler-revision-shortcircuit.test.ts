/**
 * Unit tests for the TRANSCRIPT_GET IPC handler's `knownRevision`
 * short-circuit in src/main/ipc/handlers/transcripts.ts.
 *
 * When the caller's `request.knownRevision` matches the task's current
 * `resolved.revision`, the handler must skip the full structured-clone
 * payload and return only `{ unchanged: true, revision }`. Any other case
 * (a differing revision, or no `knownRevision` at all - the first fetch)
 * must return the full `TranscriptGetResponse`, including `entries`.
 *
 * Strategy mirrors agent-summarize-handler.test.ts: capture the handler via
 * a mocked `ipcMain.handle`, and stub `resolveTaskTranscript` (the service
 * this handler delegates to) so the test controls the resolved revision
 * directly rather than driving it through real DB/file state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptGetResponse, TranscriptUnchangedResponse } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

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
vi.mock('../../src/main/agent/transcript-service', () => ({
  resolveTaskTranscript: (...args: unknown[]) => resolveTaskTranscript(...args),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { registerTranscriptHandlers } from '../../src/main/ipc/handlers/transcripts';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  return handler(undefined, request) as Promise<TranscriptGetResponse | TranscriptUnchangedResponse>;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TRANSCRIPT_GET IPC handler knownRevision short-circuit', () => {
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

  it('returns the full response including entries when knownRevision differs from the resolved revision', async () => {
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
});
