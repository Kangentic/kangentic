/**
 * The diagnostics budget (src/devtools/main/diagnostics-budget.ts).
 *
 * The owner leaves every Developer diagnostic on while doing real work, so a
 * diagnostic that can be felt has to show up as a failed check, not as a
 * hunch. Each rule here is one way the stall profiler of 2026-11-24 would have
 * been caught: it held main 88 to 258 ms on every save, and it fired on 25 ms
 * delays that were no stall at all.
 */
import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_BUDGET, evaluateDiagnosticsBudget } from '../../src/devtools/main/diagnostics-budget';
import type { DelayWindow, EventLoopLagReport, SyncWorkStats } from '../../src/main/diagnostics/event-loop-lag';
import type { StallProfileSummary } from '../../src/devtools/main/stall-profiler';

const ONE_HOUR_MS = 3_600_000;

function stats(count: number, totalMs: number, maxMs: number): SyncWorkStats {
  const edges = [4, 8, 16, 32, 64, 128, 256];
  // One span reached each edge at or under the worst span: enough for the hold rule.
  return {
    count,
    totalMs,
    maxMs,
    atLeastMs: Object.fromEntries(edges.map((edge) => [String(edge), maxMs >= edge ? 1 : 0])),
  };
}

function reportOf(overrides: {
  syncWorkByLabel?: Record<string, SyncWorkStats>;
  recentDelayWindows?: DelayWindow[];
  monitoringForMs?: number | null;
}): EventLoopLagReport {
  return {
    monitoring: true,
    monitoringForMs: overrides.monitoringForMs === undefined ? ONE_HOUR_MS : overrides.monitoringForMs,
    sampleIntervalMs: 100,
    spikeThresholdMs: 75,
    samples: 36_000,
    maxLagMs: 0,
    spikeCount: 0,
    recentSpikes: [],
    slowSyncThresholdMs: 16,
    recentSlowSyncWork: [],
    recentRelayedSlowSyncWork: [],
    longSyncThresholdMs: 100,
    recentLongSyncWork: [],
    syncWorkByLabel: overrides.syncWorkByLabel ?? {},
    lagAtLeastMs: {},
    delayResolutionMs: 1,
    delayWindowMs: 10_000,
    delayFloorMs: 18.4,
    delayBackstopMs: 25,
    recentDelayWindows: overrides.recentDelayWindows ?? [],
    delayWindowMaxAtLeastMs: {},
  };
}

function summaryAt(detectedAt: string, maxDelayMs: number): StallProfileSummary {
  return {
    detectedAt,
    maxDelayMs,
    slowSpans: [],
    stalledChecks: 1,
    longestBusyRunMs: maxDelayMs,
    topFrames: [],
    heaviestStack: [],
    profileMs: 20_000,
    saveMs: 0.3,
    summaryMs: 2,
    file: null,
  };
}

describe('evaluateDiagnosticsBudget', () => {
  it('passes a run whose diagnostics stayed cheap, and says what each one cost', () => {
    const verdict = evaluateDiagnosticsBudget(reportOf({
      syncWorkByLabel: {
        'diag:stall-profiler:roll': stats(240, 96, 2),
        'diag:stall-profiler:save': stats(8, 6, 1),
        'diag:ipc-record': stats(40_000, 400, 3),
        'db:transaction': stats(6_548, 11_573, 2_116),
      },
    }), []);

    expect(verdict.pass).toBe(true);
    expect(verdict.violations).toEqual([]);
    // Heaviest first, the profiler's labels added into one row, and the app's own work left out.
    expect(verdict.byDiagnostic).toEqual([
      { name: 'ipc-record', count: 40_000, totalMs: 400, maxMs: 3, sharePercent: 0.011, holdsOverBudget: 0 },
      { name: 'stall-profiler', count: 248, totalMs: 102, maxMs: 2, sharePercent: 0.003, holdsOverBudget: 0 },
    ]);
    expect(verdict.totalMs).toBe(502);
    expect(verdict.sharePercent).toBe(0.014);
    expect(verdict.shareJudged).toBe(true);
  });

  it('fails a diagnostic that held main for a frame or more, and names the label', () => {
    const verdict = evaluateDiagnosticsBudget(reportOf({
      syncWorkByLabel: { 'diag:stall-profiler:save': stats(28, 5_600, 258) },
    }), []);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations.filter((violation) => violation.rule === 'hold')).toEqual([
      { rule: 'hold', detail: expect.stringContaining('diag:stall-profiler:save') },
    ]);
    expect(verdict.violations[0].detail).toContain('258 ms');
    expect(verdict.byDiagnostic[0].holdsOverBudget).toBe(1);
  });

  it('excuses the profiler cold start from the hold rule, and reports it apart', () => {
    const verdict = evaluateDiagnosticsBudget(reportOf({
      syncWorkByLabel: { 'diag:stall-profiler:start': stats(1, 212, 212) },
    }), []);

    expect(verdict.pass).toBe(true);
    expect(verdict.coldStart).toEqual({ count: 1, maxMs: 212 });
    expect(verdict.byDiagnostic).toEqual([]);
    expect(verdict.totalMs).toBe(0);
  });

  it('fails when the diagnostics together pass their share of main, however small each span was', () => {
    const overShareMs = (DIAGNOSTICS_BUDGET.maxSharePercent / 100) * ONE_HOUR_MS + 400;
    const verdict = evaluateDiagnosticsBudget(reportOf({
      syncWorkByLabel: { 'diag:log-persist': stats(900_000, overShareMs, 2) },
    }), []);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual([{ rule: 'share', detail: expect.stringContaining("% of main's time") }]);
    expect(verdict.byDiagnostic[0]).toMatchObject({ name: 'log-persist', holdsOverBudget: 0 });
  });

  it('does not judge the share of a run still in its launch burst, and still reports it', () => {
    // 40 ms of spawn labels in a 25 s boot is 0.16%, and nothing of an hour.
    const verdict = evaluateDiagnosticsBudget(reportOf({
      monitoringForMs: 25_000,
      syncWorkByLabel: { 'diag:spawn-caller': stats(185, 40, 1) },
    }), []);

    expect(verdict.sharePercent).toBe(0.16);
    expect(verdict.shareJudged).toBe(false);
    expect(verdict.pass).toBe(true);

    const hold = evaluateDiagnosticsBudget(reportOf({
      monitoringForMs: 25_000,
      syncWorkByLabel: { 'diag:spawn-caller': stats(185, 40, 30) },
    }), []);
    // A hold is a hold at any age.
    expect(hold.pass).toBe(false);
  });

  describe('a delay over the spike line in a window the profiler marked', () => {
    const markedWindow: DelayWindow = {
      at: '2026-11-24T04:27:10.000Z',
      maxMs: 197,
      p99Ms: 16.4,
      meanMs: 6.2,
      note: 'stall-profiler',
    };

    it('passes when a stall of 75 ms or more was detected before it', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [markedWindow] }),
        [summaryAt('2026-11-24T04:27:03.345Z', 218.1)],
      );

      expect(verdict.pass).toBe(true);
      expect(verdict.markedWindows).toEqual({ count: 1, overSpikeLine: 1, unchecked: 0 });
    });

    it('fails when the save behind it fired on less than a stall', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [markedWindow] }),
        [summaryAt('2026-11-24T04:27:03.345Z', 26.8)],
      );

      expect(verdict.pass).toBe(false);
      expect(verdict.violations).toEqual([{ rule: 'marked-window', detail: expect.stringContaining('197 ms') }]);
    });

    it('fails when no stall near it was recorded at all', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [markedWindow] }),
        // Kept, but a minute too early to be the save that marked this window.
        [summaryAt('2026-11-24T04:26:00.000Z', 300)],
      );

      expect(verdict.pass).toBe(false);
      expect(verdict.violations[0].rule).toBe('marked-window');
    });

    it('leaves a marked window at the timer floor alone', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [{ ...markedWindow, maxMs: 16.8 }] }),
        [],
      );

      expect(verdict.pass).toBe(true);
      expect(verdict.markedWindows).toEqual({ count: 1, overSpikeLine: 0, unchecked: 0 });
    });

    it('does not judge a window older than the oldest summary still kept', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [markedWindow] }),
        [summaryAt('2026-11-24T05:00:00.000Z', 120)],
      );

      expect(verdict.pass).toBe(true);
      expect(verdict.markedWindows.unchecked).toBe(1);
    });

    it('ignores a window some other tool noted', () => {
      const verdict = evaluateDiagnosticsBudget(
        reportOf({ recentDelayWindows: [{ ...markedWindow, note: 'scroll-latency' }] }),
        [],
      );

      expect(verdict.pass).toBe(true);
      expect(verdict.markedWindows.count).toBe(0);
    });
  });

  it('reports a zero share before the monitor has run, with no division by zero', () => {
    const verdict = evaluateDiagnosticsBudget(reportOf({
      monitoringForMs: null,
      syncWorkByLabel: { 'diag:lag-journal': stats(3, 1, 1) },
    }), []);

    expect(verdict.sharePercent).toBe(0);
    expect(verdict.pass).toBe(true);
  });
});
