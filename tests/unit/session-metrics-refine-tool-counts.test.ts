/**
 * Tests for `refineTranscriptToolCounts` (src/main/ipc/handlers/session-metrics.ts)
 *
 * A 1:1 structural mirror of `session-metrics-refine-tokens.test.ts`. The
 * function is fire-and-forget: it reads everything it needs synchronously,
 * then queues the transcript read (the retrieval worker's
 * `transcript.toolCounts`, run in-process here) on the module's background
 * read queue and writes the result without blocking the caller. Each test
 * therefore drains that queue before it asserts on `updateTranscriptToolCounts`.
 *
 * `agentRegistry` is a module-level singleton. We spy on its `get` method
 * per-test to control which adapter (if any) is returned. `vi.restoreAllMocks()`
 * in `afterEach` restores the real registry between tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

// The transcript read runs in the retrieval worker; this runs the worker's own
// handler in-process, over the spied registry.
vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
import { drainTranscriptReadQueueForTests, refineTranscriptToolCounts } from '../../src/main/ipc/handlers/session-metrics';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { TranscriptToolCounts } from '../../src/shared/types';

afterEach(() => {
  vi.restoreAllMocks();
});

/** This run's start: a transcript can hold earlier `--resume` runs too. */
const RUN_STARTED_AT = '2026-10-04T22:56:53.959Z';

/**
 * Wait until the queued transcript read inside refineTranscriptToolCounts, and
 * the write chained on it, have finished. Draining the queue holds however long
 * the read takes, where a single event-loop tick only covered a read that
 * settled in microtasks.
 */
function flushAsync(): Promise<void> {
  return drainTranscriptReadQueueForTests();
}

/** Minimal SessionManager stub with controllable agentName and transcriptPath. */
function makeStubManager(options: {
  agentName: string | undefined;
  transcriptPath?: string | null;
}): SessionManager {
  return {
    getSessionAgentName: vi.fn((_sessionId: string) => options.agentName),
    getUsageCache: vi.fn(() =>
      options.transcriptPath !== undefined
        ? { 'session-1': { transcriptPath: options.transcriptPath ?? undefined } }
        : { 'session-1': { transcriptPath: '/path/to/transcript.jsonl' } },
    ),
    getSession: vi.fn(() => ({ startedAt: RUN_STARTED_AT })),
  } as unknown as SessionManager;
}

/** Minimal SessionRepository stub that captures updateTranscriptToolCounts calls. */
function makeStubRepo(sessionRecord?: {
  agent_session_id?: string | null;
  cwd?: string | null;
}, options: { resumesConversation?: boolean } = {}): {
  repo: SessionRepository;
  updateTranscriptToolCountsCalls: Array<[string, TranscriptToolCounts]>;
} {
  const updateTranscriptToolCountsCalls: Array<[string, TranscriptToolCounts]> = [];
  const repo = {
    findByAnyId: vi.fn(() => ({
      id: 'record-1',
      agent_session_id: 'agt-1',
      cwd: '/project',
      ...(sessionRecord ?? {}),
    })),
    hasEarlierRecordOfConversation: vi.fn(() => options.resumesConversation ?? false),
    updateTranscriptToolCounts: vi.fn((recordId: string, counts: TranscriptToolCounts) => {
      updateTranscriptToolCountsCalls.push([recordId, counts]);
    }),
  } as unknown as SessionRepository;
  return { repo, updateTranscriptToolCountsCalls };
}

describe('refineTranscriptToolCounts orchestration', () => {
  it('calls updateTranscriptToolCounts with the adapter-resolved counts', async () => {
    const resolvedCounts: TranscriptToolCounts = {
      toolCallCount: 3,
      toolBreakdown: [{ toolName: 'Bash', callCount: 3, totalDurationMs: 0, interruptedCount: 0 }],
    };
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      transcriptToolCounts: vi.fn().mockResolvedValue(resolvedCounts),
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-agent' });
    const { repo, updateTranscriptToolCountsCalls } = makeStubRepo();

    refineTranscriptToolCounts(manager, repo, 'session-1', 'record-1');
    await flushAsync();

    expect(updateTranscriptToolCountsCalls).toHaveLength(1);
    const [calledId, calledCounts] = updateTranscriptToolCountsCalls[0];
    expect(calledId).toBe('record-1');
    expect(calledCounts).toEqual(resolvedCounts);
  });

  it('scopes the transcript read to this run, which is all the record covers', async () => {
    const transcriptToolCounts = vi.fn().mockResolvedValue(null);
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);

    refineTranscriptToolCounts(makeStubManager({ agentName: 'stub-agent' }), makeStubRepo().repo, 'session-1', 'record-1');
    await flushAsync();

    expect(transcriptToolCounts).toHaveBeenCalledWith(expect.objectContaining({ sinceMs: Date.parse(RUN_STARTED_AT) }));
  });

  it('closes the window when the run ends, so a resume that follows cannot add its calls', async () => {
    // The read is queued, and a settings respawn resumes at once: without the
    // end bound the next run's first calls land on this record, and the
    // track's merged table counts them a second time.
    const runEndedAtMs = Date.parse('2026-10-04T23:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(runEndedAtMs);
    const transcriptToolCounts = vi.fn().mockResolvedValue(null);
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);

    refineTranscriptToolCounts(makeStubManager({ agentName: 'stub-agent' }), makeStubRepo().repo, 'session-1', 'record-1');
    await flushAsync();

    expect(transcriptToolCounts).toHaveBeenCalledWith(expect.objectContaining({
      sinceMs: Date.parse(RUN_STARTED_AT),
      untilMs: runEndedAtMs,
    }));
  });

  it('skips a resumed conversation\'s run for an agent that cannot scope its reads', async () => {
    // Its whole-transcript count would include the earlier runs' calls, which
    // the track's merged totals already count from their own records.
    const transcriptToolCounts = vi.fn().mockResolvedValue({ toolCallCount: 40, toolBreakdown: [] });
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);
    const { repo, updateTranscriptToolCountsCalls } = makeStubRepo(undefined, { resumesConversation: true });

    refineTranscriptToolCounts(makeStubManager({ agentName: 'unscoped-agent' }), repo, 'session-1', 'record-1');
    await flushAsync();

    expect(repo.hasEarlierRecordOfConversation).toHaveBeenCalledWith('record-1', 'agt-1');
    expect(transcriptToolCounts).not.toHaveBeenCalled();
    expect(updateTranscriptToolCountsCalls).toHaveLength(0);
  });

  it('still reads a conversation\'s first run for an agent that cannot scope its reads', async () => {
    const transcriptToolCounts = vi.fn().mockResolvedValue(null);
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);

    refineTranscriptToolCounts(makeStubManager({ agentName: 'unscoped-agent' }), makeStubRepo().repo, 'session-1', 'record-1');
    await flushAsync();

    expect(transcriptToolCounts).toHaveBeenCalledOnce();
  });

  it('reads a resumed conversation\'s run for an agent that scopes its reads by time', async () => {
    const transcriptToolCounts = vi.fn().mockResolvedValue(null);
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts, scopesTranscriptReadsByTime: true } as unknown as AgentAdapter);
    const { repo } = makeStubRepo(undefined, { resumesConversation: true });

    refineTranscriptToolCounts(makeStubManager({ agentName: 'scoped-agent' }), repo, 'session-1', 'record-1');
    await flushAsync();

    expect(transcriptToolCounts).toHaveBeenCalledOnce();
    expect(repo.hasEarlierRecordOfConversation).not.toHaveBeenCalled();
  });

  it('does NOT call updateTranscriptToolCounts when the adapter transcriptToolCounts resolves null', async () => {
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      transcriptToolCounts: vi.fn().mockResolvedValue(null),
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-agent' });
    const { repo, updateTranscriptToolCountsCalls } = makeStubRepo();

    refineTranscriptToolCounts(manager, repo, 'session-1', 'record-1');
    await flushAsync();

    expect(updateTranscriptToolCountsCalls).toHaveLength(0);
  });

  it('is a no-op (synchronous early return) when the adapter has no transcriptToolCounts method', () => {
    // Adapter present in registry but without the transcriptToolCounts capability.
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      name: 'stub-no-transcript',
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-no-transcript' });
    const { repo, updateTranscriptToolCountsCalls } = makeStubRepo();

    refineTranscriptToolCounts(manager, repo, 'session-1', 'record-1');
    // No await needed - the function returns synchronously before any async work.

    expect(updateTranscriptToolCountsCalls).toHaveLength(0);
  });

  it('is a no-op when no agent name is recorded for the session (agentRegistry never queried)', () => {
    const registryGetSpy = vi.spyOn(agentRegistry, 'get');

    // Stub manager returns undefined from getSessionAgentName.
    const manager = {
      getSessionAgentName: vi.fn(() => undefined),
      getUsageCache: vi.fn(() => ({})),
    } as unknown as SessionManager;
    const { repo, updateTranscriptToolCountsCalls } = makeStubRepo();

    refineTranscriptToolCounts(manager, repo, 'session-1', 'record-1');

    // When agentName is falsy, `agentRegistry.get` is never called and
    // the function returns immediately.
    expect(registryGetSpy).not.toHaveBeenCalled();
    expect(updateTranscriptToolCountsCalls).toHaveLength(0);
  });
});
