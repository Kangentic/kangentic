/**
 * The popover's earlier-run Tokens read never waits behind another session's
 * background transcript read (src/main/ipc/handlers/session-metrics.ts,
 * `resultTokenFills`).
 *
 * The spawn queues its fill on the shared background queue (concurrency 1).
 * When the popover's read, which a user is waiting on, finds that fill still
 * waiting there, it reads at once instead of sharing it, and the queued fill
 * stands down when its turn comes: it neither reads the same window again nor
 * waits inside its queue slot, which would stall every later background read.
 *
 * Two tasks share the queue: task b's fill is in flight and blocked on its
 * transcript read, so task a's queued fill waits behind it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
import { retrievalClient } from '../../src/main/retrieval/retrieval-client';
import {
  FAILED_FILL_RETRY_MS,
  drainTranscriptReadQueueForTests,
  fillEarlierRunResultTokens,
  readTranscriptToolResultTokens,
  resetResultTokenFillsForTests,
} from '../../src/main/ipc/handlers/session-metrics';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import {
  insertSessionRecord,
  insertTask,
  openMigratedProjectDatabase,
  readStoredToolRows,
  stubScopedAdapter,
} from './helpers/earlier-run-fixture';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { PerToolStat } from '../../src/shared/types';

const EARLIER_RUN_STARTED_AT = '2026-10-05T08:00:00.000Z';
const LIVE_STARTED_AT = '2026-10-05T10:00:00.000Z';

/** Calls, Time and Failed stored at quit, no Tokens. */
const QUIT_ENDED_ROWS: PerToolStat[] = [
  { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0 },
];

/** Long enough for an in-process read under CI load, short of the test timeout. */
const STILL_WAITING_AFTER_MS = 2000;
/** When a stubbed read fails; any clock value works, the retry wait is measured from it. */
const FAILED_AT_MS = 1_000_000;

let db: Database.Database;
let repository: SessionRepository;

const LIVE_SESSIONS: Record<string, { taskId: string }> = {
  'live-a': { taskId: 'task-a' },
  'live-b': { taskId: 'task-b' },
};

function makeManager(): SessionManager {
  return {
    getSession: vi.fn((sessionId: string) => {
      const live = LIVE_SESSIONS[sessionId];
      return live ? { id: sessionId, taskId: live.taskId, isolatedSwimlaneId: null, startedAt: LIVE_STARTED_AT, cwd: '/mock/project' } : undefined;
    }),
    getSessionAgentName: vi.fn(() => 'stub-agent'),
    getUsageCache: vi.fn(() => ({})),
  } as unknown as SessionManager;
}

interface TranscriptReadInput {
  agentSessionId?: string | null;
  untilMs?: number | null;
}

/**
 * The adapter behind every read. Task b's earlier window blocks until
 * `releaseTaskB` runs; task a's earlier window answers at once, and every live
 * (open) window answers a small estimate.
 */
function stubAdapter(): { transcriptToolResultTokens: ReturnType<typeof vi.fn>; releaseTaskB: () => void } {
  let releaseTaskB: () => void = () => undefined;
  const taskBBlocked = new Promise<Record<string, number>>((resolve) => {
    releaseTaskB = () => resolve({ Read: 1 });
  });
  const transcriptToolResultTokens = vi.fn(async (input: TranscriptReadInput) => {
    if (input.untilMs === undefined || input.untilMs === null) return { Read: 5 };
    if (input.agentSessionId === 'conversation-b') return taskBBlocked;
    return { Read: 57_900 };
  });
  stubScopedAdapter(transcriptToolResultTokens);
  return { transcriptToolResultTokens, releaseTaskB: () => releaseTaskB() };
}

function earlierWindowReadsOf(transcriptToolResultTokens: ReturnType<typeof vi.fn>, conversationId: string): number {
  return transcriptToolResultTokens.mock.calls.filter(([input]) => (
    (input as TranscriptReadInput).agentSessionId === conversationId
    && (input as TranscriptReadInput).untilMs !== undefined
    && (input as TranscriptReadInput).untilMs !== null
  )).length;
}

function stillWaiting(): Promise<'still waiting'> {
  return new Promise((resolve) => setTimeout(() => resolve('still waiting'), STILL_WAITING_AFTER_MS));
}

beforeEach(() => {
  resetResultTokenFillsForTests();
  db = openMigratedProjectDatabase();
  repository = new SessionRepository(db);
  insertTask(db, 'task-a');
  insertTask(db, 'task-b');
  insertSessionRecord(db, { id: 'run-a1', taskId: 'task-a', agentSessionId: 'conversation-a', startedAt: EARLIER_RUN_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
  insertSessionRecord(db, { id: 'live-a', taskId: 'task-a', agentSessionId: 'conversation-a', startedAt: LIVE_STARTED_AT, toolBreakdown: null });
  insertSessionRecord(db, { id: 'run-b1', taskId: 'task-b', agentSessionId: 'conversation-b', startedAt: EARLIER_RUN_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
  insertSessionRecord(db, { id: 'live-b', taskId: 'task-b', agentSessionId: 'conversation-b', startedAt: LIVE_STARTED_AT, toolBreakdown: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
});

describe('the popover\'s earlier-run Tokens read and the background queue', () => {
  it('reads at once past a queued fill that waits behind another session\'s read, which then stands down', async () => {
    const { transcriptToolResultTokens, releaseTaskB } = stubAdapter();
    const manager = makeManager();

    // Task b's spawn fill takes the queue's only slot and blocks; task a's
    // spawn fill queues behind it.
    const taskBFill = fillEarlierRunResultTokens(manager, repository, 'live-b', { queued: true });
    const taskAQueuedFill = fillEarlierRunResultTokens(manager, repository, 'live-a', { queued: true });

    // Task a's popover opens while both are pending.
    const popoverRead = readTranscriptToolResultTokens(manager, repository, 'live-a');
    const answered = await Promise.race([popoverRead, stillWaiting()]);

    expect(answered).toEqual({ Read: 57_900 + 5 });
    expect(readStoredToolRows(db, 'run-a1')[0].resultTokens).toBe(57_900);

    releaseTaskB();
    await drainTranscriptReadQueueForTests();

    // The queued fill found itself overtaken and read nothing.
    expect(await taskAQueuedFill).toBe(false);
    expect(await taskBFill).toBe(true);
    expect(earlierWindowReadsOf(transcriptToolResultTokens, 'conversation-a')).toBe(1);
  });

  it('keeps the queue moving when the overtaking read fails and a later spawn queues the run again', async () => {
    const { transcriptToolResultTokens, releaseTaskB } = stubAdapter();
    const manager = makeManager();

    const taskBFill = fillEarlierRunResultTokens(manager, repository, 'live-b', { queued: true });
    const firstQueuedFill = fillEarlierRunResultTokens(manager, repository, 'live-a', { queued: true });

    // The popover's read overtakes the first queued fill, then fails (the
    // worker was restarting), which marks the run failed so a read after the
    // retry wait reads it again.
    const now = vi.spyOn(Date, 'now').mockReturnValue(FAILED_AT_MS);
    vi.mocked(retrievalClient.call).mockRejectedValueOnce(new Error('The retrieval worker is restarting'));
    const overtakingFill = await Promise.race([
      fillEarlierRunResultTokens(manager, repository, 'live-a', { queued: false }),
      stillWaiting(),
    ]);
    expect(overtakingFill).toBe(false);

    // After the wait, a later spawn queues the run again, behind the first
    // queued fill.
    now.mockReturnValue(FAILED_AT_MS + FAILED_FILL_RETRY_MS);
    const secondQueuedFill = fillEarlierRunResultTokens(manager, repository, 'live-a', { queued: true });

    releaseTaskB();
    // The first queued fill must stand down without waiting on the second one
    // inside its queue slot, or the queue would never drain.
    const drained = await Promise.race([drainTranscriptReadQueueForTests().then(() => 'drained' as const), stillWaiting()]);

    expect(drained).toBe('drained');
    expect(await taskBFill).toBe(true);
    expect(await firstQueuedFill).toBe(false);
    expect(await secondQueuedFill).toBe(true);
    expect(earlierWindowReadsOf(transcriptToolResultTokens, 'conversation-a')).toBe(1);
    expect(readStoredToolRows(db, 'run-a1')[0].resultTokens).toBe(57_900);
  });
});
