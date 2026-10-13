import type {
  BackgroundCallJob,
  BackgroundCallTotals,
  BackgroundDayUsage,
  BackgroundJobUsage,
  BackgroundModelCount,
  BackgroundUsage,
} from '../../shared/types';
import { BACKGROUND_CALL_JOBS, isBackgroundCallJob } from '../../shared/background-call-jobs';
import { parseModelId } from '../../shared/model-id';
import type { BackgroundCallGroupRow } from '../db/repositories/background-call-repository';
import { bucketStartFor } from './bucketing';

/**
 * The usage dashboard's Background card and history table, folded from the
 * fixed UTC groups every project's ledger returns (`listBackgroundCallGroups`).
 * Days are LOCAL days, as every other daily figure on the dashboard is: SQL
 * groups on a UTC grid that nests in a local day, and the day boundary is
 * drawn here (the `bucketing.ts` convention).
 *
 * A model with a context-window suffix (`claude-opus-4-8[1m]`) and its plain
 * id are one model, as in the session breakdowns.
 */

function emptyTotals(): BackgroundCallTotals {
  return {
    calls: 0,
    failedCalls: 0,
    reportedCalls: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    durationMs: 0,
  };
}

function addGroup(totals: BackgroundCallTotals, group: BackgroundCallGroupRow): void {
  totals.calls += group.calls;
  totals.failedCalls += group.failedCalls;
  totals.reportedCalls += group.reportedCalls;
  totals.inputTokens += group.inputTokens;
  totals.cacheCreationInputTokens += group.cacheCreationInputTokens;
  totals.cacheReadInputTokens += group.cacheReadInputTokens;
  totals.outputTokens += group.outputTokens;
  if (group.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + group.costUsd;
  totals.durationMs += group.durationMs;
}

/** Adds a group's calls to its agent and base model's count. */
function addModel(models: Map<string, BackgroundModelCount>, group: BackgroundCallGroupRow): void {
  const modelId = group.modelId === null ? null : parseModelId(group.modelId).baseId;
  const key = `${group.agent}\n${modelId ?? ''}`;
  const existing = models.get(key);
  if (existing) existing.calls += group.calls;
  else models.set(key, { agent: group.agent, modelId, calls: group.calls });
}

function sortedModels(models: Map<string, BackgroundModelCount>): BackgroundModelCount[] {
  return [...models.values()].sort((first, second) => second.calls - first.calls);
}

const JOB_ORDER = new Map<BackgroundCallJob, number>(BACKGROUND_CALL_JOBS.map((job, index) => [job, index]));

export function foldBackgroundUsage(groups: readonly BackgroundCallGroupRow[]): BackgroundUsage {
  const totals = emptyTotals();
  const jobTotals = new Map<BackgroundCallJob, { totals: BackgroundCallTotals; models: Map<string, BackgroundModelCount> }>();
  const dayTotals = new Map<string, { dayStartMs: number; job: BackgroundCallJob; totals: BackgroundCallTotals; models: Map<string, BackgroundModelCount> }>();

  for (const group of groups) {
    // A job this build does not know is left out, not read as another job.
    if (!isBackgroundCallJob(group.job)) continue;
    const job = group.job;
    addGroup(totals, group);

    let jobEntry = jobTotals.get(job);
    if (!jobEntry) {
      jobEntry = { totals: emptyTotals(), models: new Map() };
      jobTotals.set(job, jobEntry);
    }
    addGroup(jobEntry.totals, group);
    addModel(jobEntry.models, group);

    const dayStartMs = bucketStartFor(group.bucketStartMs, 'day');
    const dayKey = `${dayStartMs}\n${job}`;
    let dayEntry = dayTotals.get(dayKey);
    if (!dayEntry) {
      dayEntry = { dayStartMs, job, totals: emptyTotals(), models: new Map() };
      dayTotals.set(dayKey, dayEntry);
    }
    addGroup(dayEntry.totals, group);
    addModel(dayEntry.models, group);
  }

  const byJob: BackgroundJobUsage[] = BACKGROUND_CALL_JOBS.map((job) => {
    const entry = jobTotals.get(job);
    return { job, ...(entry?.totals ?? emptyTotals()), models: entry ? sortedModels(entry.models) : [] };
  });
  const byDay: BackgroundDayUsage[] = [...dayTotals.values()]
    .sort((first, second) => (second.dayStartMs - first.dayStartMs)
      || ((JOB_ORDER.get(first.job) ?? 0) - (JOB_ORDER.get(second.job) ?? 0)))
    .map((entry) => ({ dayStartMs: entry.dayStartMs, job: entry.job, ...entry.totals, models: sortedModels(entry.models) }));

  return { totals, byJob, byDay };
}
