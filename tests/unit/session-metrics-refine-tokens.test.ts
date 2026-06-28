/**
 * Tests for `refineTranscriptTokens` (src/main/ipc/handlers/session-metrics.ts)
 *
 * The function is fire-and-forget: it reads everything it needs synchronously,
 * then calls `void adapter.transcriptUsage(...).then(...)` without blocking the
 * caller. Each test therefore awaits a `setImmediate`-based tick so the Promise
 * chain can settle before we assert on `updateTranscriptTokens`.
 *
 * `agentRegistry` is a module-level singleton. We spy on its `get` method
 * per-test to control which adapter (if any) is returned. `vi.restoreAllMocks()`
 * in `afterEach` restores the real registry between tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { refineTranscriptTokens } from '../../src/main/ipc/handlers/session-metrics';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { TranscriptUsage } from '../../src/shared/types';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Await one setImmediate so the fire-and-forget Promise chain inside
 * refineTranscriptTokens can settle. In Node.js, setImmediate fires after
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

/** Minimal SessionRepository stub that captures updateTranscriptTokens calls. */
function makeStubRepo(sessionRecord?: {
  agent_session_id?: string | null;
  cwd?: string | null;
}): {
  repo: SessionRepository;
  updateTranscriptTokensCalls: Array<[string, { totalInputTokens: number; totalOutputTokens: number }]>;
} {
  const updateTranscriptTokensCalls: Array<
    [string, { totalInputTokens: number; totalOutputTokens: number }]
  > = [];
  const repo = {
    findByAnyId: vi.fn(() => ({
      agent_session_id: 'agt-1',
      cwd: '/project',
      ...(sessionRecord ?? {}),
    })),
    updateTranscriptTokens: vi.fn(
      (recordId: string, tokens: { totalInputTokens: number; totalOutputTokens: number }) => {
        updateTranscriptTokensCalls.push([recordId, tokens]);
      },
    ),
  } as unknown as SessionRepository;
  return { repo, updateTranscriptTokensCalls };
}

describe('refineTranscriptTokens orchestration', () => {
  it('calls updateTranscriptTokens with the adapter-resolved inputTokens and outputTokens', async () => {
    const resolvedUsage: TranscriptUsage = { inputTokens: 50_000, outputTokens: 8_000 };
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      transcriptUsage: vi.fn().mockResolvedValue(resolvedUsage),
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-agent' });
    const { repo, updateTranscriptTokensCalls } = makeStubRepo();

    refineTranscriptTokens(manager, repo, 'session-1', 'record-1');
    await flushAsync();

    expect(updateTranscriptTokensCalls).toHaveLength(1);
    const [calledId, calledTokens] = updateTranscriptTokensCalls[0];
    expect(calledId).toBe('record-1');
    expect(calledTokens).toEqual({ totalInputTokens: 50_000, totalOutputTokens: 8_000 });
  });

  it('does NOT call updateTranscriptTokens when the adapter transcriptUsage resolves null', async () => {
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      transcriptUsage: vi.fn().mockResolvedValue(null),
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-agent' });
    const { repo, updateTranscriptTokensCalls } = makeStubRepo();

    refineTranscriptTokens(manager, repo, 'session-1', 'record-1');
    await flushAsync();

    expect(updateTranscriptTokensCalls).toHaveLength(0);
  });

  it('is a no-op (synchronous early return) when the adapter has no transcriptUsage method', () => {
    // Adapter present in registry but without the transcriptUsage capability.
    vi.spyOn(agentRegistry, 'get').mockReturnValue({
      name: 'stub-no-transcript',
    } as unknown as AgentAdapter);

    const manager = makeStubManager({ agentName: 'stub-no-transcript' });
    const { repo, updateTranscriptTokensCalls } = makeStubRepo();

    refineTranscriptTokens(manager, repo, 'session-1', 'record-1');
    // No await needed - the function returns synchronously before any async work.

    expect(updateTranscriptTokensCalls).toHaveLength(0);
  });

  it('is a no-op when no agent name is recorded for the session (agentRegistry never queried)', () => {
    const registryGetSpy = vi.spyOn(agentRegistry, 'get');

    // Stub manager returns undefined from getSessionAgentName.
    const manager = {
      getSessionAgentName: vi.fn(() => undefined),
      getUsageCache: vi.fn(() => ({})),
    } as unknown as SessionManager;
    const { repo, updateTranscriptTokensCalls } = makeStubRepo();

    refineTranscriptTokens(manager, repo, 'session-1', 'record-1');

    // When agentName is falsy, `agentRegistry.get` is never called and
    // the function returns immediately.
    expect(registryGetSpy).not.toHaveBeenCalled();
    expect(updateTranscriptTokensCalls).toHaveLength(0);
  });
});
