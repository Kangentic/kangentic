import {
  SPIKE_THRESHOLD_MS,
  type EventLoopLagReport,
} from '../../main/diagnostics/event-loop-lag';
import { SAVE_NOTE, type StallProfileSummary } from './stall-profiler';

/**
 * What the Developer diagnostics cost main's thread, checked against a budget.
 *
 * The owner runs the dev build for real work with every diagnostic on. A
 * diagnostic that can be felt is a bug, and on 2026-11-24 the stall profiler
 * was one: each save held main 88 to 258 ms. So every diagnostic times its own
 * main-thread work under a `diag:<name>` label (`timeSyncWork`), the lag
 * monitor already counts every span per label for the whole run, and this
 * turns those counts into a verdict. The lag report carries it, so every read
 * of the report is a budget check, on the real workload.
 *
 * The sampler thread V8 runs for the profiler is outside this: it holds no
 * JavaScript and no span sees it. `scripts/measure-diagnostics-cost.mjs
 * --watch` compares main's CPU share for that.
 */

export const DIAGNOSTIC_LABEL_PREFIX = 'diag:';
/** The profiler's cold start: one heap walk when it is switched on, exempt from the hold rule. */
const COLD_START_LABEL = 'diag:stall-profiler:start';

export const DIAGNOSTICS_BUDGET = {
  /** No diagnostic work may hold main this long. One frame at 60 Hz, the lag monitor's slow-span line. */
  maxHoldMs: 16,
  /** All diagnostic work together, as a percentage of the time the monitor has run. */
  maxSharePercent: 0.1,
  /**
   * The share is judged only after the monitor has run this long. A launch
   * labels about 200 process starts in its first seconds (13 ms measured),
   * which is 0.05% of a 25 s run and nothing of an hour.
   */
  shareAfterMs: 10 * 60_000,
  /** A delay this long in a window the profiler marked must have a stall behind it. */
  spikeMs: SPIKE_THRESHOLD_MS,
} as const;

/** How long before a marked window's end its save can have been detected: a 10 s window, plus slack. */
const MARKED_WINDOW_REACH_MS = 15_000;

export interface DiagnosticCost {
  /** The diagnostic, from its label: `stall-profiler`, `ipc-record`, `log-persist`... */
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Its share of the time the monitor has run, in percent. */
  sharePercent: number;
  /** How many of its spans reached `maxHoldMs`. */
  holdsOverBudget: number;
}

export interface DiagnosticsViolation {
  rule: 'hold' | 'share' | 'marked-window';
  detail: string;
}

export interface DiagnosticsVerdict {
  budget: typeof DIAGNOSTICS_BUDGET;
  pass: boolean;
  violations: DiagnosticsViolation[];
  byDiagnostic: DiagnosticCost[];
  /** Every diagnostic together, the cold start left out. */
  totalMs: number;
  sharePercent: number;
  /** False while the run is too young for its share to mean anything (`shareAfterMs`). */
  shareJudged: boolean;
  /** The profiler's cold starts this run: reported, never a violation. */
  coldStart: { count: number; maxMs: number };
  /** Delay windows the profiler marked after a save. */
  markedWindows: {
    count: number;
    /** How many of them held a delay of `spikeMs` or more. */
    overSpikeLine: number;
    /** Older than the oldest stall summary still kept, so not checked. */
    unchecked: number;
  };
}

function diagnosticNameOf(label: string): string {
  return label.slice(DIAGNOSTIC_LABEL_PREFIX.length).split(':')[0];
}

function roundThousandth(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Judge one main-process lag report. `stallSummaries` are the profiler's, in
 * the order it kept them (oldest first).
 */
export function evaluateDiagnosticsBudget(
  report: EventLoopLagReport,
  stallSummaries: StallProfileSummary[],
): DiagnosticsVerdict {
  const violations: DiagnosticsViolation[] = [];
  const uptimeMs = report.monitoringForMs ?? 0;
  const shareOf = (totalMs: number): number => (uptimeMs > 0 ? roundThousandth((totalMs / uptimeMs) * 100) : 0);
  const holdEdge = String(DIAGNOSTICS_BUDGET.maxHoldMs);

  const costs = new Map<string, DiagnosticCost>();
  let coldStart = { count: 0, maxMs: 0 };
  for (const [label, stats] of Object.entries(report.syncWorkByLabel)) {
    if (!label.startsWith(DIAGNOSTIC_LABEL_PREFIX)) continue;
    if (label === COLD_START_LABEL) {
      coldStart = { count: stats.count, maxMs: stats.maxMs };
      continue;
    }
    const name = diagnosticNameOf(label);
    const cost = costs.get(name) ?? { name, count: 0, totalMs: 0, maxMs: 0, sharePercent: 0, holdsOverBudget: 0 };
    const holdsOverBudget = stats.atLeastMs[holdEdge] ?? 0;
    cost.count += stats.count;
    cost.totalMs += stats.totalMs;
    cost.maxMs = Math.max(cost.maxMs, stats.maxMs);
    cost.holdsOverBudget += holdsOverBudget;
    costs.set(name, cost);
    if (holdsOverBudget > 0) {
      violations.push({
        rule: 'hold',
        detail: `${label} held main ${DIAGNOSTICS_BUDGET.maxHoldMs} ms or more ${holdsOverBudget} time(s), worst ${stats.maxMs} ms`,
      });
    }
  }
  const byDiagnostic = [...costs.values()]
    .map((cost) => ({ ...cost, sharePercent: shareOf(cost.totalMs) }))
    .sort((left, right) => right.totalMs - left.totalMs);
  const totalMs = byDiagnostic.reduce((sum, cost) => sum + cost.totalMs, 0);
  const sharePercent = shareOf(totalMs);
  const shareJudged = uptimeMs >= DIAGNOSTICS_BUDGET.shareAfterMs;
  if (shareJudged && sharePercent > DIAGNOSTICS_BUDGET.maxSharePercent) {
    violations.push({
      rule: 'share',
      detail: `diagnostics used ${sharePercent}% of main's time (${totalMs} ms), over the ${DIAGNOSTICS_BUDGET.maxSharePercent}% budget`,
    });
  }

  // A window the profiler marked follows a save. A delay over the spike line
  // in it is fine when a real stall is what the save reacted to, and a defect
  // when the save fired on less, or when nothing recorded a stall at all.
  const marked = report.recentDelayWindows.filter((delayWindow) => delayWindow.note === SAVE_NOTE);
  const oldestSummaryMs = stallSummaries.length > 0 ? Date.parse(stallSummaries[0].detectedAt) : null;
  let overSpikeLine = 0;
  let unchecked = 0;
  for (const delayWindow of marked) {
    if (delayWindow.maxMs < DIAGNOSTICS_BUDGET.spikeMs) continue;
    overSpikeLine += 1;
    const windowEndMs = Date.parse(delayWindow.at);
    if (oldestSummaryMs === null || windowEndMs < oldestSummaryMs) {
      unchecked += 1;
      continue;
    }
    const behindIt = stallSummaries.filter((summary) => {
      const detectedAtMs = Date.parse(summary.detectedAt);
      return detectedAtMs <= windowEndMs && windowEndMs - detectedAtMs <= MARKED_WINDOW_REACH_MS;
    });
    if (!behindIt.some((summary) => summary.maxDelayMs >= DIAGNOSTICS_BUDGET.spikeMs)) {
      violations.push({
        rule: 'marked-window',
        detail: `the ${SAVE_NOTE} window ending ${delayWindow.at} held a ${delayWindow.maxMs} ms delay with no stall of ${DIAGNOSTICS_BUDGET.spikeMs} ms or more detected before it`,
      });
    }
  }

  return {
    budget: DIAGNOSTICS_BUDGET,
    pass: violations.length === 0,
    violations,
    byDiagnostic,
    totalMs,
    sharePercent,
    shareJudged,
    coldStart,
    markedWindows: { count: marked.length, overSpikeLine, unchecked },
  };
}
