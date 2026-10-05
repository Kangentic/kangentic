/**
 * Edge cases in the earlier-runs backfills of src/main/ipc/handlers/session-metrics.ts
 * that the neighbouring suites (session-metrics-refine-tool-counts.test.ts and
 * earlier-run-result-tokens.test.ts) leave open.
 *
 * 1. `refineTranscriptToolCounts` skips an unscoped agent's resumed run, but a
 *    record with no `agent_session_id` has no conversation to be a resume of, so
 *    it must still be read, and the repository must not be asked about a null id.
 * 2. `fillEarlierRunResultTokens` marks a fill whose database write throws (the
 *    project database closed under it) as failed, so a read after the retry
 *    wait tries again instead of reusing a settled failure for the rest of the
 *    launch.
 *
 * The retrieval worker's own handler runs in-process over a spied agent registry,
 * as in the two suites above.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { agentRegistry } from '../../src/main/agent/agent-registry';

vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
import {
  FAILED_FILL_RETRY_MS,
  drainTranscriptReadQueueForTests,
  fillEarlierRunResultTokens,
  refineTranscriptToolCounts,
  resetResultTokenFillsForTests,
} from '../../src/main/ipc/handlers/session-metrics';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import {
  insertSessionRecord,
  insertTask,
  openMigratedProjectDatabase,
  readResultTokensReadAt,
  readStoredToolRows,
  stubScopedAdapter,
} from './helpers/earlier-run-fixture';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { PerToolStat, TranscriptToolCounts } from '../../src/shared/types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refineTranscriptToolCounts for a record with no agent session id', () => {
  const RUN_STARTED_AT = '2026-10-05T10:00:00.000Z';

  function makeStubManager(): SessionManager {
    return {
      getSessionAgentName: vi.fn(() => 'unscoped-agent'),
      getUsageCache: vi.fn(() => ({ 'session-1': { transcriptPath: '/path/to/transcript.jsonl' } })),
      getSession: vi.fn(() => ({ startedAt: RUN_STARTED_AT })),
    } as unknown as SessionManager;
  }

  /**
   * `resumesConversation` is what the repository would answer if it were asked.
   * Tests that expect it NOT to be asked set it true, so a read that skipped for
   * the wrong reason would show up as a missing call as well as a spy hit.
   */
  function makeStubRepo(
    record: { agent_session_id: string | null },
    resumesConversation: boolean,
  ): { repo: SessionRepository; updateTranscriptToolCounts: ReturnType<typeof vi.fn> } {
    const updateTranscriptToolCounts = vi.fn();
    const repo = {
      findByAnyId: vi.fn(() => ({ id: 'record-1', cwd: '/project', ...record })),
      hasEarlierRecordOfConversation: vi.fn(() => resumesConversation),
      updateTranscriptToolCounts,
    } as unknown as SessionRepository;
    return { repo, updateTranscriptToolCounts };
  }

  /** An adapter that cannot scope its reads by time: no `scopesTranscriptReadsByTime`. */
  function stubUnscopedAdapter(counts: TranscriptToolCounts | null): ReturnType<typeof vi.fn> {
    const transcriptToolCounts = vi.fn().mockResolvedValue(counts);
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ transcriptToolCounts } as unknown as AgentAdapter);
    return transcriptToolCounts;
  }

  it('still reads the run, and never asks the repository about a null conversation', async () => {
    const resolvedCounts: TranscriptToolCounts = {
      toolCallCount: 4,
      toolBreakdown: [{ toolName: 'Bash', callCount: 4, totalDurationMs: 0, interruptedCount: 0 }],
    };
    const transcriptToolCounts = stubUnscopedAdapter(resolvedCounts);
    // True on purpose: a guard that asked about the null id would get "this is a
    // resume" back and skip the read, which is the regression this pins.
    const { repo, updateTranscriptToolCounts } = makeStubRepo({ agent_session_id: null }, true);

    refineTranscriptToolCounts(makeStubManager(), repo, 'session-1', 'record-1');
    await drainTranscriptReadQueueForTests();

    expect(repo.hasEarlierRecordOfConversation).not.toHaveBeenCalled();
    expect(transcriptToolCounts).toHaveBeenCalledOnce();
    expect(transcriptToolCounts).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: null,
      transcriptPath: '/path/to/transcript.jsonl',
    }));
    expect(updateTranscriptToolCounts).toHaveBeenCalledWith('record-1', resolvedCounts);
  });

  it('is the null id that lifts the skip: the same record with an id and an earlier run is not read', async () => {
    // The control. Without it the case above could pass because the skip guard
    // never applied to this adapter at all.
    const transcriptToolCounts = stubUnscopedAdapter({ toolCallCount: 40, toolBreakdown: [] });
    const { repo, updateTranscriptToolCounts } = makeStubRepo({ agent_session_id: 'conversation-1' }, true);

    refineTranscriptToolCounts(makeStubManager(), repo, 'session-1', 'record-1');
    await drainTranscriptReadQueueForTests();

    expect(repo.hasEarlierRecordOfConversation).toHaveBeenCalledWith('record-1', 'conversation-1');
    expect(transcriptToolCounts).not.toHaveBeenCalled();
    expect(updateTranscriptToolCounts).not.toHaveBeenCalled();
  });
});

describe('fillEarlierRunResultTokens when the database write throws', () => {
  const RUN_1_STARTED_AT = '2026-10-05T08:00:00.000Z';
  /** The live session's in-memory start: where the earlier run's window ends. */
  const LIVE_STARTED_AT = '2026-10-05T10:00:00.000Z';
  const LIVE_SESSION_ID = 'live-session';
  /** When a stubbed write fails; any clock value works, the retry wait is measured from it. */
  const FAILED_AT_MS = 1_000_000;

  /** Calls, Time and Failed stored at quit, no Tokens. */
  const QUIT_ENDED_ROWS: PerToolStat[] = [
    { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0 },
    { toolName: 'Grep', callCount: 25, totalDurationMs: 5800, interruptedCount: 0 },
  ];

  let db: Database.Database;
  let repository: SessionRepository;

  function makeManager(): SessionManager {
    return {
      getSession: vi.fn((sessionId: string) => (sessionId === LIVE_SESSION_ID
        ? { id: LIVE_SESSION_ID, taskId: 'task-a', isolatedSwimlaneId: null, startedAt: LIVE_STARTED_AT }
        : undefined)),
      getSessionAgentName: vi.fn(() => 'stub-agent'),
      getUsageCache: vi.fn(() => ({})),
    } as unknown as SessionManager;
  }

  beforeEach(() => {
    resetResultTokenFillsForTests();
    db = openMigratedProjectDatabase();
    repository = new SessionRepository(db);
    insertTask(db, 'task-a');
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
  });

  afterEach(() => {
    db?.close();
  });

  it('retries the failed merge after the wait, so the next read asks the transcript again and keeps the estimates', async () => {
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();
    const now = vi.spyOn(Date, 'now').mockReturnValue(FAILED_AT_MS);
    // The project database closed under the write.
    vi.spyOn(repository, 'mergeTranscriptResultTokens').mockImplementationOnce(() => {
      throw new Error('The database connection is not open');
    });

    const firstAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(firstAttempt).toBe(false);
    expect(readStoredToolRows(db, 'run-1')[0]).not.toHaveProperty('resultTokens');

    now.mockReturnValue(FAILED_AT_MS + FAILED_FILL_RETRY_MS);
    const secondAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });

    // A failure settled for the rest of the launch would hand the second caller
    // the first one's answer: one adapter call and a false.
    expect(transcriptToolResultTokens).toHaveBeenCalledTimes(2);
    expect(secondAttempt).toBe(true);
    expect(readStoredToolRows(db, 'run-1')[0].resultTokens).toBe(57_900);
  });

  it('retries a failed read-marker write after the wait, so the next read persists it', async () => {
    // An answer with nothing to keep: the merge changes nothing, so the fill
    // goes on to persist `result_tokens_read_at`, and that write throws.
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({});
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();
    const now = vi.spyOn(Date, 'now').mockReturnValue(FAILED_AT_MS);
    vi.spyOn(repository, 'markResultTokensRead').mockImplementationOnce(() => {
      throw new Error('The database connection is not open');
    });

    const firstAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(firstAttempt).toBe(false);
    expect(readResultTokensReadAt(db, 'run-1')).toBeNull();

    now.mockReturnValue(FAILED_AT_MS + FAILED_FILL_RETRY_MS);
    const secondAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });

    expect(secondAttempt).toBe(false);
    expect(transcriptToolResultTokens).toHaveBeenCalledTimes(2);
    expect(readResultTokensReadAt(db, 'run-1')).not.toBeNull();
  });
});
