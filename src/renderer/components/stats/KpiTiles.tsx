import { useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  Braces,
  CircleDollarSign,
  FileDiff,
  Files,
  Flame,
  Layers,
  SquareTerminal,
  Timer,
  TrendingDown,
  TrendingUp,
  Wrench,
  Zap,
} from 'lucide-react';
import type { UsageDashboardStats, UsageStatsScopeKind, UsageTimePeriod } from '../../../shared/types';
import { useSessionStore } from '../../stores/session-store';
import { useLiveUsageAggregate } from '../../hooks/useLiveUsageAggregate';
import { useValuePulse } from '../../hooks/useValuePulse';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { KngSparkline } from './charts/KngSparkline';
import { deltaPercent, type TimePoint } from './useStatsData';

/** The "vs ..." label per range for the hero deltas. */
const DELTA_BASELINE_LABELS: Record<UsageTimePeriod, string> = {
  live: 'vs prior 2h',
  today: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
  all: '',
};

/** The hero's ONE quiet context line: the secondary stat and the directional
 *  delta render as two muted pills, so the tile stays three layers - label,
 *  big value, context - and the separation is structural (containers), not
 *  punctuation. Spend/usage going UP reads warm, going DOWN calm-green. */
function HeroContextLine({ sub, delta, baseline }: { sub?: string; delta: number | null; baseline: string }) {
  const showDelta = delta !== null && baseline !== '';
  const up = (delta ?? 0) >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className="flex items-center gap-1.5 h-5 mt-1 min-w-0 text-[11px] tabular-nums">
      {sub && (
        <span className="truncate rounded-full bg-surface-hover/40 px-2 py-0.5 text-fg-muted">{sub}</span>
      )}
      {showDelta && (
        <span className={`inline-flex items-center gap-1 flex-shrink-0 rounded-full px-2 py-0.5 ${up ? 'bg-attention/10 text-attention' : 'bg-active/10 text-active'}`}>
          <Icon size={12} aria-hidden />
          {`${up ? '+' : ''}${Math.round((delta as number) * 100)}%`}
          <span className="text-fg-faint">{baseline}</span>
        </span>
      )}
    </div>
  );
}

interface HeroTileProps {
  label: string;
  icon: ReactNode;
  value: string;
  /** Muted unit/suffix rendered after the value (e.g. '/hr'). */
  valueSuffix?: string;
  sub?: string;
  title?: string;
  delta: number | null;
  deltaBaseline: string;
  spark: TimePoint[];
  sparkColorVar: string;
  resetKey: string;
  testId: string;
  animate: boolean;
}

/** Large headline tile: label+icon, hero value, delta line, and a sparkline
 *  filling the remaining space (whitespace carries information). */
function HeroTile({
  label,
  icon,
  value,
  valueSuffix,
  sub,
  title,
  delta,
  deltaBaseline,
  spark,
  sparkColorVar,
  resetKey,
  testId,
  animate,
}: HeroTileProps) {
  const pulseRef = useValuePulse(value, { resetKey });
  return (
    <div className="bg-surface-raised border border-edge rounded-lg px-4 pt-3 pb-2 flex flex-col" data-testid={testId} title={title}>
      <div className="flex items-center gap-1.5 text-fg-muted">
        <span className="flex-shrink-0" aria-hidden>{icon}</span>
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-1">
        <span ref={pulseRef} className="text-3xl font-semibold text-fg tabular-nums" data-testid={`${testId}-value`}>{value}</span>
        {valueSuffix && <span className="text-sm text-fg-muted">{valueSuffix}</span>}
      </div>
      <HeroContextLine sub={sub} delta={delta} baseline={deltaBaseline} />
      <div className="flex-1 min-h-8 mt-1.5">
        <KngSparkline points={spark} colorVar={sparkColorVar} className="h-full w-full" animate={animate} />
      </div>
    </div>
  );
}

/** Neutral signed delta for the secondary strip: the +/- sign carries the
 *  direction (no redundant arrow glyph), muted (activity metrics, not spend),
 *  with the comparison window in the tooltip. */
function CompactDelta({ delta, baseline }: { delta: number | null; baseline: string }) {
  if (delta === null || baseline === '') return null;
  return (
    <span className="text-[11px] text-fg-muted tabular-nums flex-shrink-0" title={baseline}>
      {`${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%`}
    </span>
  );
}

interface CompactTileProps {
  label: string;
  icon: ReactNode;
  value: string;
  /** Optional styled rendering of `value` (same text content - `value` still
   *  drives the change pulse and the testid's text). */
  valueNode?: ReactNode;
  sub?: string;
  title?: string;
  delta?: number | null;
  deltaBaseline?: string;
  resetKey: string;
  testId: string;
}

/** One card of the secondary stats row: the same chrome as the hero tiles
 *  (and every other surface on the page), just smaller. The icon is a
 *  vertically-centered anchor spanning BOTH text rows, so label and value
 *  share one left edge with nothing floating beside them. */
function CompactTile({ label, icon, value, valueNode, sub, title, delta = null, deltaBaseline = '', resetKey, testId }: CompactTileProps) {
  const pulseRef = useValuePulse(value, { resetKey });
  return (
    <div className="bg-surface-raised border border-edge rounded-lg px-3 py-2.5 min-w-0 flex items-center gap-2.5" data-testid={testId} title={title}>
      <span className="flex-shrink-0 text-fg-muted" aria-hidden>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-fg-muted truncate">{label}</div>
        {/* Two clean columns: value anchored left, quiet signed delta at the
            cell's far edge - a straight line to scan down the strip. */}
        <div className="flex items-baseline justify-between gap-1.5 mt-0.5 min-w-0">
          <span ref={pulseRef} className="text-sm font-semibold text-fg tabular-nums truncate" data-testid={`${testId}-value`}>{valueNode ?? value}</span>
          <CompactDelta delta={delta} baseline={deltaBaseline} />
        </div>
        {sub && <div className="text-[11px] text-fg-muted tabular-nums truncate">{sub}</div>}
      </div>
    </div>
  );
}

interface KpiTilesProps {
  payload: UsageDashboardStats | null;
  period: UsageTimePeriod;
  scopeKind: UsageStatsScopeKind;
  /** The effectively-viewed project id (viewed-or-current), null for all. */
  effectiveProjectId: string | null;
  /** False during a day drill or custom window: a (possibly past) bounded
   *  range is pure ledger accounting, so in-memory live-session usage must
   *  not layer on top. */
  includeLive: boolean;
  /** True while a custom month window overrides the quick period (the delta
   *  baseline reads "vs preceding window" instead of the period label). */
  hasCustomWindow: boolean;
  tokenSparkline: TimePoint[];
  costSparkline: TimePoint[];
  burnSparkline: TimePoint[];
  /** Suspend sparkline animations during an active window resize. */
  animate: boolean;
}

/**
 * KPI stat tiles: three hero tiles (Tokens, Cost, Burn Rate - large value,
 * vs-previous-period delta, sparkline filling the tile) over a compact
 * secondary strip.
 *
 * Two distinct live-data paths, kept deliberately separate:
 * - Tokens/Cost: layered CLIENT-SIDE via `useLiveUsageAggregate`, which reads
 *   the push-fed `sessionUsage` cache with zero IPC round-trip - required for
 *   instant reactivity (a pushed usage tick must repaint within one animation
 *   frame; see `useValuePulse`'s resetKey contract). For 'live' the tiles show
 *   ONLY in-memory running-session usage; for DB periods the payload totals
 *   get the live sessions layered on top.
 * - Sessions: read from `payload.kpis.sessionCount` directly - the server
 *   (`usage-stats-service.ts`) already folds in-flight sessions into this
 *   count (deduped against the ledger), so no client-side layering is needed
 *   or wanted here. The "N active now" subtitle is a purely cosmetic
 *   restatement of how many of that count are live right now.
 */
export function KpiTiles({
  payload,
  period,
  scopeKind,
  effectiveProjectId,
  includeLive,
  hasCustomWindow,
  tokenSparkline,
  costSparkline,
  burnSparkline,
  animate,
}: KpiTilesProps) {
  const sessions = useSessionStore((state) => state.sessions);

  const liveFilter = useMemo<ReadonlySet<string> | 'all'>(() => {
    if (!includeLive) return new Set<string>();
    if (scopeKind !== 'project' || !effectiveProjectId) return 'all';
    return new Set(
      sessions.filter((session) => session.projectId === effectiveProjectId).map((session) => session.id),
    );
  }, [includeLive, scopeKind, effectiveProjectId, sessions]);

  const live = useLiveUsageAggregate(liveFilter);

  // Cosmetic-only: the server already counts these sessions into
  // `kpis.sessionCount` for the headline; this mirrors that scoping (project
  // vs all, running/queued only) purely to label how many are live right now.
  const liveSessionCount = useMemo(() => {
    if (!includeLive) return 0;
    return sessions.filter((session) => {
      if (session.status !== 'running' && session.status !== 'queued') return false;
      if (scopeKind === 'project' && effectiveProjectId) return session.projectId === effectiveProjectId;
      return true;
    }).length;
  }, [includeLive, scopeKind, effectiveProjectId, sessions]);

  const kpis = payload?.kpis ?? null;
  const previous = payload?.previousKpis ?? null;
  const isLive = period === 'live' && includeLive;
  const displayInput = isLive ? live.input : (kpis?.totalInputTokens ?? 0) + live.input;
  const displayOutput = isLive ? live.output : (kpis?.totalOutputTokens ?? 0) + live.output;
  const displayCost = isLive ? live.cost : (kpis?.totalCostUsd ?? 0) + live.cost;
  const costKnown = (kpis?.costKnown ?? false) || live.cost > 0;

  const cacheDenominator =
    (kpis?.cacheReadTokens ?? 0) + (kpis?.cacheCreationTokens ?? 0) + (kpis?.turnInputTokens ?? 0);
  const cacheReadShare = cacheDenominator > 0 ? (kpis?.cacheReadTokens ?? 0) / cacheDenominator : null;

  // Second-row stat for the Cost tile: blended $/Mtok (the tokens<->cost
  // bridge, same math as the per-project table's blended-rate column).
  const displayTokens = displayInput + displayOutput;
  const costSub = displayCost > 0 && displayTokens > 0
    ? `${formatCost(displayCost / (displayTokens / 1_000_000))}/Mtok (blended)`
    : undefined;

  const burnIsUsd = kpis?.burnRateUsdPerHour != null && costKnown;
  const burnValue = burnIsUsd
    ? formatCost(kpis!.burnRateUsdPerHour!)
    : kpis?.burnRateTokensPerHour != null
      ? `${formatTokenCount(Math.round(kpis.burnRateTokensPerHour))} tok`
      : '-';
  const burnSub = burnIsUsd && kpis?.burnRateTokensPerHour != null
    ? `${formatTokenCount(Math.round(kpis.burnRateTokensPerHour))} tok/hr`
    : undefined;

  // Deltas compare the LEDGER windows only (no live layering on either side).
  // A custom window compares against the same-length window preceding it.
  const deltaBaseline = payload?.previousKpis
    ? (hasCustomWindow ? 'vs preceding window' : DELTA_BASELINE_LABELS[period])
    : '';
  const tokenDelta = deltaPercent(kpis?.totalTokens ?? 0, previous?.totalTokens);
  const costDelta = deltaPercent(kpis?.totalCostUsd ?? 0, previous?.totalCostUsd);
  const burnDelta = burnIsUsd
    ? deltaPercent(kpis?.burnRateUsdPerHour ?? 0, previous?.burnRateUsdPerHour)
    : deltaPercent(kpis?.burnRateTokensPerHour ?? 0, previous?.burnRateTokensPerHour);

  // Secondary-strip deltas (ledger windows only, like the heroes). Lines
  // compares total churn (added + removed); cache-read share deliberately has
  // no delta (a percent change of a percentage reads as noise).
  const sessionsDelta = deltaPercent(kpis?.sessionCount ?? 0, previous?.sessionCount);
  const toolCallsDelta = deltaPercent(kpis?.toolCallCount ?? 0, previous?.toolCallCount);
  const linesDelta = deltaPercent(
    (kpis?.linesAdded ?? 0) + (kpis?.linesRemoved ?? 0),
    previous ? previous.linesAdded + previous.linesRemoved : null,
  );
  const filesDelta = deltaPercent(kpis?.filesChanged ?? 0, previous?.filesChanged);
  const compactionsDelta = deltaPercent(kpis?.compactionCount ?? 0, previous?.compactionCount);
  const avgSessionDelta = deltaPercent(
    kpis && kpis.sessionCount > 0 ? kpis.totalDurationMs / kpis.sessionCount : 0,
    previous && previous.sessionCount > 0 ? previous.totalDurationMs / previous.sessionCount : null,
  );

  // Context identity for the pulse rebaseline: scope, project, range, AND the
  // drilled day (payload rangeStart pins it) - any of these changing is a
  // context switch, not a live tick (restore-no-animation-replay).
  const resetKey = `${scopeKind}:${effectiveProjectId ?? 'all'}:${period}:${includeLive ? 'base' : payload?.rangeStartMs ?? 'drill'}`;

  return (
    <div className="flex flex-col gap-2" data-testid="kpi-tiles">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <HeroTile
          label="Total Tokens"
          icon={<Braces size={14} />}
          value={formatTokenCount(displayInput + displayOutput)}
          sub={`${formatTokenCount(displayInput)} in / ${formatTokenCount(displayOutput)} out`}
          delta={tokenDelta}
          deltaBaseline={deltaBaseline}
          spark={tokenSparkline}
          sparkColorVar="--kng-accent"
          resetKey={resetKey}
          testId="kpi-tokens"
          animate={animate}
        />
        <HeroTile
          label="Cost"
          icon={<CircleDollarSign size={14} />}
          value={formatCost(displayCost)}
          sub={costSub}
          title={costKnown ? 'API-equivalent cost as reported by agents' : 'No cost reported by agents in this range'}
          delta={costDelta}
          deltaBaseline={deltaBaseline}
          spark={costSparkline}
          sparkColorVar="--kng-accent"
          resetKey={resetKey}
          testId="kpi-cost"
          animate={animate}
        />
        <HeroTile
          label="Burn Rate"
          icon={<Flame size={14} />}
          value={burnValue}
          valueSuffix={burnValue === '-' ? undefined : '/hr'}
          sub={burnSub}
          title="Averaged over the selected range; $/hr is approximate (session cost allocated across turns)"
          delta={burnDelta}
          deltaBaseline={deltaBaseline}
          spark={burnSparkline}
          sparkColorVar="--kng-accent"
          resetKey={resetKey}
          testId="kpi-burn-rate"
          animate={animate}
        />
      </div>

      {/* Secondary stats: discrete cards in the same grid rhythm as the hero
          row above - every surface on the page shares one card chrome. */}
      <div className="grid grid-cols-7 gap-2" data-testid="kpi-compact-strip">
        <CompactTile
          label="Sessions"
          icon={<SquareTerminal size={14} />}
          value={String(kpis?.sessionCount ?? 0)}
          sub={liveSessionCount > 0 ? `${liveSessionCount} active now` : undefined}
          delta={sessionsDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-sessions"
        />
        <CompactTile
          label="Tool Calls"
          icon={<Wrench size={14} />}
          value={formatTokenCount(kpis?.toolCallCount ?? 0)}
          delta={toolCallsDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-tool-calls"
        />
        <CompactTile
          label="Lines"
          icon={<FileDiff size={14} />}
          value={`+${formatTokenCount(kpis?.linesAdded ?? 0)} / -${formatTokenCount(kpis?.linesRemoved ?? 0)}`}
          valueNode={
            <>
              <span className="text-green-400/70">{`+${formatTokenCount(kpis?.linesAdded ?? 0)}`}</span>
              {' / '}
              <span className="text-red-400/70">{`-${formatTokenCount(kpis?.linesRemoved ?? 0)}`}</span>
            </>
          }
          delta={linesDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-lines"
        />
        <CompactTile
          label="Files"
          icon={<Files size={14} />}
          value={formatTokenCount(kpis?.filesChanged ?? 0)}
          delta={filesDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-files"
        />
        <CompactTile
          label="Cache Reads"
          icon={<Zap size={14} />}
          value={cacheReadShare != null ? `${Math.round(cacheReadShare * 100)}%` : '-'}
          title={cacheReadShare != null
            ? 'Share of context input served from prompt cache (turn-derived)'
            : 'Not reported by these agents in this range'}
          resetKey={resetKey}
          testId="kpi-cache"
        />
        <CompactTile
          label="Compactions"
          icon={<Layers size={14} />}
          value={kpis && kpis.compactionCount > 0 ? String(kpis.compactionCount) : '-'}
          title={kpis && kpis.compactionCount > 0
            ? 'Context compactions across the range'
            : 'None reported by these agents in this range'}
          delta={kpis && kpis.compactionCount > 0 ? compactionsDelta : null}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-compactions"
        />
        <CompactTile
          label="Avg Session"
          icon={<Timer size={14} />}
          value={kpis && kpis.sessionCount > 0 ? formatDuration(kpis.totalDurationMs / kpis.sessionCount) : '-'}
          delta={avgSessionDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-avg-session"
        />
      </div>
    </div>
  );
}
