/**
 * Tests for `refineTranscriptToolCounts` (src/main/ipc/handlers/session-metrics.ts)
 *
 * A 1:1 structural mirror of `session-metrics-refine-tokens.test.ts`. The
 * function is fire-and-forget: it reads everything it needs synchronously,
 * then calls `void adapter.transcriptToolCounts(...).then(...)` without
 * blocking the caller. Each test therefore awaits a `setImmediate`-based tick
 * so the Promise chain can settle before we assert on
 * `updateTranscriptToolCounts`.
 *
 * `agentRegistry` is a module-level singleton. We spy on its `get` method
 * per-test to control which adapter (if any) is returned. `vi.restoreAllMocks()`
 * in `afterEach` restores the real registry between tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { refineTranscriptToolCounts } from '../../src/main/ipc/handlers/session-metrics';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { TranscriptToolCounts } from '../../src/shared/types';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Await one setImmediate so the fire-and-forget Promise chain inside
 * refineTranscriptToolCounts can settle. In Node.js, setImmediate fires after
 * the current event-loop turn (after all pending microtasks), which means
 * any .then() callbacks scheduled synchronously before this await will have
 * run by the time this resolves.
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  } as unknown as SessionManager;
}

/** Minimal SessionRepository stub that captures updateTranscriptToolCounts calls. */
function makeStubRepo(sessionRecord?: {
  agent_session_id?: string | null;
  cwd?: string | null;
}): {
  repo: SessionRepository;
  updateTranscriptToolCountsCalls: Array<[string, TranscriptToolCounts]>;
} {
  const updateTranscriptToolCountsCalls: Array<[string, TranscriptToolCounts]> = [];
  const repo = {
    findByAnyId: vi.fn(() => ({
      agent_session_id: 'agt-1',
      cwd: '/project',
      ...(sessionRecord ?? {}),
    })),
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
