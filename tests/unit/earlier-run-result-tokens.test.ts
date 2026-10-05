/**
 * Tests for the earlier-run Tokens fill and the track total behind
 * `sessions.getToolResultTokens` (src/main/ipc/handlers/session-metrics.ts):
 * `fillEarlierRunResultTokens` and `readTranscriptToolResultTokens`.
 *
 * A run that ends at app quit stores Calls, Time and Failed but no Tokens: the
 * run-end transcript read never runs on the synchronous quit path. After the
 * restart its session resumes as a new record, and the popover's table must
 * still show that run's Tokens. The fill reads each such record's estimates
 * from its own transcript window, `[its start, the next run's start)`, because
 * Claude appends every `--resume` to one transcript.
 *
 * Real in-memory database; the retrieval worker's own handler runs in-process
 * over a spied agent registry, as in session-metrics-tool-result-tokens.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { agentRegistry } from '../../src/main/agent/agent-registry';

vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
import { retrievalClient } from '../../src/main/retrieval/retrieval-client';
import {
  FAILED_FILL_RETRY_MS,
  fillEarlierRunResultTokens,
  readTranscriptToolResultTokens,
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
import type { PerToolStat } from '../../src/shared/types';

const RUN_1_STARTED_AT = '2026-10-05T08:00:00.000Z';
const RUN_2_STARTED_AT = '2026-10-05T09:00:00.000Z';
/** The live session's in-memory start: the boundary both reads share. */
const LIVE_STARTED_AT = '2026-10-05T10:00:00.000Z';
const LIVE_SESSION_ID = 'live-session';
/** When a stubbed read fails; any clock value works, the wait is measured from it. */
const FAILED_AT_MS = 1_000_000;

let db: Database.Database;
let repository: SessionRepository;

/** Calls, Time and Failed stored at quit, no Tokens. */
const QUIT_ENDED_ROWS: PerToolStat[] = [
  { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0 },
  { toolName: 'Grep', callCount: 25, totalDurationMs: 5800, interruptedCount: 0 },
];

function makeManager(liveAgentName = 'stub-agent', liveCwd?: string): SessionManager {
  return {
    getSession: vi.fn((sessionId: string) => (sessionId === LIVE_SESSION_ID
      ? { id: LIVE_SESSION_ID, taskId: 'task-a', isolatedSwimlaneId: null, startedAt: LIVE_STARTED_AT, cwd: liveCwd }
      : undefined)),
    getSessionAgentName: vi.fn(() => liveAgentName),
    getUsageCache: vi.fn(() => ({})),
  } as unknown as SessionManager;
}

/** A manager that no longer holds the live session: only its record in the database is left. */
function makeManagerWithoutLiveSession(): SessionManager {
  return {
    getSession: vi.fn(() => undefined),
    getSessionAgentName: vi.fn(() => 'stub-agent'),
    getUsageCache: vi.fn(() => ({})),
  } as unknown as SessionManager;
}

/** The cwds a stubbed transcript read was asked for, in call order. */
function cwdsRead(transcriptRead: ReturnType<typeof vi.fn>): Array<string | null | undefined> {
  return transcriptRead.mock.calls.map(([input]) => (input as { cwd?: string | null }).cwd);
}

/** A stored estimate on a record, so it needs no fill of its own. */
const FILLED_ROWS: PerToolStat[] = [{ toolName: 'Bash', callCount: 1, totalDurationMs: 10, interruptedCount: 0, resultTokens: 50 }];

beforeEach(() => {
  resetResultTokenFillsForTests();
  db = openMigratedProjectDatabase();
  repository = new SessionRepository(db);
  insertTask(db, 'task-a');
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
});

describe('fillEarlierRunResultTokens', () => {
  it('fills a quit-ended run from its own window, up to the next run\'s start', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: [{ toolName: 'Bash', callCount: 2, totalDurationMs: 7700, interruptedCount: 0, resultTokens: 1700 }] });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900, Grep: 13_700 });
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(true);
    // run-2 already carries estimates, so only run-1 is read, and only its window.
    expect(transcriptToolResultTokens).toHaveBeenCalledOnce();
    expect(transcriptToolResultTokens).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'conversation-1',
      cwd: '/mock/project',
      sinceMs: Date.parse(RUN_1_STARTED_AT),
      untilMs: Date.parse(RUN_2_STARTED_AT),
    }));
    expect(readStoredToolRows(db, 'run-1')).toEqual([
      { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0, resultTokens: 57_900 },
      { toolName: 'Grep', callCount: 25, totalDurationMs: 5800, interruptedCount: 0, resultTokens: 13_700 },
    ]);
  });

  it('ends the newest earlier window exactly where the live read starts', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: '2026-10-05T10:00:01.500Z', toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({});
    stubScopedAdapter(transcriptToolResultTokens);

    await readTranscriptToolResultTokens(makeManager(), repository, LIVE_SESSION_ID);

    // The record's started_at is stamped after the spawn; the live read starts
    // from the in-memory session, and the earlier window must end on that same
    // number or a call between them is dropped or counted twice.
    const earlierCall = transcriptToolResultTokens.mock.calls.find(([input]) => input.untilMs !== undefined);
    const liveCall = transcriptToolResultTokens.mock.calls.find(([input]) => input.untilMs === undefined);
    expect(earlierCall?.[0].untilMs).toBe(Date.parse(LIVE_STARTED_AT));
    expect(liveCall?.[0].sinceMs).toBe(Date.parse(LIVE_STARTED_AT));
  });

  it('skips a run whose agent cannot estimate Tokens', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolCounts = vi.fn();
    vi.spyOn(agentRegistry, 'getBySessionType').mockReturnValue({ name: 'counts-only', transcriptToolCounts } as unknown as AgentAdapter);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(false);
    expect(transcriptToolCounts).not.toHaveBeenCalled();
    expect(readStoredToolRows(db, 'run-1')[0]).not.toHaveProperty('resultTokens');
  });

  it.each<[string, PerToolStat[] | null]>([
    ['no stored table', null],
    ['an empty stored table', []],
  ])('never reads the transcript of an earlier run with %s, since it has no row to take an estimate', async (_label, toolBreakdown) => {
    // Otherwise eligible: a scoped agent, an agent session id and a cwd. Reading would
    // parse a whole transcript to find nothing a row could keep, then stamp it read.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(false);
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
    expect(readResultTokensReadAt(db, 'run-1')).toBeNull();
  });

  it('skips an earlier run of an agent type the registry no longer knows, and still fills the other runs', async () => {
    insertSessionRecord(db, { id: 'run-1', sessionType: 'removed_agent', agentSessionId: 'conversation-removed', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900, Grep: 13_700 });
    stubScopedAdapter(transcriptToolResultTokens);
    // Only the stub's own session type resolves, as after an agent was dropped from the product.
    const stubAdapter = agentRegistry.getBySessionType('stub_agent');
    vi.mocked(agentRegistry.getBySessionType).mockImplementation((sessionType) => (sessionType === 'stub_agent' ? stubAdapter : undefined));

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(true);
    expect(transcriptToolResultTokens).toHaveBeenCalledOnce();
    expect(transcriptToolResultTokens).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'conversation-1' }));
    expect(readStoredToolRows(db, 'run-1')[0]).not.toHaveProperty('resultTokens');
    expect(readStoredToolRows(db, 'run-2')[0].resultTokens).toBe(57_900);
  });

  it('shares one read between concurrent callers', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 100 });
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();

    // The spawn starts a fill and the user opens the popover before it lands.
    await Promise.all([
      fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: true }),
      fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false }),
    ]);

    expect(transcriptToolResultTokens).toHaveBeenCalledOnce();
  });

  it('skips a run whose agent estimates Tokens but cannot scope its reads by time', async () => {
    // An unscoped read holds every run of the conversation, so the earlier
    // run's record would take the later runs' Tokens too.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 1 });
    const unscoped = { name: 'unscoped-agent', transcriptToolResultTokens } as unknown as AgentAdapter;
    vi.spyOn(agentRegistry, 'get').mockReturnValue(unscoped);
    vi.spyOn(agentRegistry, 'getBySessionType').mockReturnValue(unscoped);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(false);
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
  });

  it('looks for a transcript it cannot find once per launch, without persisting that', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    // A pruned transcript: null at every cwd. Cheap to establish, and a null
    // can also be a read that failed partway, so it must not stick.
    const transcriptToolResultTokens = vi.fn().mockResolvedValue(null);
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();

    await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(transcriptToolResultTokens).toHaveBeenCalledOnce();
    expect(readResultTokensReadAt(db, 'run-1')).toBeNull();

    // The next launch looks again.
    resetResultTokenFillsForTests();
    await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(transcriptToolResultTokens).toHaveBeenCalledTimes(2);
  });

  it('persists a read that answered with nothing to keep, so no later launch parses it again', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    // The transcript was read whole: none of the window's calls returned a result.
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({});
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();

    const changed = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(changed).toBe(false);
    expect(readResultTokensReadAt(db, 'run-1')).not.toBeNull();

    resetResultTokenFillsForTests();
    await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    expect(transcriptToolResultTokens).toHaveBeenCalledOnce();
  });

  it('finds a renamed worktree\'s transcript under a later run\'s cwd of the same conversation', async () => {
    // Resuming in a renamed worktree moved the conversation's history to the new
    // cwd, so run-1's own cwd no longer leads to it.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, cwd: '/mock/old-worktree' });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: [{ toolName: 'Bash', callCount: 1, totalDurationMs: 10, interruptedCount: 0, resultTokens: 50 }], cwd: '/mock/renamed-worktree' });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null, cwd: '/mock/renamed-worktree' });
    const transcriptToolResultTokens = vi.fn(async (input: { cwd?: string | null }) => (
      input.cwd === '/mock/renamed-worktree' ? { Read: 57_900, Grep: 13_700 } : null
    ));
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(true);
    expect(transcriptToolResultTokens.mock.calls.map(([input]) => input.cwd)).toEqual(['/mock/old-worktree', '/mock/renamed-worktree']);
    expect(readStoredToolRows(db, 'run-1')[0].resultTokens).toBe(57_900);
  });

  it('reads again after a read that failed instead of answering, once the retry wait has passed', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();
    const now = vi.spyOn(Date, 'now').mockReturnValue(FAILED_AT_MS);
    // The resume pass fires the fill at startup, while the worker may still be
    // restarting: that rejection is no answer, so it must not mark the run tried.
    vi.mocked(retrievalClient.call).mockRejectedValueOnce(new Error('The retrieval worker is restarting'));

    const firstAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    now.mockReturnValue(FAILED_AT_MS + FAILED_FILL_RETRY_MS);
    const secondAttempt = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });

    expect(firstAttempt).toBe(false);
    expect(secondAttempt).toBe(true);
    expect(readStoredToolRows(db, 'run-1')[0].resultTokens).toBe(57_900);
    expect(readResultTokensReadAt(db, 'run-1')).toBeNull();
  });

  it('answers false without reading while a failed read waits to be retried', async () => {
    // The popover reads on every tool call. A read that keeps failing (the
    // worker restarting) must not be retried that often.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);
    const manager = makeManager();
    const now = vi.spyOn(Date, 'now').mockReturnValue(FAILED_AT_MS);
    vi.mocked(retrievalClient.call).mockRejectedValueOnce(new Error('The retrieval worker is restarting'));
    await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });

    // One second later: a fixed moment, not one derived from the wait, so a
    // wait shortened to nothing reads here and fails the test.
    now.mockReturnValue(FAILED_AT_MS + 1_000);
    const unqueued = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: false });
    const queued = await fillEarlierRunResultTokens(manager, repository, LIVE_SESSION_ID, { queued: true });

    expect(unqueued).toBe(false);
    expect(queued).toBe(false);
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
    expect(readStoredToolRows(db, 'run-1')[0].resultTokens).toBeUndefined();
  });
});

describe('fillEarlierRunResultTokens for a session that has left the manager', () => {
  // A session the manager no longer holds (it exited or was removed while its
  // fill or popover read was still pending) has only its record left. The track,
  // the end of the newest earlier window and the last cwd to look under all come
  // from that record, where every case above reads them from memory.
  const LIVE_RECORD_STARTED_AT = '2026-10-05T10:00:01.500Z';

  it('resolves the track, the window end and the live cwd from the record', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, cwd: '/mock/old-worktree' });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_RECORD_STARTED_AT, toolBreakdown: null, cwd: '/mock/live-worktree' });
    // The history only moved to the live cwd, which is not any earlier run's.
    const transcriptToolResultTokens = vi.fn(async (input: { cwd?: string | null }) => (
      input.cwd === '/mock/live-worktree' ? { Read: 57_900, Grep: 13_700 } : null
    ));
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManagerWithoutLiveSession(), repository, LIVE_SESSION_ID, { queued: false });

    // The fill ran at all: the track came from the record, not the manager.
    expect(changed).toBe(true);
    // The live record's cwd is the last one tried, after the run's own.
    expect(cwdsRead(transcriptToolResultTokens)).toEqual(['/mock/old-worktree', '/mock/live-worktree']);
    // The window ends where the live record starts, as it would on the live session's start.
    for (const [input] of transcriptToolResultTokens.mock.calls) {
      expect(input).toMatchObject({ sinceMs: Date.parse(RUN_1_STARTED_AT), untilMs: Date.parse(LIVE_RECORD_STARTED_AT) });
    }
    expect(readStoredToolRows(db, 'run-1')[0].resultTokens).toBe(57_900);
  });

  it('builds no window for the newest earlier run when the live record\'s start is not a date', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: 'not-a-date', toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManagerWithoutLiveSession(), repository, LIVE_SESSION_ID, { queued: false });

    // A window with no known end would take every later run's calls into this one.
    expect(changed).toBe(false);
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
    expect(readStoredToolRows(db, 'run-1')[0]).not.toHaveProperty('resultTokens');
  });
});

describe('the cwds an earlier run\'s transcript is looked for under', () => {
  // Every case answers null at every cwd, so the whole candidate list is tried
  // and read back. An answer at the first cwd would stop the loop and hide a
  // wrong or repeated entry behind it.
  it('never includes a later run of a different conversation', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, cwd: '/mock/project' });
    insertSessionRecord(db, {
      id: 'run-2',
      startedAt: RUN_2_STARTED_AT,
      toolBreakdown: FILLED_ROWS,
      cwd: '/mock/other-conversation-worktree',
      agentSessionId: 'conversation-2',
    });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue(null);
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    // That cwd holds another conversation's history, never run-1's transcript.
    expect(changed).toBe(false);
    expect(cwdsRead(transcriptToolResultTokens)).toEqual(['/mock/project']);
  });

  it('reads a cwd once when the run, a later run of its conversation and the live session share it', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, cwd: '/mock/project' });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: FILLED_ROWS, cwd: '/mock/project' });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null, cwd: '/mock/project' });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue(null);
    stubScopedAdapter(transcriptToolResultTokens);

    await fillEarlierRunResultTokens(makeManager('stub-agent', '/mock/project'), repository, LIVE_SESSION_ID, { queued: false });

    // Three candidates, one cwd: a repeat would parse the same missing file again.
    expect(cwdsRead(transcriptToolResultTokens)).toEqual(['/mock/project']);
  });

  it('tries the later runs of the conversation newest first, then the live session\'s cwd', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, cwd: '/mock/old-worktree' });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: FILLED_ROWS, cwd: '/mock/middle-worktree' });
    insertSessionRecord(db, { id: 'run-3', startedAt: '2026-10-05T09:30:00.000Z', toolBreakdown: FILLED_ROWS, cwd: '/mock/newest-worktree' });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue(null);
    stubScopedAdapter(transcriptToolResultTokens);

    await fillEarlierRunResultTokens(makeManager('stub-agent', '/mock/live-worktree'), repository, LIVE_SESSION_ID, { queued: false });

    // The newest later run's cwd is the likeliest to hold a moved history.
    expect(cwdsRead(transcriptToolResultTokens)).toEqual([
      '/mock/old-worktree',
      '/mock/newest-worktree',
      '/mock/middle-worktree',
      '/mock/live-worktree',
    ]);
  });

  it.each([
    ['no agent session id', { agentSessionId: null }],
    // The column is NOT NULL, so a record with no cwd stores an empty one.
    ['no cwd', { cwd: '' }],
    ['a start that is not a date', { startedAt: 'not-a-date' }],
  ])('builds no window for an earlier run with %s, so its transcript is never read', async (_label, overrides) => {
    // Otherwise eligible: it has stored rows with no estimate and an agent that can fill them.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS, ...overrides });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    const transcriptToolResultTokens = vi.fn().mockResolvedValue({ Read: 57_900 });
    stubScopedAdapter(transcriptToolResultTokens);

    const changed = await fillEarlierRunResultTokens(makeManager(), repository, LIVE_SESSION_ID, { queued: false });

    expect(changed).toBe(false);
    expect(transcriptToolResultTokens).not.toHaveBeenCalled();
    expect(readStoredToolRows(db, 'run-1')[0]).not.toHaveProperty('resultTokens');
  });
});

describe('readTranscriptToolResultTokens across runs', () => {
  it('adds the earlier runs\' estimates, filled where missing, to the live run\'s', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: 'run-2', startedAt: RUN_2_STARTED_AT, toolBreakdown: [{ toolName: 'Read', callCount: 1, totalDurationMs: 10, interruptedCount: 0, resultTokens: 100 }] });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    stubScopedAdapter(vi.fn(async (input: { untilMs?: number | null }) => (
      // The earlier window, then the live run's open one.
      input.untilMs !== undefined && input.untilMs !== null ? { Read: 57_900, Grep: 13_700 } : { Read: 5, Write: 43 }
    )));

    const tokens = await readTranscriptToolResultTokens(makeManager(), repository, LIVE_SESSION_ID);

    expect(tokens).toEqual({ Read: 57_900 + 100 + 5, Grep: 13_700, Write: 43 });
  });

  it('keeps the earlier runs\' Tokens when the live agent cannot estimate them', async () => {
    // An agent switch on the main track: the earlier run was the estimating agent's.
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: [{ toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0, resultTokens: 57_900 }] });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ name: 'counts-only' } as unknown as AgentAdapter);

    const tokens = await readTranscriptToolResultTokens(makeManager('counts-only'), repository, LIVE_SESSION_ID);

    expect(tokens).toEqual({ Read: 57_900 });
  });

  it('still answers with the live run\'s estimates when reading the earlier runs throws', async () => {
    insertSessionRecord(db, { id: 'run-1', startedAt: RUN_1_STARTED_AT, toolBreakdown: QUIT_ENDED_ROWS });
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    stubScopedAdapter(vi.fn(async () => ({ Read: 5, Write: 43 })));
    vi.spyOn(repository, 'getEarlierRunToolTotals').mockImplementation(() => {
      throw new Error('The database connection is not open');
    });

    const tokens = await readTranscriptToolResultTokens(makeManager(), repository, LIVE_SESSION_ID);

    expect(tokens).toEqual({ Read: 5, Write: 43 });
  });

  it('is null when no run has an estimate', async () => {
    insertSessionRecord(db, { id: LIVE_SESSION_ID, startedAt: LIVE_STARTED_AT, toolBreakdown: null });
    vi.spyOn(agentRegistry, 'get').mockReturnValue({ name: 'counts-only' } as unknown as AgentAdapter);

    expect(await readTranscriptToolResultTokens(makeManager('counts-only'), repository, LIVE_SESSION_ID)).toBeNull();
  });
});
