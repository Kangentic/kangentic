import { agentRegistry } from '../../agent/agent-registry';
import type { SessionRepository } from '../../db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import type { SessionManager } from '../../pty/session-manager';

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
      usageHistoryRepo.recordSessionUsage({
        sessionRecordId: recordId,
        sessionStartedAt,
        sessionType,
        totalCostUsd: usage.cost.totalCostUsd,
        totalInputTokens: usage.contextWindow.totalInputTokens ?? 0,
        totalOutputTokens: usage.contextWindow.totalOutputTokens ?? 0,
        totalDurationMs: usage.cost.totalDurationMs ?? null,
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
        effort: sessionRepo.findByAnyId(recordId)?.applied_effort ?? null,
      });
    }
  } catch {
    // Metrics capture is best-effort -- never break the calling flow
  }
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
    const agentName = sessionManager.getSessionAgentName(sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    if (!adapter?.transcriptUsage) return;

    const transcriptPath = sessionManager.getUsageCache()[sessionId]?.transcriptPath ?? null;
    const record = sessionRepo.findByAnyId(recordId);
    const agentSessionId = record?.agent_session_id ?? null;
    const cwd = record?.cwd ?? null;
    if (!transcriptPath && !(agentSessionId && cwd)) return;

    void adapter
      .transcriptUsage({ transcriptPath, agentSessionId, cwd })
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
 * Fire-and-forget backfill of a session record's tool-count columns from the
 * agent's transcript. Mirrors {@link refineTranscriptTokens} exactly (same
 * adapter-resolution, path-sourcing, and best-effort structure); call it right
 * after that function on the same run-ending paths.
 *
 * Backfills ONLY an empty live count (see
 * `SessionRepository.updateTranscriptToolCounts`'s guard) - it corrects
 * sessions whose ToolStart/ToolEnd hook events never reached the live
 * `UsageAccumulator` (a parked/suspended session reads 0 despite real cost and
 * tokens) without ever regressing a healthy live count.
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
    const agentName = sessionManager.getSessionAgentName(sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    if (!adapter?.transcriptToolCounts) return;

    const transcriptPath = sessionManager.getUsageCache()[sessionId]?.transcriptPath ?? null;
    const record = sessionRepo.findByAnyId(recordId);
    const agentSessionId = record?.agent_session_id ?? null;
    const cwd = record?.cwd ?? null;
    if (!transcriptPath && !(agentSessionId && cwd)) return;

    void adapter
      .transcriptToolCounts({ transcriptPath, agentSessionId, cwd })
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
