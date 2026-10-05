/**
 * Tests for `readTranscriptToolResultTokens` (src/main/ipc/handlers/session-metrics.ts),
 * the live read behind `sessions.getToolResultTokens`: the ContextBar popover
 * merges its per-tool estimates onto the live breakdown, whose hook events
 * carry no token data.
 *
 * Same shape as `session-metrics-refine-tool-counts.test.ts`: the registry is
 * spied per test, and the worker's own handler runs in-process.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
import { readTranscriptToolResultTokens } from '../../src/main/ipc/handlers/session-metrics';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

afterEach(() => {
  vi.restoreAllMocks();
});

const RUN_STARTED_AT = '2026-10-04T22:56:53.959Z';

function makeStubManager(options: { agentName: string | undefined; transcriptPath?: string | null }): SessionManager {
  return {
    getSessionAgentName: vi.fn(() => options.agentName),
    getUsageCache: vi.fn(() => ({ 'session-1': { transcriptPath: options.transcriptPath ?? undefined } })),
    getSession: vi.fn(() => ({ startedAt: RUN_STARTED_AT })),
  } as unknown as SessionManager;
}

function makeStubRepo(record: { agent_session_id: string | null; cwd: string | null; started_at?: string } | null): SessionRepository {
  return { findByAnyId: vi.fn(() => record) } as unknown as SessionRepository;
}

describe('readTranscriptToolResultTokens', () => {
  it('returns the adapter estimates, scoped to the current run', async () => {
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 4200 });
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolResultTokens } as unknown as AgentAdapter);

    const tokens = await readTranscriptToolResultTokens(
      makeStubManager({ agentName: 'stub-agent', transcriptPath: '/path/to/transcript.jsonl' }),
      null,
      'session-1',
    );

    expect(tokens).toEqual({ Read: 4200 });
    // A resumed session keeps writing the same transcript; only this run's calls count.
    expect(transcriptToolResultTokens).toHaveBeenCalledWith(expect.objectContaining({
      transcriptPath: '/path/to/transcript.jsonl',
      sinceMs: Date.parse(RUN_STARTED_AT),
    }));
  });

  it('falls back to the record when no transcript path has been reported yet', async () => {
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({});
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolResultTokens } as unknown as AgentAdapter);

    await readTranscriptToolResultTokens(
      makeStubManager({ agentName: 'stub-agent', transcriptPath: null }),
      makeStubRepo({ agent_session_id: 'agt-1', cwd: '/project' }),
      'session-1',
    );

    expect(transcriptToolResultTokens).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'agt-1', cwd: '/project' }));
  });

  it('never reads the transcript of an agent that only counts tool calls', async () => {
    // Such an adapter parses its whole transcript per call and fills no
    // estimates; the popover refetches on every tool call.
    const transcriptToolCounts = vi.fn();
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);

    const tokens = await readTranscriptToolResultTokens(
      makeStubManager({ agentName: 'stub-agent', transcriptPath: '/path/to/transcript.jsonl' }),
      null,
      'session-1',
    );

    expect(tokens).toBeNull();
    expect(transcriptToolCounts).not.toHaveBeenCalled();
  });

  it('returns null when the transcript cannot be located', async () => {
    const transcriptToolResultTokens = vi.fn();
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolResultTokens } as unknown as AgentAdapter);

    const tokens = await readTranscriptToolResultTokens(
      makeStubManager({ agentName: 'stub-agent', transcriptPath: null }),
      makeStubRepo(null),
      'session-1',
    );

    expect(tokens).toBeNull();
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the read fails', async () => {
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      transcriptToolResultTokens: vi.fn().mockRejectedValue(new Error('EBUSY')),
    } as unknown as AgentAdapter);

    const tokens = await readTranscriptToolResultTokens(
      makeStubManager({ agentName: 'stub-agent', transcriptPath: '/path/to/transcript.jsonl' }),
      null,
      'session-1',
    );

    expect(tokens).toBeNull();
  });
});
