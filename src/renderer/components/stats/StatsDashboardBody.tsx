import { startTransition, useCallback, useEffect } from 'react';
import { Info } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { formatTokenCount } from '../../utils/format-tokens';
import { ChartCard } from './ChartCard';
import { KpiTiles } from './KpiTiles';
import { BreakdownCard } from './BreakdownCard';
import { PerProjectTable } from './PerProjectTable';
import { StatsFilterRow } from './StatsFilterRow';
import { StatsMetricToggle } from './StatsMetricToggle';
import { StatsScopePicker } from './StatsScopePicker';
import { useWindowResizing } from '../../hooks/useWindowResizing';
import { KngLineAreaChart } from './charts/KngLineAreaChart';
import { KngBarChart } from './charts/KngBarChart';
import { formatBucketLabel, useStatsData } from './useStatsData';

/** Poll cadence while the page is visible (live watches the trailing window). */
const LIVE_POLL_MS = 15_000;
const PERIOD_POLL_MS = 30_000;
/** Debounce for usage-push-driven refetches (watch new turns land). */
const USAGE_PUSH_DEBOUNCE_MS = 2_000;

function axisCostFormatter(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 1) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * The usage dashboard's toolbar + charts + live-update pipeline (poll floor,
 * usage-push debounce, chart-animation gate), reading purely from stores. Shared
 * between the in-app overlay (StatsPage, which wraps this in its fixed/z-42 chrome)
 * and the pop-out window root (PopOutStatsRoot, which wraps this in
 * PopOutWindowFrame) - the live pipeline is single-sourced here so both hosts get
 * identical behavior with zero duplication.
 */
export function StatsDashboardBody() {
  const period = useUsageDashboardStore((state) => state.period);
  const scopeKind = useUsageDashboardStore((state) => state.scopeKind);
  const viewedProjectId = useUsageDashboardStore((state) => state.viewedProjectId);
  const drill = useUsageDashboardStore((state) => state.drill);
  const customWindow = useUsageDashboardStore((state) => state.customWindow);
  const metric = useUsageDashboardStore((state) => state.metric);
  const setPeriod = useUsageDashboardStore((state) => state.setPeriod);
  const setScopeKind = useUsageDashboardStore((state) => state.setScopeKind);
  const setViewedProject = useUsageDashboardStore((state) => state.setViewedProject);
  const setDrill = useUsageDashboardStore((state) => state.setDrill);
  const setCustomWindow = useUsageDashboardStore((state) => state.setCustomWindow);
  const setMetric = useUsageDashboardStore((state) => state.setMetric);
  const loading = useUsageDashboardStore((state) => state.loading);
  const error = useUsageDashboardStore((state) => state.error);
  const loadDashboardStats = useUsageDashboardStore((state) => state.loadDashboardStats);

  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);
  // Suspend chart data animations while the OS window is actively resizing so
  // layout tracks the drag crisply (a tween re-triggering per resize tick
  // reads as stutter).
  const windowResizing = useWindowResizing();
  const animateCharts = !windowResizing;

  // Poll floor while visible (pause when the window is hidden).
  useEffect(() => {
    const intervalMs = period === 'live' ? LIVE_POLL_MS : PERIOD_POLL_MS;
    const interval = setInterval(() => {
      if (!document.hidden) void loadDashboardStats({ force: true });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [period, loadDashboardStats]);

  // Watch-it-happen: new usage pushes (tokens ticking on running sessions)
  // trigger a debounced refetch so the charts extend while the user watches.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.sessionUsage === previous.sessionUsage) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!document.hidden) void loadDashboardStats({ force: true });
      }, USAGE_PUSH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (debounce) clearTimeout(debounce);
    };
  }, [loadDashboardStats]);

  // The effectively-viewed project: an explicit pick from the scope Select
  // wins; otherwise the app's current project.
  const effectiveProjectId = viewedProjectId ?? currentProject?.id ?? null;
  const effectiveScopeKind = scopeKind === 'project' && effectiveProjectId ? 'project' : 'all';
  const costKnown = useUsageDashboardStore(
    (state) => (state.activeKey ? state.cache[state.activeKey]?.payload.kpis.costKnown ?? false : false),
  );
  const effectiveMetric = costKnown ? metric : 'tokens';
  const data = useStatsData(effectiveMetric);
  const payload = data.payload;

  const coldLoading = loading && !payload;
  // A drill or custom window bounds its own range, so live-specific
  // presentation (empty cost cards, the trailing-2h subtitle) does not apply.
  const isLivePeriod = period === 'live' && !drill && !customWindow;
  const xFormatter = useCallback(
    (ms: number) => formatBucketLabel(ms, payload?.bucketSizeMs ?? 3_600_000),
    [payload?.bucketSizeMs],
  );
  const metricNoun = effectiveMetric === 'cost' ? 'cost' : 'tokens';
  const yFormatter = effectiveMetric === 'cost' ? axisCostFormatter : formatTokenCount;
  const DAY_MS = 86_400_000;
  // The cumulative chart's x-axis follows the COST-bucket width (not the token
  // width the burn chart's `xFormatter` uses); memoized so KngLineAreaChart's
  // React.memo holds across unrelated StatsDashboardBody re-renders.
  const costXFormatter = useCallback(
    (ms: number) => formatBucketLabel(ms, payload?.costBucketSizeMs ?? DAY_MS),
    [payload?.costBucketSizeMs],
  );
  // The stacked bars follow the payload's cost-bucket width: hourly inside a
  // single day ('today' / a day drill), daily for week/month, weekly for all time.
  const costBucketNoun = (payload?.costBucketSizeMs ?? DAY_MS) < DAY_MS
    ? 'hour'
    : (payload?.costBucketSizeMs ?? DAY_MS) < 7 * DAY_MS
      ? 'day'
      : 'week';

  // Day drill-down: clickable whenever the chart's buckets ARE local days
  // (week/month and short-history All Time). Inside a drill or sub-day
  // granularity there is nothing coarser to drill into.
  const canDrillCostBuckets = !drill && payload?.costBucketSizeMs === DAY_MS;
  const canDrillTokenBuckets = !drill && payload?.bucketSizeMs === DAY_MS;
  const handleDrillDay = useCallback(
    (bucketStartMs: number) => setDrill({ dayStartMs: bucketStartMs }),
    [setDrill],
  );
  const drillLabel = drill
    ? new Date(drill.dayStartMs).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : null;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap px-4 pt-3 pb-2 flex-shrink-0">
        {/* Selecting a project here views its stats without switching the
            app; the metric toggle is hidden when no agent reported cost
            (tokens is forced). */}
        <StatsScopePicker
          projects={projects}
          activeProjectId={effectiveScopeKind === 'project' ? effectiveProjectId : null}
          onSelectAll={() => setScopeKind('all')}
          onSelectProject={setViewedProject}
        />
        {costKnown && (
          <StatsMetricToggle
            metric={effectiveMetric}
            // Non-urgent: re-keying every chart to the other metric is a
            // heavy render; the transition keeps the toggle responsive and
            // lets React time-slice the charts instead of janking the click.
            onChange={(nextMetric) => startTransition(() => setMetric(nextMetric))}
          />
        )}
        <div className="h-4 w-px bg-edge/60 flex-shrink-0" aria-hidden />
        <StatsFilterRow
          period={period}
          onPeriodChange={setPeriod}
          customWindow={customWindow}
          onCustomWindowApply={setCustomWindow}
          onCustomWindowClear={() => setCustomWindow(null)}
          drillLabel={drillLabel}
          onDrillClear={() => setDrill(null)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
        {error && (
          <div className="bg-surface-raised border border-edge rounded-lg px-3 py-2 text-xs text-red-400 flex items-center gap-3" data-testid="stats-error">
            <span className="flex-1">Failed to load usage stats: {error}</span>
            <button
              type="button"
              onClick={() => void loadDashboardStats({ force: true })}
              className="text-fg-muted hover:text-fg cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        <KpiTiles
          payload={payload}
          period={period}
          scopeKind={effectiveScopeKind}
          effectiveProjectId={effectiveProjectId}
          includeLive={!drill && !customWindow}
          hasCustomWindow={customWindow !== null}
          tokenSparkline={data.tokenSparkline}
          costSparkline={data.costSparkline}
          burnSparkline={data.burnRate}
          animate={animateCharts}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard
            title={`${effectiveMetric === 'cost' ? 'Cost' : 'Tokens'} per ${costBucketNoun} by model`}
            loading={coldLoading}
            empty={!coldLoading && data.modelStack.rows.length === 0}
            emptyMessage={isLivePeriod ? 'Totals per hour/day appear in Today / Week / Month / All Time' : 'No usage recorded yet'}
            testId="chart-daily"
          >
            <div className="h-full flex flex-col">
              {data.modelStack.series.length > 1 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1 flex-shrink-0" data-testid="chart-daily-legend">
                  {data.modelStack.series.map((entry) => (
                    <span key={entry.key} className="flex items-center gap-1 text-[11px] text-fg-muted">
                      <span
                        aria-hidden
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: `var(${entry.colorVar})` }}
                      />
                      {entry.label}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <KngBarChart
                  series={data.modelStack.series}
                  rows={data.modelStack.rows}
                  yFormatter={yFormatter}
                  ariaLabel={`${metricNoun} per ${costBucketNoun}, stacked by model`}
                  onBucketClick={canDrillCostBuckets ? handleDrillDay : undefined}
                  animate={animateCharts}
                />
              </div>
            </div>
          </ChartCard>

          <ChartCard
            title={effectiveMetric === 'cost' ? 'Cumulative spend' : 'Cumulative tokens'}
            loading={coldLoading}
            empty={!coldLoading && data.cumulative.length === 0}
            emptyMessage={isLivePeriod ? 'Cumulative totals appear in Today / Week / Month / All Time' : 'No usage recorded yet'}
            testId="chart-cumulative"
          >
            <KngLineAreaChart
              points={data.cumulative}
              colorVar="--kng-accent"
              yFormatter={yFormatter}
              xFormatter={costXFormatter}
              seriesLabel={`cumulative ${metricNoun}`}
              ariaLabel={`Cumulative ${metricNoun} over the selected range`}
              onBucketClick={canDrillCostBuckets ? handleDrillDay : undefined}
              animate={animateCharts}
            />
          </ChartCard>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <BreakdownCard
            title="By agent"
            slices={data.byAgentSlices}
            costKnown={costKnown}
            loading={coldLoading}
            testId="breakdown-agent"
            metric={effectiveMetric}
            animate={animateCharts}
          />
          <BreakdownCard
            title="By model"
            slices={data.byModelSlices}
            costKnown={costKnown}
            loading={coldLoading}
            testId="breakdown-model"
            metric={effectiveMetric}
            animate={animateCharts}
          />
          <BreakdownCard
            title="By effort"
            slices={data.byEffortSlices}
            costKnown={costKnown}
            loading={coldLoading}
            testId="breakdown-effort"
            metric={effectiveMetric}
            animate={animateCharts}
          />
        </div>

        <ChartCard
          title={`Burn rate (${metricNoun}/hr)`}
          subtitle={isLivePeriod ? 'Trailing 2 hours, 5-minute buckets' : undefined}
          loading={coldLoading}
          empty={!coldLoading && data.burnRate.every((point) => point.y === 0)}
          emptyMessage="No agent turns recorded in this range"
          bodyClassName="h-52"
          testId="chart-burn-rate"
        >
          <KngLineAreaChart
            points={data.burnRate}
            colorVar="--kng-accent"
            yFormatter={yFormatter}
            xFormatter={xFormatter}
            seriesLabel={`${metricNoun}/hr`}
            ariaLabel={`Burn rate over time in ${metricNoun} per hour`}
            onBucketClick={canDrillTokenBuckets ? handleDrillDay : undefined}
            animate={animateCharts}
          />
        </ChartCard>

        {effectiveScopeKind === 'all' && payload?.perProject && (
          <PerProjectTable projects={payload.perProject} onProjectClick={setViewedProject} />
        )}

        {payload?.skippedProjects && payload.skippedProjects.length > 0 && (
          <div className="text-[11px] text-fg-faint" data-testid="stats-skipped-projects">
            Skipped {payload.skippedProjects.length} project(s) with unreadable databases:{' '}
            {payload.skippedProjects.map((project) => project.projectName || project.projectId).join(', ')}
          </div>
        )}

        {/* First-read caveats collapsed behind an info affordance (visual
            subtraction): the full explanation lives in the hover tooltip. */}
        <p
          className="flex items-center gap-1.5 text-[11px] text-fg-faint w-fit cursor-help"
          title={
            'Costs are API-equivalent as reported by agents; subscription sessions may report $0.\n' +
            'Totals cover finalized sessions; running sessions tick into the tiles live and fold in when they finalize.\n' +
            'Trend lines use exact per-turn tokens, which measure differently from the session snapshots behind the totals.'
          }
          data-testid="stats-about-numbers"
        >
          <Info size={12} aria-hidden />
          About these numbers
        </p>
      </div>
    </>
  );
}
