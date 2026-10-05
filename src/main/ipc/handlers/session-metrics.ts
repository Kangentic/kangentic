import PQueue from 'p-queue';
import { agentRegistry } from '../../agent/agent-registry';
import { retrievalClient } from '../../retrieval/retrieval-client';
import type { SessionRepository } from '../../db/repositories/session-repository';
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
        // Last-applied effort from the session record (spawn/resume/live-switch
        // ground truth; null = agent default). Attributes the whole session to
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
 * Live per-tool result-token estimates for the current run of a session, keyed
 * by tool name, for the ContextBar tool-call popover to merge onto the live
 * breakdown. The live hook events carry no token data, so this is the only
 * source. Scoped to the run (see {@link runStartMs}), so a resumed session's
 * popover never pairs its own call counts with an earlier run's results.
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
 * Resolves null when the agent lacks the capability, no transcript can be
 * located, or the read failed; a tool with no result yet is absent.
 */
export async function readTranscriptToolResultTokens(
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
 * Both are scoped to this run's calls (see {@link runStartMs}).
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

    // Scoped to this run: the transcript can hold every `--resume` of the
    // conversation, and this record (like the live count it backfills or
    // merges onto) covers one.
    const sinceMs = runStartMs(sessionManager, sessionId, record);

    // Read in the retrieval worker, as in refineTranscriptTokens.
    void transcriptReadQueue
      .add(() => retrievalClient.call('transcript.toolCounts', { agentName, transcriptPath, agentSessionId, cwd, sinceMs }, { timeoutMs: null }))
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
