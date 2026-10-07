import PQueue from 'p-queue';
import { agentRegistry } from '../../agent/agent-registry';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { parseToolBreakdown, type EarlierRunRecord, type SessionRepository } from '../../db/repositories/session-repository';
import { sumToolResultTokens } from '../../../shared/tool-call-totals';
import type { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import type { SessionManager } from '../../pty/session-manager';
import type { SessionRecord } from '../../../shared/types';

/**
 * Capture session metrics (cost, tokens, model, duration, tool calls,
 * compactions) from the in-memory caches and persist them to the session
 * record in the DB.
 *
 * Synchronous on purpose: better-sqlite3 is sync, and this runs on the
 * synchronous shutdown path and inside `withTaskLock` regions, so it must not
 * await. The cumulative-token refinement that needs a file read is split out
 * into the fire-and-forget {@link refineTranscriptTokens}; call it right after
 * this on the run-ending paths (exit / suspend / move-to-Done).
 *
 * Must be called BEFORE the session is removed from the manager (caches are
 * cleared on remove).
 *
 * Tokens written here are the live status-line SNAPSHOT (current context window,
 * not cumulative on Claude Code 2.1.132+). `refineTranscriptTokens` overwrites
 * them with the transcript-derived cumulative when available.
 *
 * When `usageCache[sessionId]` is empty (session exited before status.json
 * appeared, queued session that never spawned, etc.) the cost/token/model
 * columns are written as NULL instead of zero. This matters because
 * `getSummaryForTask` filters `WHERE total_cost_usd IS NOT NULL` to pick the
 * latest meaningful record - a zero row would mask a prior real one. The
 * tool_call_count and compaction_count are always written because they are
 * derived from counters that are accurate independently of usage telemetry.
 *
 * The same record is also written to `usage_history` whenever metrics were
 * actually captured (i.e. `usage` is defined) so that lifetime period totals
 * survive task and session deletion. The gate is `if (usage)`, NOT `cost > 0`:
 * subscription users (Claude Plus/Max) report cost = 0 with real token counts.
 * `usage_history` intentionally keeps the per-capture SNAPSHOT tokens (period
 * stats SUM across rows; cumulative-per-lineage tokens would double-count across
 * a session's `--resume` rows). The transcript cumulative lives only in the
 * `sessions` table, where `getSummaryForTask` dedups it latest-per-session.
 *
 * Best-effort: swallows all errors so it never breaks the calling flow.
 */
export function captureSessionMetrics(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  usageHistoryRepo: UsageHistoryRepository,
  sessionId: string,
  recordId: string,
  sessionStartedAt: string,
  sessionType: string | null,
): void {
  try {
    const usage = sessionManager.getUsageCache()[sessionId];
    const toolCallCount = sessionManager.getToolCallCount(sessionId);
    const toolBreakdown = sessionManager.getToolBreakdown(sessionId);
    const compactionCount = sessionManager.getCompactionCount(sessionId);

    sessionRepo.updateMetrics(recordId, {
      totalCostUsd: usage?.cost.totalCostUsd ?? null,
      totalInputTokens: usage?.contextWindow.totalInputTokens ?? null,
      totalOutputTokens: usage?.contextWindow.totalOutputTokens ?? null,
      modelId: usage?.model.id ?? null,
      modelDisplayName: usage?.model.displayName ?? null,
      totalDurationMs: usage?.cost.totalDurationMs ?? null,
      toolCallCount,
      toolBreakdown: toolBreakdown.length > 0 ? JSON.stringify(toolBreakdown) : null,
      compactionCount,
    });

    if (usage) {
      // One lookup for both lineage and effort: the record is the ground truth
      // for each, and the shutdown path runs this synchronously.
      const record = sessionRepo.findByAnyId(recordId);
      usageHistoryRepo.recordSessionUsage({
        sessionRecordId: recordId,
        sessionStartedAt,
        sessionType,
        // The conversation this record is one leg of. Both the resume-time
        // reconcile and the stale-ID recovery keep this pointed at the CLI's
        // CURRENT id, so a `/clear` fork starts a new lineage. The repository
        // needs it to turn the cumulative readings below into per-leg deltas.
        conversationId: record?.agent_session_id ?? null,
        // Cumulative for the whole conversation, not this leg - the repository
        // does the subtraction.
        cumulativeCostUsd: usage.cost.totalCostUsd,
        totalInputTokens: usage.contextWindow.totalInputTokens ?? 0,
        totalOutputTokens: usage.contextWindow.totalOutputTokens ?? 0,
        cumulativeDurationMs: usage.cost.totalDurationMs ?? null,
        toolCallCount,
        modelId: usage.model.id ?? null,
        modelDisplayName: usage.model.displayName ?? null,
        compactionCount,
        // Generic manager-recorded agent name (agent-adapters-boundary rule:
        // no per-agent branching; null when the manager no longer knows it,
        // COALESCE in the upsert keeps a previously-stamped value).
        agent: sessionManager.getSessionAgentName(sessionId) ?? null,
        // Last-applied effort from the session record (spawn/resume ground
        // truth; null = agent default). Attributes the whole session to
        // its final effort - same snapshot semantics as model_id above.
        effort: record?.applied_effort ?? null,
      });
    }
  } catch {
    // Metrics capture is best-effort -- never break the calling flow
  }
}

/**
 * Serializes every transcript read these two backfills issue, process-wide.
 *
 * They are fired back to back on the same session record from every run-ending
 * path (suspend / move / reconcile), and both are deliberately un-awaited so
 * file I/O stays outside the `withTaskLock` region. The consequence was that
 * ONE card move launched two concurrent whole-file reads of the SAME
 * transcript, and a multi-card drag or a reconcile sweep multiplied that by the
 * number of sessions ending together, with nothing serializing them.
 *
 * Concurrency 1 rather than a higher cap: these are best-effort background
 * backfills with no latency requirement, and the whole point is that N ending
 * sessions cannot stack N transcript reads on the main process at once.
 * Callers stay un-awaited, so the lock-region design is unchanged - only the
 * reads queue.
 */
const transcriptReadQueue = new PQueue({ concurrency: 1 });

/** Test-only: wait for every queued transcript backfill to finish. */
export function drainTranscriptReadQueueForTests(): Promise<void> {
  return transcriptReadQueue.onIdle();
}

/** One earlier-run Tokens fill started this launch (see `resultTokenFills`). */
interface ResultTokenFill {
  /** Whether the record changed; never rejects. */
  settled: Promise<boolean>;
  /**
   * True while a fill the spawn queued waits behind other sessions'
   * background reads. A caller a user is waiting on overtakes it.
   */
  waitingInQueue: boolean;
  /** When the fill failed, as epoch ms (see FAILED_FILL_RETRY_MS); null otherwise. */
  failedAtMs: number | null;
}

/**
 * How long a failed fill (the worker restarting, a read error, the database
 * closing under the write) keeps answering false before a caller reads again.
 * The popover reads on every tool call, so without the wait a read that keeps
 * failing would be retried as often as the agent calls tools.
 */
export const FAILED_FILL_RETRY_MS = 10_000;

/**
 * The earlier-run Tokens fills started this launch, by record id. A second
 * caller shares a fill that is reading or has settled, so one transcript
 * window is read once. The exception is a fill the spawn queued that has not
 * started: the popover's read, which a user is waiting on, reads at once
 * instead and takes the entry, and the queued fill stands down when its turn
 * comes. A settled entry also stops a record whose transcript cannot be found
 * (pruned, or moved where no recorded cwd leads) from being looked for again
 * this launch; that check is cheap, so it is not persisted. A read that
 * answered is persisted instead (estimates on the rows, or
 * `result_tokens_read_at`), because re-reading it costs a whole transcript
 * parse. A failed fill keeps its entry, marked failed, so every caller shares
 * its false answer until FAILED_FILL_RETRY_MS has passed; the next caller
 * after that reads again.
 */
const resultTokenFills = new Map<string, ResultTokenFill>();

/** Test-only: forget every earlier-run Tokens fill between cases. */
export function resetResultTokenFillsForTests(): void {
  resultTokenFills.clear();
}

/** The adapter methods that read a run's transcript in the retrieval worker. */
type TranscriptReadCapability = 'transcriptUsage' | 'transcriptToolCounts' | 'transcriptToolResultTokens';

interface RunTranscriptLocation {
  agentName: string;
  transcriptPath: string | null;
  agentSessionId: string | null;
  cwd: string | null;
  record: SessionRecord | null;
}

/**
 * Where `sessionId`'s transcript is, for a read through `capability`. The path
 * the agent reported in status.json when there is one, else the record's agent
 * session id and cwd for the adapter to derive it from. Null when the session
 * has no agent, its adapter lacks the capability (so its transcript is never
 * read), or neither source exists. The adapter is resolved from the session's
 * recorded agent name, with no agent-name branching
 * (agent-adapters-boundary rule).
 */
function locateRunTranscript(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository | null,
  sessionId: string,
  recordId: string,
  capability: TranscriptReadCapability,
): RunTranscriptLocation | null {
  const agentName = sessionManager.getSessionAgentName(sessionId);
  if (!agentName) return null;
  if (!agentRegistry.get(agentName)?.[capability]) return null;
  const transcriptPath = sessionManager.getUsageCache()[sessionId]?.transcriptPath ?? null;
  const record = sessionRepo?.findByAnyId(recordId) ?? null;
  const agentSessionId = record?.agent_session_id ?? null;
  const cwd = record?.cwd ?? null;
  if (!transcriptPath && !(agentSessionId && cwd)) return null;
  return { agentName, transcriptPath, agentSessionId, cwd, record };
}

/**
 * Fire-and-forget refinement of a session record's cumulative token columns from
 * the agent's transcript (the authoritative lifetime token source; the snapshot
 * captured by {@link captureSessionMetrics} is current-context only). Call right
 * after `captureSessionMetrics` on the run-ending paths.
 *
 * Synchronous to invoke: it reads everything it needs (transcript path, agent
 * name, session record) up front, then kicks off the file parse + a token-only
 * DB write WITHOUT blocking - so it adds no latency to a `withTaskLock` region or
 * the suspend/move hot path, and the write (keyed by record id) is safe even
 * after the session is removed from the manager. Best-effort: any failure leaves
 * the snapshot tokens in place. Not used on the synchronous shutdown path (no
 * async work there); the next resume re-parses the full transcript anyway.
 *
 * The adapter is resolved generically from the session's recorded agent name -
 * no agent-name branching (agent-adapters-boundary rule); adapters without a
 * `transcriptUsage` capability are a no-op.
 */
export function refineTranscriptTokens(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
  recordId: string,
): void {
  // Fully best-effort: the synchronous prelude (manager/registry/repo reads)
  // must never throw into the caller (suspend / move / reconcile run this right
  // before marking the record suspended), so the whole body is guarded.
  try {
    const located = locateRunTranscript(sessionManager, sessionRepo, sessionId, recordId, 'transcriptUsage');
    if (!located) return;
    const { agentName, transcriptPath, agentSessionId, cwd } = located;

    // Read in the retrieval worker: a whole-file parse of a transcript that
    // can run to hundreds of MB, which used to stream through main.
    void transcriptReadQueue
      .add(() => retrievalClient.call('transcript.usage', { agentName, transcriptPath, agentSessionId, cwd }, { timeoutMs: null }))
      .then((transcriptUsage) => {
        if (!transcriptUsage) return;
        sessionRepo.updateTranscriptTokens(recordId, {
          totalInputTokens: transcriptUsage.inputTokens,
          totalOutputTokens: transcriptUsage.outputTokens,
        });
      })
      .catch(() => {
        // Best-effort: leave the snapshot tokens in place.
      });
  } catch {
    // Best-effort: never break the calling suspend/move/reconcile flow.
  }
}

/**
 * When this run of `sessionId` began, as epoch ms, for scoping a transcript
 * read to it: a transcript can hold every `--resume` of a conversation while a
 * session (and its record) covers one run, and the live accumulator restarts
 * at each spawn. The in-memory session's start, else the record's, else null
 * (whole transcript).
 *
 * Also where the newest earlier run's window ends (see `earlierRunWindows`).
 * The two must be the same number, or a call between them would be dropped
 * or counted twice, which is why both the live read and the earlier-run fill
 * take it from here.
 */
function runStartMs(
  sessionManager: SessionManager,
  sessionId: string,
  record: { started_at: string } | null | undefined,
): number | null {
  const startedAt = sessionManager.getSession(sessionId)?.startedAt ?? record?.started_at;
  if (!startedAt) return null;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Per-tool result-token estimates for a session's whole track, keyed by tool
 * name: the earlier runs' stored estimates plus the live run's, for the
 * ContextBar tool-call popover. The popover REPLACES each row's
 * `resultTokens` with this total; the merged rows' stored estimates are only
 * its first paint. The live hook events carry no token data, so the transcript
 * is the only source.
 *
 * Before summing, the earlier records that have no estimates yet (a run that
 * ended at app quit, where the transcript read never runs) are filled from
 * their own transcript windows, and the read waits for those fills. A fill
 * the spawn already started reading is shared, not repeated; one still
 * waiting in the background queue is overtaken (see `resultTokenFills`), so
 * the popover never waits behind another session's backfill.
 *
 * Resolves null when neither the live run nor an earlier run has an
 * estimate; a tool with no result yet is absent.
 */
export async function readTranscriptToolResultTokens(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository | null,
  sessionId: string,
): Promise<Record<string, number> | null> {
  const [live, earlier] = await Promise.all([
    readLiveRunToolResultTokens(sessionManager, sessionRepo, sessionId),
    readEarlierRunToolResultTokens(sessionManager, sessionRepo, sessionId),
  ]);
  return sumToolResultTokens([earlier, live]);
}

/**
 * The live run's estimates, scoped to the run (see {@link runStartMs}), so its
 * window starts exactly where the newest earlier run's ends.
 *
 * Gated on the adapter's `transcriptToolResultTokens` capability, so an agent
 * that cannot estimate them never has its transcript read here; the popover
 * refetches on every tool call. The adapter's cursor resumes from where its
 * last read stopped, so each refetch reads only the appended bytes.
 * Deliberately NOT queued on `transcriptReadQueue`: this is a user-initiated
 * read, and queueing it behind a run-end backfill of another session would
 * leave the popover's column blank for no reason. No timeout either, matching
 * the run-end caller: a first read of a very long transcript is legitimate
 * work, and the interactive budget would restart the worker over it.
 *
 * Null when the agent lacks the capability, no transcript can be located, or
 * the read failed.
 */
async function readLiveRunToolResultTokens(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository | null,
  sessionId: string,
): Promise<Record<string, number> | null> {
  try {
    const located = locateRunTranscript(sessionManager, sessionRepo, sessionId, sessionId, 'transcriptToolResultTokens');
    if (!located) return null;
    const { agentName, transcriptPath, agentSessionId, cwd, record } = located;

    return await retrievalClient.call(
      'transcript.toolResultTokens',
      { agentName, transcriptPath, agentSessionId, cwd, sinceMs: runStartMs(sessionManager, sessionId, record) },
      { timeoutMs: null },
    );
  } catch {
    // Best-effort: the popover keeps its live rows without the column.
    return null;
  }
}

/**
 * The stored estimates of the session's earlier runs, summed by tool, after
 * filling the ones still missing. Independent of the live agent's own
 * capability: a track that switched agents keeps its earlier runs' Tokens.
 * Null when no earlier run has an estimate.
 */
async function readEarlierRunToolResultTokens(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository | null,
  sessionId: string,
): Promise<Record<string, number> | null> {
  if (!sessionRepo) return null;
  try {
    const track = sessionTrackOf(sessionManager, sessionRepo, sessionId);
    if (!track) return null;
    await fillEarlierRuns(sessionManager, sessionRepo, sessionId, track, { queued: false });
    // Read after the fill, which may have just written estimates onto these records.
    const earlierRows = sessionRepo.getEarlierRunToolTotals(track.taskId, track.isolatedSwimlaneId, sessionId).toolBreakdown;
    const estimates = earlierRows.flatMap((row) => (row.resultTokens === undefined ? [] : [[row.toolName, row.resultTokens] as const]));
    return estimates.length > 0 ? Object.fromEntries(estimates) : null;
  } catch {
    // Best-effort: the popover keeps the stored estimates it already shows.
    return null;
  }
}

/** A session track: the task plus its isolated swimlane (null = the main session). */
interface SessionTrack {
  taskId: string;
  isolatedSwimlaneId: string | null;
}

/** The track a session belongs to: the live session's, else its record's. */
function sessionTrackOf(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
): SessionTrack | null {
  const session = sessionManager.getSession(sessionId);
  if (session) return { taskId: session.taskId, isolatedSwimlaneId: session.isolatedSwimlaneId ?? null };
  const record = sessionRepo.findByAnyId(sessionId);
  return record ? { taskId: record.task_id, isolatedSwimlaneId: record.isolated_swimlane_id } : null;
}

/** One earlier run whose record lacks Tokens, and the transcript window holding its calls. */
interface EarlierRunWindow {
  recordId: string;
  /** The record's agent session id, which names its transcript file. */
  agentSessionId: string;
  agentName: string;
  sinceMs: number;
  untilMs: number;
  /**
   * Where to look for the transcript, in order: the run's own cwd, then the
   * cwds of later runs of the same conversation (newest first), then the live
   * session's. Resuming in a renamed worktree moves the conversation's history
   * to the new cwd (`migrateResumeCwdIfRenamed`), so an older run's own cwd no
   * longer finds it. The file is named by the agent session id, so a later cwd
   * can only ever lead to this conversation's transcript.
   */
  cwdCandidates: string[];
}

/**
 * The earlier runs a Tokens fill can read, each with its window: from the
 * run's own start to the next run's start on the track, or to the live run's
 * start (`liveRunStartMs`) for the newest. Runs on a track are sequential, so
 * the window holds that run's calls and no other's, even though Claude
 * appends every `--resume` to one transcript. A middle window ends at the next
 * record's `started_at`, which differs from that run's in-memory start (the
 * bound its own reads used) by the spawn's latency or queue wait. No run on the
 * track makes calls in that span, so the two bounds never split a call between
 * records. A run qualifies when
 * {@link fillingAgentName} names an agent for it and its record has the agent
 * session id that locates the transcript.
 */
function earlierRunWindows(
  records: EarlierRunRecord[],
  liveRunStartMs: number | null,
  liveSessionCwd: string | null,
): EarlierRunWindow[] {
  const windows: EarlierRunWindow[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const agentName = fillingAgentName(record);
    if (!agentName || !record.agent_session_id || !record.cwd) continue;
    const sinceMs = Date.parse(record.started_at);
    const untilMs = index + 1 < records.length ? Date.parse(records[index + 1].started_at) : liveRunStartMs;
    if (!Number.isFinite(sinceMs) || untilMs === null || !Number.isFinite(untilMs)) continue;
    windows.push({
      recordId: record.id,
      agentSessionId: record.agent_session_id,
      agentName,
      sinceMs,
      untilMs,
      cwdCandidates: transcriptCwdCandidates(records, index, liveSessionCwd),
    });
  }
  return windows;
}

/**
 * The agent that can fill a record's missing Tokens, or null when the record
 * needs no fill or its agent cannot give one. It needs one when it has stored
 * rows, none of them carries an estimate, and no earlier read already answered
 * for it (`result_tokens_read_at`). Its agent can give one when it implements
 * `transcriptToolResultTokens` AND declares `scopesTranscriptReadsByTime`
 * (resolved from the record's `session_type`, with no agent-name branching):
 * an unscoped read would hold every run of the conversation.
 */
function fillingAgentName(record: EarlierRunRecord): string | null {
  if (record.result_tokens_read_at) return null;
  const storedRows = parseToolBreakdown(record.tool_breakdown);
  if (storedRows.length === 0 || storedRows.some((row) => row.resultTokens !== undefined)) return null;
  const adapter = agentRegistry.getBySessionType(record.session_type);
  return adapter?.transcriptToolResultTokens && adapter.scopesTranscriptReadsByTime ? adapter.name : null;
}

/** The cwds to look for `records[index]`'s transcript under (see `EarlierRunWindow.cwdCandidates`). */
function transcriptCwdCandidates(records: EarlierRunRecord[], index: number, liveSessionCwd: string | null): string[] {
  const record = records[index];
  const candidates = [record.cwd];
  for (let laterIndex = records.length - 1; laterIndex > index; laterIndex--) {
    const laterRecord = records[laterIndex];
    if (laterRecord.agent_session_id === record.agent_session_id && laterRecord.cwd) candidates.push(laterRecord.cwd);
  }
  if (liveSessionCwd) candidates.push(liveSessionCwd);
  return [...new Set(candidates)];
}

/**
 * Fill the per-tool Tokens estimates a session's earlier runs are missing,
 * each from its own transcript window (see {@link earlierRunWindows}), and
 * write them onto the record with `mergeTranscriptResultTokens`. Only
 * estimates are written: a count backfill would need every adapter to scope
 * its read, and Grok and Antigravity cannot.
 *
 * The run-end refine never runs on the synchronous quit path, so every run a
 * quit ended stores Calls, Time and Failed but no Tokens. This is what fills
 * them, started at spawn (`queued`, behind other background reads) and awaited
 * by the popover's read (unqueued, a user is waiting). A caller shares a fill
 * that is reading or has settled; an unqueued caller overtakes a queued fill
 * that has not started (`resultTokenFills`).
 *
 * Resolves true when any record changed; never rejects.
 */
export async function fillEarlierRunResultTokens(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
  options: { queued: boolean },
): Promise<boolean> {
  try {
    const track = sessionTrackOf(sessionManager, sessionRepo, sessionId);
    return track ? await fillEarlierRuns(sessionManager, sessionRepo, sessionId, track, options) : false;
  } catch {
    return false;
  }
}

/** {@link fillEarlierRunResultTokens} for a track already resolved. Never rejects. */
async function fillEarlierRuns(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
  track: SessionTrack,
  options: { queued: boolean },
): Promise<boolean> {
  try {
    const records = sessionRepo.listEarlierRunRecords(track.taskId, track.isolatedSwimlaneId, sessionId);
    // The live session's start and cwd come from memory; its record is read
    // only for a session that has left the manager.
    const liveSession = sessionManager.getSession(sessionId);
    const liveRecord = liveSession ? null : sessionRepo.findByAnyId(sessionId) ?? null;
    const liveSessionCwd = liveSession?.cwd ?? liveRecord?.cwd ?? null;
    const windows = earlierRunWindows(records, runStartMs(sessionManager, sessionId, liveRecord), liveSessionCwd);
    const results = await Promise.all(windows.map((window) => fillEarlierRun(sessionRepo, window, options)));
    return results.some(Boolean);
  } catch {
    return false;
  }
}

/**
 * Start one earlier run's fill, or share the one already in
 * `resultTokenFills` (which says when a caller overtakes it, and when a failed
 * fill is read again, instead).
 */
function fillEarlierRun(sessionRepo: SessionRepository, window: EarlierRunWindow, options: { queued: boolean }): Promise<boolean> {
  const existing = resultTokenFills.get(window.recordId);
  if (existing) {
    const overtakesQueuedFill = existing.waitingInQueue && !options.queued;
    const retryIsDue = existing.failedAtMs !== null && Date.now() - existing.failedAtMs >= FAILED_FILL_RETRY_MS;
    if (!overtakesQueuedFill && !retryIsDue) return existing.settled;
  }
  const fill: ResultTokenFill = { settled: Promise.resolve(false), waitingInQueue: options.queued, failedAtMs: null };
  // In the map before the queue sees the task: an idle queue runs it inside add().
  resultTokenFills.set(window.recordId, fill);
  fill.settled = options.queued
    ? transcriptReadQueue.add(async () => {
      // Overtaken while it waited, by a read that covers this record. Return
      // at once: waiting on that read here would hold the queue's only slot,
      // and every other session's background read behind it.
      if (resultTokenFills.get(window.recordId) !== fill) return false;
      fill.waitingInQueue = false;
      return readEarlierRunWindow(sessionRepo, window, fill);
    })
    : readEarlierRunWindow(sessionRepo, window, fill);
  return fill.settled;
}

/**
 * Read one earlier run's window and write its estimates onto the record.
 * Resolves whether the record changed; never rejects. A failure marks `fill`
 * failed, so a caller reads again once FAILED_FILL_RETRY_MS has passed.
 */
async function readEarlierRunWindow(
  sessionRepo: SessionRepository,
  window: EarlierRunWindow,
  fill: ResultTokenFill,
): Promise<boolean> {
  const failFill = (): false => {
    fill.failedAtMs = Date.now();
    return false;
  };
  let resultTokensByTool: Record<string, number> | null = null;
  for (const cwd of window.cwdCandidates) {
    try {
      resultTokensByTool = await retrievalClient.call(
        'transcript.toolResultTokens',
        {
          agentName: window.agentName,
          transcriptPath: null,
          agentSessionId: window.agentSessionId,
          cwd,
          sinceMs: window.sinceMs,
          untilMs: window.untilMs,
        },
        { timeoutMs: null },
      );
    } catch {
      // Not an answer: the worker was restarting or the read failed.
      return failFill();
    }
    // Null is "no readable transcript here": the next cwd may have it.
    if (resultTokensByTool) break;
  }
  // No cwd led to a transcript. Cheap to establish, so this stays the
  // per-launch settled entry and is not persisted.
  if (!resultTokensByTool) return false;
  try {
    const changed = sessionRepo.mergeTranscriptResultTokens(window.recordId, resultTokensByTool);
    // The read answered but left nothing to keep (no estimates in the window,
    // or none matching a stored row). Persisted, because finding that out
    // again costs a whole transcript parse on every launch.
    if (!changed) sessionRepo.markResultTokensRead(window.recordId);
    return changed;
  } catch {
    // The project database closed under the write.
    return failFill();
  }
}

/**
 * Fire-and-forget backfill of a session record's tool-count columns from the
 * agent's transcript. Mirrors {@link refineTranscriptTokens} exactly (same
 * adapter-resolution, path-sourcing, and best-effort structure); call it right
 * after that function on the same run-ending paths.
 *
 * Backfills the counts ONLY over an empty live count (see
 * `SessionRepository.updateTranscriptToolCounts`'s guard) - it corrects
 * sessions whose ToolStart/ToolEnd hook events never reached the live
 * `UsageAccumulator` (a parked/suspended session reads 0 despite real cost and
 * tokens) without ever regressing a healthy live count. Over a healthy live
 * count it merges only the transcript's per-tool `resultTokens` estimates.
 * Both are scoped to this run's calls (see {@link runStartMs}). An agent that
 * cannot scope its reads (no `scopesTranscriptReadsByTime`) is read only for a
 * conversation's first run.
 *
 * SCOPE NOTE: a record whose `total_cost_usd` stayed NULL (a session that exited
 * before any status.json appeared) is excluded from the `getSummaryForTask` /
 * `listAllSummaries` lifetime aggregates by their `total_cost_usd IS NOT NULL`
 * filter, so a count backfilled onto such a cost-less record is written but not
 * surfaced there. The intended target - a parked/suspended session with real
 * cost - has non-null cost and does surface, so this is a boundary of the
 * aggregates, not a regression.
 *
 * KNOWN LIMITATION: on a same-action move of a still-running session straight
 * to Done, `task_complete` reads `getSummaryForTask` synchronously before this
 * async backfill lands, so that one event leg may under-report. The dominant
 * path (suspend earlier, move to Done later) has the backfill long landed by
 * the time `task_complete` fires, and every later DB read is accurate. This is
 * NOT awaited deliberately: awaiting it here would put file I/O back inside
 * the `withTaskLock` region the split-out design (see the JSDoc above) exists
 * to avoid, for a marginal gain on one analytics event leg.
 *
 * The adapter is resolved generically from the session's recorded agent name -
 * no agent-name branching (agent-adapters-boundary rule); adapters without a
 * `transcriptToolCounts` capability are a no-op.
 */
export function refineTranscriptToolCounts(
  sessionManager: SessionManager,
  sessionRepo: SessionRepository,
  sessionId: string,
  recordId: string,
): void {
  try {
    const located = locateRunTranscript(sessionManager, sessionRepo, sessionId, recordId, 'transcriptToolCounts');
    if (!located) return;
    const { agentName, transcriptPath, agentSessionId, cwd, record } = located;

    // An agent whose reads ignore the time bounds counts its whole transcript,
    // and every run of a conversation writes to the same one. That count is
    // this run's alone only for the conversation's first run; for a resume it
    // would add the earlier runs' calls to this record, and the track's merged
    // totals would show them twice. Such an agent supplies no resultTokens, so
    // nothing else is lost by skipping the read.
    const recordAgentSessionId = record?.agent_session_id ?? null;
    if (
      !agentRegistry.get(agentName)?.scopesTranscriptReadsByTime
      && record
      && recordAgentSessionId
      && sessionRepo.hasEarlierRecordOfConversation(record.id, recordAgentSessionId)
    ) {
      return;
    }

    // Scoped to this run: the transcript can hold every `--resume` of the
    // conversation, and this record (like the live count it backfills or
    // merges onto) covers one. Closed now, as the run ends: the read is
    // queued, and a resume that follows at once (a settings respawn) would
    // otherwise add the next run's first calls to this record, where the
    // track's merged table would count them a second time.
    const sinceMs = runStartMs(sessionManager, sessionId, record);
    const untilMs = Date.now();

    // Read in the retrieval worker, as in refineTranscriptTokens.
    void transcriptReadQueue
      .add(() => retrievalClient.call('transcript.toolCounts', { agentName, transcriptPath, agentSessionId, cwd, sinceMs, untilMs }, { timeoutMs: null }))
      .then((counts) => {
        if (!counts) return;
        sessionRepo.updateTranscriptToolCounts(recordId, counts);
      })
      .catch(() => {
        // Best-effort: leave the live/0 count in place.
      });
  } catch {
    // Best-effort: never break the calling suspend/move/reconcile flow.
  }
}
