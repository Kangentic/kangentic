/**
 * The completed task view's report, assembled from rows (`sessions.getTaskReport`).
 *
 * Pure: rows in, report out, so its rules are unit tested on plain data.
 * `task-report.ts` reads the rows (the project database on main, and the
 * retrieval worker for what only the index holds) and calls `assembleTaskReport`.
 */

import type {
  AutomationRun,
  BackgroundCallJob,
  SessionSummary,
  Swimlane,
  TaskMoveRecord,
  TaskReport,
  TaskReportBackgroundCall,
  TaskReportBackgroundCallsTotal,
  TaskReportCallOutcome,
  TaskReportColumn,
  TaskReportConversation,
  TaskReportKnowledge,
  TaskReportModelFallback,
  TaskReportModelsTotal,
  TaskReportModelUsage,
  TaskReportRouteColumn,
  TaskReportRun,
  TaskReportRunsTotal,
  TaskReportSummaryState,
  TaskReportTotals,
} from '../../../shared/types';
import { legDeltas } from '../../../shared/leg-deltas';
import { baseModelLabel, parseModelId } from '../../../shared/model-id';
import { isBackgroundCallJob } from '../../../shared/background-call-jobs';
import { parseToolBreakdown, type TaskReportSessionRecord } from '../../db/repositories/session-repository';
import type { TaskBackgroundCallRow } from '../../db/repositories/background-call-repository';
import type { TaskModelUsageRow } from '../../retrieval/conversation/conversation-usage-store';
import type { TaskKnowledge } from '../../retrieval/task-knowledge';

export interface TaskReportInput {
  /** Every session row of the task, in any order. */
  sessions: ReadonlyArray<TaskReportSessionRecord>;
  swimlanes: ReadonlyArray<Swimlane>;
  /** The task's column moves, oldest first. */
  moves: ReadonlyArray<TaskMoveRecord>;
  summary: SessionSummary | null;
  automationRuns: ReadonlyArray<AutomationRun>;
  /** Each automation's Condition text, by automation id. */
  conditionsByAutomationId: ReadonlyMap<string, string>;
  backgroundCalls: ReadonlyArray<TaskBackgroundCallRow>;
  /** Null when the turn ledger could not be read. */
  ledger: ReadonlyArray<TaskModelUsageRow> | null;
  knowledge: TaskKnowledge | null;
  summaryState: TaskReportSummaryState;
  /** Epoch ms, standing in for the end of a stay or a run that has not ended. */
  nowMs: number;
}

interface Interval {
  column: TaskReportColumn;
  startMs: number;
  endMs: number;
}

function toColumn(swimlane: Swimlane): TaskReportColumn {
  return { swimlaneId: swimlane.id, name: swimlane.name, color: swimlane.color, icon: swimlane.icon, role: swimlane.role };
}

function isWorkingColumn(column: TaskReportColumn): boolean {
  return column.role !== 'todo' && column.role !== 'done';
}

function endOf(record: TaskReportSessionRecord): string | null {
  return record.suspended_at ?? record.exited_at;
}

/** Each stay in a column, from one move to the next. The last stay runs to now. */
function stays(moves: ReadonlyArray<TaskMoveRecord>, columnsById: ReadonlyMap<string, TaskReportColumn>, nowMs: number): Interval[] {
  const intervals: Interval[] = [];
  moves.forEach((move, index) => {
    const column = columnsById.get(move.to_swimlane_id);
    if (!column) return;
    const startMs = Date.parse(move.at);
    const next = moves[index + 1];
    const endMs = next ? Date.parse(next.at) : nowMs;
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return;
    intervals.push({ column, startMs, endMs: Math.max(startMs, endMs) });
  });
  return intervals;
}

/** The task's route: each working column it visited, in board order, with its visits. */
function routeOf(intervals: ReadonlyArray<Interval>, swimlanes: ReadonlyArray<Swimlane>): TaskReportRouteColumn[] {
  const byColumn = new Map<string, TaskReportRouteColumn>();
  for (const interval of intervals) {
    if (!isWorkingColumn(interval.column)) continue;
    const entry = byColumn.get(interval.column.swimlaneId) ?? { ...interval.column, totalMs: 0, visits: [] };
    const durationMs = interval.endMs - interval.startMs;
    entry.totalMs += durationMs;
    entry.visits.push({ startedAt: new Date(interval.startMs).toISOString(), durationMs });
    byColumn.set(interval.column.swimlaneId, entry);
  }
  const positionOf = new Map(swimlanes.map((swimlane) => [swimlane.id, swimlane.position]));
  return [...byColumn.values()].sort((first, second) => (positionOf.get(first.swimlaneId) ?? 0) - (positionOf.get(second.swimlaneId) ?? 0));
}

/** What a route is built from, and nothing the report's other sections read. */
export type TaskRouteInput = Pick<TaskReportInput, 'swimlanes' | 'moves' | 'nowMs'>;

/**
 * The task's route on its own (`sessions.getTaskRoute`), which the conversation
 * window reads for its column tabs without paying for the whole report. The
 * report's Route card is built by this same function, so the card's pills and
 * the window's tabs can never disagree.
 */
export function assembleTaskRoute(input: TaskRouteInput): TaskReportRouteColumn[] {
  const columnsById = new Map(input.swimlanes.map((swimlane) => [swimlane.id, toColumn(swimlane)]));
  return routeOf(stays(input.moves, columnsById, input.nowMs), input.swimlanes);
}

/** The base model's label for a session row, or null when it reported none. */
function modelLabelOf(record: TaskReportSessionRecord): string | null {
  if (!record.model_id && !record.model_display_name) return null;
  return baseModelLabel(record.model_display_name, parseModelId(record.model_id ?? '').baseId);
}

/**
 * How long a run must overlap a stay to have worked in that column. A move
 * suspends the run it ends a moment AFTER the move is logged (into an isolated
 * column, the main session stops once the move lands), so a bare overlap names
 * the next column too: on one dogfooding task, "Planning > Executing > Code
 * Review" for a run that ended as the task entered Code Review.
 */
const RUN_COLUMN_MIN_OVERLAP_MS = 10_000;

/**
 * The route columns a run worked in, in the order it reached them: each stay
 * it overlapped for `RUN_COLUMN_MIN_OVERLAP_MS` or more. A run shorter than
 * that is named for the stay it overlapped most.
 */
function columnsOfRun(record: TaskReportSessionRecord, intervals: ReadonlyArray<Interval>, columnsById: ReadonlyMap<string, TaskReportColumn>, nowMs: number): TaskReportColumn[] {
  if (record.isolated_swimlane_id) {
    const isolated = columnsById.get(record.isolated_swimlane_id);
    return isolated ? [isolated] : [];
  }
  const startMs = Date.parse(record.started_at);
  const end = endOf(record);
  const endMs = end ? Date.parse(end) : nowMs;
  const overlaps = intervals
    .filter((interval) => isWorkingColumn(interval.column))
    .map((interval) => ({ column: interval.column, overlapMs: Math.min(endMs, interval.endMs) - Math.max(startMs, interval.startMs) }))
    .filter((entry) => entry.overlapMs > 0);
  let worked = overlaps.filter((entry) => entry.overlapMs >= RUN_COLUMN_MIN_OVERLAP_MS);
  if (worked.length === 0 && overlaps.length > 0) {
    worked = [overlaps.reduce((longest, entry) => (entry.overlapMs > longest.overlapMs ? entry : longest))];
  }
  const columns: TaskReportColumn[] = [];
  for (const entry of worked) {
    if (columns[columns.length - 1]?.swimlaneId === entry.column.swimlaneId) continue;
    columns.push(entry.column);
  }
  return columns;
}

function conversationsOf(input: TaskReportInput, intervals: ReadonlyArray<Interval>, columnsById: ReadonlyMap<string, TaskReportColumn>): TaskReportConversation[] {
  const shares = legDeltas(input.sessions.map((record) => ({
    recordId: record.id,
    lineageId: record.agent_session_id,
    startedAt: record.started_at,
    cumulativeCostUsd: record.total_cost_usd,
    cumulativeDurationMs: record.total_duration_ms,
  })));
  // A run that never reported usage (a spawn that failed, a session with no
  // agent behind it) has nothing to show.
  const runs = input.sessions
    .filter((record) => record.total_cost_usd !== null)
    .sort((first, second) => first.started_at.localeCompare(second.started_at));
  const byConversation = new Map<string, TaskReportConversation>();
  for (const record of runs) {
    const conversationId = record.agent_session_id ?? record.id;
    const conversation = byConversation.get(conversationId) ?? {
      conversationId,
      isolatedColumn: record.isolated_swimlane_id ? columnsById.get(record.isolated_swimlane_id) ?? null : null,
      runs: [],
    };
    const share = shares.get(record.id);
    const run: TaskReportRun = {
      recordId: record.id,
      agent: record.session_type,
      startedAt: record.started_at,
      exitCode: record.exit_code,
      model: modelLabelOf(record),
      effort: record.applied_effort,
      permissionMode: record.permission_mode,
      costUsd: share?.costUsd ?? null,
      runtimeMs: share?.durationMs ?? null,
      toolCallCount: record.tool_call_count ?? 0,
      compactionCount: record.compaction_count ?? 0,
      toolBreakdown: parseToolBreakdown(record.tool_breakdown),
      columns: columnsOfRun(record, intervals, columnsById, input.nowMs),
    };
    conversation.runs.push(run);
    byConversation.set(conversationId, conversation);
  }
  return [...byConversation.values()];
}

/** The label a ledger model id reads as: the task's own sessions' display name for it, when one ran it. */
function ledgerLabels(sessions: ReadonlyArray<TaskReportSessionRecord>): (modelId: string | null) => string {
  const displayByBase = new Map<string, string>();
  for (const record of sessions) {
    if (record.model_id && record.model_display_name) displayByBase.set(parseModelId(record.model_id).baseId, record.model_display_name);
  }
  return (modelId) => {
    if (!modelId) return 'Unknown model';
    const baseId = parseModelId(modelId).baseId;
    return baseModelLabel(displayByBase.get(baseId) ?? null, baseId);
  };
}

/** The ledger's rows merged by label, so `opus-4-8` and `opus-4-8[1m]` are one row. */
function modelsOf(ledger: ReadonlyArray<TaskModelUsageRow>, sessions: ReadonlyArray<TaskReportSessionRecord>): TaskReportModelUsage[] {
  const labelOf = ledgerLabels(sessions);
  const merged = new Map<string, TaskReportModelUsage>();
  for (const row of ledger) {
    const model = labelOf(row.modelId);
    const subagent = row.subagentType === null ? null : (row.subagentType || 'subagent');
    const key = `${model}\u0000${subagent ?? ''}`;
    const entry = merged.get(key) ?? { model, subagent, turns: 0, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    entry.turns += row.turns;
    entry.freshInputTokens += row.freshInputTokens;
    entry.cacheWriteTokens += row.cacheWriteTokens;
    entry.cacheReadTokens += row.cacheReadTokens;
    entry.outputTokens += row.outputTokens;
    merged.set(key, entry);
  }
  return [...merged.values()];
}

/**
 * Tokens by model from the session rows: each conversation's latest reading, as
 * the summary takes it, so over the records that reported usage (a cost) only.
 */
function modelFallbackOf(sessions: ReadonlyArray<TaskReportSessionRecord>): TaskReportModelFallback[] {
  const latestByConversation = new Map<string, TaskReportSessionRecord>();
  for (const record of sessions) {
    if (record.total_cost_usd === null) continue;
    if (record.total_input_tokens === null && record.total_output_tokens === null) continue;
    const conversationId = record.agent_session_id ?? record.id;
    const latest = latestByConversation.get(conversationId);
    // Equal start times break on the id, as the summary's `ORDER BY started_at DESC, id DESC` does.
    const isNewer = !latest || record.started_at > latest.started_at
      || (record.started_at === latest.started_at && record.id > latest.id);
    if (isNewer) latestByConversation.set(conversationId, record);
  }
  const byModel = new Map<string, TaskReportModelFallback>();
  for (const record of latestByConversation.values()) {
    const model = modelLabelOf(record) ?? 'Unknown model';
    const entry = byModel.get(model) ?? { model, inputWithCacheTokens: 0, outputTokens: 0 };
    entry.inputWithCacheTokens += record.total_input_tokens ?? 0;
    entry.outputTokens += record.total_output_tokens ?? 0;
    byModel.set(model, entry);
  }
  return [...byModel.values()];
}

/**
 * What happened to an automation a Condition check was asked about, or null
 * for a run no check was asked about (no Condition, a spent Frequency, a column
 * that cannot run it): it is not a check at all.
 *
 * A run with no answer but a check on record is a check that failed (the
 * runner keeps the call and records the row as skipped), so it reads as an
 * error, not a skip. Otherwise the run's own status decides: it succeeded, it
 * was skipped (the Condition was not met, or a later gate stopped it), or it
 * failed. An interrupted run did not complete, and a run still running has
 * started, so each reads as the nearer of error and ran.
 */
function outcomeOf(run: AutomationRun): TaskReportCallOutcome | null {
  if (run.condition_met === null && !run.check) return null;
  if (run.condition_met === null) return 'error';
  switch (run.status) {
    case 'succeeded':
    case 'running':
      return 'ran';
    case 'skipped':
      return 'skipped';
    case 'failed':
    case 'interrupted':
      return 'error';
  }
}

/**
 * Why the automation ended as it did. A met or not-met answer carries the
 * agent's reason. A run that did not follow its answer (a later gate skipped
 * it, or it failed) carries the recorded detail, and an error always does: a
 * met answer's reason would say why it should have run, not why it did not.
 */
function reasonOf(run: AutomationRun, outcome: TaskReportCallOutcome): string | null {
  const answeredReason = run.condition_reason ?? null;
  const detail = run.detail ?? null;
  if (outcome === 'error') return detail ?? answeredReason;
  if (outcome === 'skipped' && run.condition_met === true) return detail ?? answeredReason;
  return answeredReason ?? detail;
}

/**
 * The task's background calls, oldest first: one row per automation a
 * Condition check was asked about, whatever became of it (it ran, was skipped,
 * or ended in error), and each call of another job made for the task (a
 * title). One check answers every automation of its group, so rows can share a
 * call; `backgroundCallsTotalOf` counts each call once. A check no run names (a
 * failed check repeated in the same visit records no run) has no row. The job
 * comes from the call's own record, never from the automation's type.
 */
function backgroundCallsOf(input: TaskReportInput, columnsById: ReadonlyMap<string, TaskReportColumn>): TaskReportBackgroundCall[] {
  const callsById = new Map(input.backgroundCalls.map((call) => [call.id, call]));
  const automationCallIds = new Set<string>();
  for (const run of input.automationRuns) {
    if (run.check?.callId) automationCallIds.add(run.check.callId);
  }

  const rows: TaskReportBackgroundCall[] = [];
  for (const run of input.automationRuns) {
    const outcome = outcomeOf(run);
    if (outcome === null) continue;
    const check = run.check ?? null;
    const call = check ? callsById.get(check.callId) : undefined;
    const job: BackgroundCallJob = call && isBackgroundCallJob(call.job) ? call.job : 'condition_check';
    const tokenParts = check ? [check.inputTokens, check.outputTokens, check.cacheCreationInputTokens, check.cacheReadInputTokens] : [];
    const tokens = tokenParts.every((part) => part === null) ? null : tokenParts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
    rows.push({
      callId: check?.callId ?? null,
      job,
      column: columnsById.get(run.swimlane_id) ?? null,
      automationName: run.automation_name,
      automationType: run.type,
      condition: input.conditionsByAutomationId.get(run.automation_id) ?? null,
      outcome,
      reason: reasonOf(run, outcome),
      startedAt: run.started_at,
      model: check?.model ? baseModelLabel(null, parseModelId(check.model).baseId) : null,
      effort: check?.effort ?? null,
      durationMs: check?.durationMs ?? null,
      costUsd: check?.costUsd ?? null,
      tokens,
    });
  }

  for (const call of input.backgroundCalls) {
    // A call an automation run names is shown through that run, or not at all.
    if (automationCallIds.has(call.id) || !isBackgroundCallJob(call.job)) continue;
    if (call.job === 'condition_check' || call.job === 'workflow_step') continue;
    rows.push({
      callId: call.id,
      job: call.job,
      column: call.swimlaneId ? columnsById.get(call.swimlaneId) ?? null : null,
      automationName: null,
      automationType: null,
      condition: null,
      outcome: null,
      reason: null,
      startedAt: call.startedAt,
      model: call.modelId ? baseModelLabel(null, parseModelId(call.modelId).baseId) : null,
      effort: call.effort,
      durationMs: call.durationMs,
      costUsd: call.costUsd,
      tokens: call.tokens,
    });
  }

  return rows.sort((first, second) => first.startedAt.localeCompare(second.startedAt));
}

/** Adds a reported value to a total that stays null until some value is reported. */
function addReported(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

/**
 * The Runs table's Total, over every run of every conversation. A figure no
 * run reported totals to null, never a measured zero, and a run that did not
 * report one leaves the others' sum as it is.
 */
function runsTotalOf(conversations: ReadonlyArray<TaskReportConversation>): TaskReportRunsTotal {
  const total: TaskReportRunsTotal = { runCount: 0, runtimeMs: null, costUsd: null, toolCallCount: 0, compactionCount: 0 };
  for (const run of conversations.flatMap((conversation) => conversation.runs)) {
    total.runCount += 1;
    total.runtimeMs = addReported(total.runtimeMs, run.runtimeMs);
    total.costUsd = addReported(total.costUsd, run.costUsd);
    total.toolCallCount += run.toolCallCount;
    total.compactionCount += run.compactionCount;
  }
  return total;
}

/** The Models and tokens card's Total: the merged ledger rows added up. */
function modelsTotalOf(models: ReadonlyArray<TaskReportModelUsage>): TaskReportModelsTotal {
  const total: TaskReportModelsTotal = { turns: 0, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const row of models) {
    total.turns += row.turns;
    total.freshInputTokens += row.freshInputTokens;
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.outputTokens += row.outputTokens;
  }
  return total;
}

/**
 * The Background calls card's Total. One check answers every automation of
 * its group, so a call counts once, however many rows it answered. A row whose
 * call is not on record (from before the call ledger) counts on its own and
 * carries no figures, so a field no row reported totals to null.
 */
function backgroundCallsTotalOf(calls: ReadonlyArray<TaskReportBackgroundCall>): TaskReportBackgroundCallsTotal {
  const total: TaskReportBackgroundCallsTotal = { durationMs: null, costUsd: null, tokens: null };
  const counted = new Set<string>();
  for (const call of calls) {
    if (call.callId !== null) {
      if (counted.has(call.callId)) continue;
      counted.add(call.callId);
    }
    total.durationMs = addReported(total.durationMs, call.durationMs);
    total.costUsd = addReported(total.costUsd, call.costUsd);
    total.tokens = addReported(total.tokens, call.tokens);
  }
  return total;
}

function knowledgeOf(knowledge: TaskKnowledge | null): TaskReportKnowledge | null {
  if (!knowledge) return null;
  return {
    commits: knowledge.commits,
    commitCount: knowledge.commitCount,
    changedFiles: knowledge.changedFiles,
    changedFileCount: knowledge.changedFileCount,
  };
}

/**
 * The task's span: the first move into a working column to the last move into
 * Done, else its sessions'. The start is the earlier of the first such move and
 * the first session, since the move log began after many tasks had already run
 * (on one dogfooding task the first logged move came 16 days after its first
 * session), and no session starts before the task left To Do.
 */
function spanOf(input: TaskReportInput, columnsById: ReadonlyMap<string, TaskReportColumn>): { startedAt: string | null; endedAt: string | null } {
  const columnOf = (move: TaskMoveRecord) => columnsById.get(move.to_swimlane_id);
  const firstWorking = input.moves.find((move) => {
    const column = columnOf(move);
    return column !== undefined && isWorkingColumn(column);
  });
  const lastDone = [...input.moves].reverse().find((move) => columnOf(move)?.role === 'done');

  const starts = input.sessions.map((record) => record.started_at).sort();
  const ends = input.sessions.map(endOf).filter((value): value is string => value !== null).sort();
  const candidates = [firstWorking?.at, starts[0]].filter((value): value is string => value !== undefined);
  const startedAt = candidates.length > 0 ? candidates.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest)) : null;
  return {
    startedAt,
    endedAt: lastDone?.at ?? ends[ends.length - 1] ?? null,
  };
}

export function assembleTaskReport(input: TaskReportInput): TaskReport {
  const columnsById = new Map(input.swimlanes.map((swimlane) => [swimlane.id, toColumn(swimlane)]));
  const intervals = stays(input.moves, columnsById, input.nowMs);
  const span = spanOf(input, columnsById);
  const conversations = conversationsOf(input, intervals, columnsById);
  const models = input.ledger === null ? null : modelsOf(input.ledger, input.sessions);
  const backgroundCalls = backgroundCallsOf(input, columnsById);
  const totals: TaskReportTotals = {
    runs: runsTotalOf(conversations),
    models: models === null ? null : modelsTotalOf(models),
    backgroundCalls: backgroundCallsTotalOf(backgroundCalls),
  };
  return {
    summary: input.summary,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    route: assembleTaskRoute(input),
    conversations,
    models,
    modelFallback: modelFallbackOf(input.sessions),
    backgroundCalls,
    totals,
    knowledge: knowledgeOf(input.knowledge),
    summaryState: input.summaryState,
  };
}
