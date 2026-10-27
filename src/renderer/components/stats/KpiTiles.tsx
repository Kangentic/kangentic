import { useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  Braces,
  CircleDollarSign,
  FileDiff,
  Files,
  Flame,
  GitFork,
  Layers,
  SquareTerminal,
  Timer,
  TrendingDown,
  TrendingUp,
  Wrench,
  Zap,
} from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { UsageDashboardStats, UsageStatsScopeKind, UsageTimePeriod } from '../../../shared/types';
import type { LocalizedText } from '../../../shared/i18n/text';
import { translateText } from '../../i18n/translate';
import { useSessionStore } from '../../stores/session-store';
import { useLiveUsageAggregate } from '../../hooks/useLiveUsageAggregate';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';
import { useValuePulse } from '../../hooks/useValuePulse';
import { CompactTile } from './CompactTile';
import { Tooltip } from '../Tooltip';
import { agentShortName } from '../../utils/agent-display-name';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatDate } from '../../lib/datetime';
import { KngSparkline } from './charts/KngSparkline';
import {
  deltaPercent,
  resolveAvgActiveMs,
  resolveCacheReadShare,
  resolveDisplayCost,
  resolveTokenBuckets,
  selectLiveSessionIds,
  type TimePoint,
} from './useStatsData';

/** The "vs ..." label per range for the hero deltas. All Time has none, and an
 *  empty baseline is what hides the delta pill. */
const DELTA_BASELINE_LABELS: Record<UsageTimePeriod, LocalizedText> = {
  live: msg`vs prior 2h`,
  today: msg`vs yesterday`,
  week: msg`vs last week`,
  month: msg`vs last month`,
  all: '',
};

/** The hero's ONE quiet context line: the secondary stat and the directional
 *  delta render as two muted pills, so the tile stays three layers - label,
 *  big value, context - and the separation is structural (containers), not
 *  punctuation. Spend/usage going UP reads warm, going DOWN calm-green. */
/** "Claude", "Claude and Codex", "Claude, Codex and Gemini". A plain `join(' and ')`
 *  reads as "A and B and C" once a third agent ships. */
function joinAgentNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const leadingNames = names.slice(0, -1).join(', ');
  const lastName = names[names.length - 1];
  return i18n._(msg`${leadingNames} and ${lastName}`);
}

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
  /** What the tile measures, as its tooltip. */
  tip?: string;
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
  tip,
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
    <Tooltip label={tip ?? ''}>
      <div className="bg-surface-raised border border-edge rounded-lg px-4 pt-3 pb-2 flex flex-col" data-testid={testId}>
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
    </Tooltip>
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
  /** The dashboard's Cost/Tokens toggle (tokens when no agent reported cost).
   *  The Burn Rate tile's value follows it; the other rate is its sub-line. */
  metric: UsageMetricMode;
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
 *   get the live sessions layered on top, MINUS `liveLedgerBaseline`, which is
 *   the part of those same sessions the ledger already holds. Both halves of
 *   that subtraction matter: without the status filter the overlay includes
 *   finalized sessions, and without the baseline it re-adds running ones the
 *   45s metrics timer already wrote.
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
  metric,
  tokenSparkline,
  costSparkline,
  burnSparkline,
  animate,
}: KpiTilesProps) {
  const { t } = useLingui();
  const sessions = useSessionStore((state) => state.sessions);

  // The ONE live-session set, shared by the usage overlay and the "N active
  // now" label so the two can never disagree about what counts as live. It has
  // to match what main puts in `liveSessions`, which is what
  // `liveLedgerBaseline` below is measured over, or the subtraction is against
  // the wrong sessions. See `selectLiveSessionIds` for which sessions that is
  // and why each filter is there.
  const liveSessionIds = useMemo<ReadonlySet<string>>(
    () => selectLiveSessionIds(sessions, { includeLive, scopeKind, effectiveProjectId }),
    [includeLive, scopeKind, effectiveProjectId, sessions],
  );

  const live = useLiveUsageAggregate(liveSessionIds);

  // Cosmetic-only: the server already counts these sessions into
  // `kpis.sessionCount` for the headline; this labels how many are live now.
  const liveSessionCount = liveSessionIds.size;

  const kpis = payload?.kpis ?? null;
  const previous = payload?.previousKpis ?? null;
  const isLive = period === 'live' && includeLive;
  // The live overlay carries each running session's CUMULATIVE reading, and
  // the 45s metrics timer has already upserted that reading into the ledger.
  // So the ledger's own share of these sessions comes off before the overlay
  // goes on; otherwise every running session is counted twice and the tile
  // floats above the breakdowns, which get no overlay at all.
  const displayCost = resolveDisplayCost({
    isLivePeriod: isLive,
    ledgerCostUsd: kpis?.totalCostUsd ?? 0,
    // Optional-chained through the object too: a payload cached from an older
    // shape (or a dev server mid-upgrade) has no `liveLedgerBaseline`, and a
    // throw here takes the whole dashboard down.
    liveLedgerBaselineCostUsd: payload?.liveLedgerBaseline?.costUsd ?? 0,
    liveOverlayCostUsd: live.cost,
  });
  const costKnown = (kpis?.costKnown ?? false) || live.cost > 0;

  // The four disjoint token types, off the per-turn ledger. Only INPUT has a
  // cached counterpart, which is why it alone carries the `fresh` qualifier.
  // See `resolveTokenBuckets` for why there is no single combined total.
  const tokens = resolveTokenBuckets(kpis);
  const { freshInputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, hasTokens } = tokens;
  const cacheReadShare = resolveCacheReadShare(tokens);

  // The turn ledger starts later than the cost ledger and the CLI prunes the
  // transcripts that would backfill it, so a range reaching back before that
  // genuinely has no token data for its early part. Say so on the tile rather
  // than letting the number read as full coverage.
  const earliestTurnMs = payload?.earliestTurnMs ?? null;
  const tokensPartialFrom = earliestTurnMs !== null && payload && payload.rangeStartMs < earliestTurnMs
    ? earliestTurnMs
    : null;
  const cacheWriteText = formatTokenCount(cacheCreationTokens);
  const cacheReadText = formatTokenCount(cacheReadTokens);
  const freshInputText = formatTokenCount(freshInputTokens);
  const outputText = formatTokenCount(outputTokens);
  const captureStart = tokensPartialFrom !== null ? formatDate(tokensPartialFrom) : null;
  const tokensTip = !hasTokens
    ? t`No per-turn token data recorded in this range`
    : [
        t`Fresh input and output on the main thread. ${cacheWriteText} cache write and ${cacheReadText} cache read are counted separately and priced differently.`,
        captureStart !== null
          ? t`Per-turn capture starts ${captureStart}, so this covers less of the range than Cost does.`
          : null,
      ].filter(Boolean).join(' ');

  // The Burn Rate tile follows the toggle like the sparkline under it: the
  // selected rate is the value and the other one is the sub-line, so both
  // rates stay on screen whichever way the toggle is set.
  const usdPerHour = costKnown ? kpis?.burnRateUsdPerHour ?? null : null;
  const tokensPerHour = kpis?.burnRateTokensPerHour ?? null;
  const burnIsUsd = metric === 'cost' && usdPerHour !== null;
  const tokensPerHourText = tokensPerHour !== null ? formatTokenCount(Math.round(tokensPerHour)) : null;
  const burnValue = burnIsUsd ? formatCost(usdPerHour) : tokensPerHourText ?? '-';
  const burnValueSuffix = burnValue === '-' ? undefined : burnIsUsd ? '/hr' : t`tokens/hr`;
  const burnSub = burnIsUsd
    ? (tokensPerHourText !== null ? t`${tokensPerHourText} tokens/hr` : undefined)
    : (usdPerHour !== null ? `${formatCost(usdPerHour)}/hr` : undefined);

  // Deltas read the same base as the value above them. They used to compare
  // bare ledger totals while the hero showed ledger-plus-overlay, so the
  // number and its percentage described two different quantities.
  // A custom window compares against the same-length window preceding it.
  const deltaBaseline = payload?.previousKpis
    ? (hasCustomWindow ? t`vs preceding window` : translateText(DELTA_BASELINE_LABELS[period]))
    : '';
  const tokenDelta = deltaPercent(
    freshInputTokens + outputTokens,
    previous ? previous.turnInputTokens + previous.turnOutputTokens : null,
  );
  const costDelta = deltaPercent(displayCost, previous?.totalCostUsd);
  const burnDelta = burnIsUsd
    ? deltaPercent(usdPerHour ?? 0, previous?.burnRateUsdPerHour)
    : deltaPercent(tokensPerHour ?? 0, previous?.burnRateTokensPerHour);

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
  // Subagent tile: fresh + output, the same "tokens" the hero tile means, so the
  // two read on one scale. Cache reads go in the subtitle instead of the total
  // because they dwarf everything else on a fan-out range (52.3M against 279k on
  // a real review) and would make the tile unreadable against its neighbours.
  const subagentTokens = (kpis?.subagentInputTokens ?? 0) + (kpis?.subagentOutputTokens ?? 0);
  const subagentDelta = deltaPercent(
    subagentTokens,
    previous ? previous.subagentInputTokens + previous.subagentOutputTokens : null,
  );
  const hasSubagentTurns = Boolean(kpis && kpis.subagentTurnCount > 0);
  const nestedCount = kpis?.subagentNestedCount ?? 0;
  // One fact, the shape the Sessions tile has. The sub-line gets
  // (windowWidth - 88) / 8 - 50 px (measured against the live strip: 119px at a
  // 1440 window), and "5,845 agent(s), 13.5B cached" truncated there. The cache
  // read and the nesting count read in the tooltip and in both MCP outputs
  // instead, neither of which is space-bound, and the Cache Reads tile beside
  // this one already covers the cache.
  const subagentCount = kpis?.subagentCount ?? 0;
  const subagentCountText = subagentCount.toLocaleString();
  const subagentSub = hasSubagentTurns
    ? plural(subagentCount, { one: `${subagentCountText} subagent`, other: `${subagentCountText} subagents` })
    : undefined;
  // A blind range is not an empty one. Only Claude reports subagent usage today,
  // so a Codex or Gemini range renders the same `-` a genuinely quiet Claude
  // range does, and nothing on the tile distinguishes "nothing fanned out" from
  // "fan-outs here are not measurable".
  const blindAgents = payload?.subagentBlindAgents ?? [];
  const blindLabel = joinAgentNames(blindAgents.map(agentShortName));
  // One agent takes a singular verb, so each sentence is a plural on the count.
  const blindAgentCount = blindAgents.length;
  const subagentTurnCountText = (kpis?.subagentTurnCount ?? 0).toLocaleString();
  const subagentCacheReadText = formatTokenCount(kpis?.subagentCacheReadTokens ?? 0);
  // Raw numbers, as this sentence has always printed them.
  const nestedCountText = String(nestedCount);
  const subagentTotalText = String(subagentCount);
  const subagentTip = hasSubagentTurns
    ? [
        t`Fresh input and output from ${subagentTurnCountText} subagent turn(s). The Tokens tile is main-thread only, so these are on top of it; the session's reported Cost already covers them.`,
        t`${subagentCacheReadText} cache read.`,
        nestedCount > 0
          ? plural(nestedCount, {
              one: `${nestedCountText} of ${subagentTotalText} was spawned by another subagent.`,
              other: `${nestedCountText} of ${subagentTotalText} were spawned by another subagent.`,
            })
          : null,
        blindAgentCount > 0
          ? plural(blindAgentCount, {
              one: `Excludes ${blindLabel}, which does not report subagent usage.`,
              other: `Excludes ${blindLabel}, which do not report subagent usage.`,
            })
          : null,
      ].filter(Boolean).join(' ')
    : blindAgentCount > 0
      ? plural(blindAgentCount, {
          one: `${blindLabel} does not report subagent usage, so fan-outs in this range cannot be counted.`,
          other: `${blindLabel} do not report subagent usage, so fan-outs in this range cannot be counted.`,
        })
      : t`No subagent turns recorded in this range`;
  // Avg Active is ACTIVE time per covered session, not wall clock per ledger
  // row. Two things changed and both matter. The old numerator was the agent's
  // own `total_duration_ms`, which counts every hour a session sat idle (active
  // time measures 39% of it on the dogfooding install). And the old denominator
  // was `sessionCount`, a count of `usage_history` rows, while the numerator
  // now comes from the interval ledger, which covers fewer sessions - so the
  // denominator has to be that ledger's own count or the average is over two
  // different populations.
  const activeCoveredSessions = kpis?.activeSessionsCovered ?? 0;
  const coveredSessionsCompact = formatTokenCount(activeCoveredSessions);
  const coveredSessionsText = activeCoveredSessions.toLocaleString();
  const avgActiveMs = resolveAvgActiveMs(kpis?.activeMs ?? 0, activeCoveredSessions);
  const previousAvgActiveMs = previous
    ? resolveAvgActiveMs(previous.activeMs, previous.activeSessionsCovered)
    : null;
  const avgActiveDelta = deltaPercent(avgActiveMs ?? 0, previousAvgActiveMs);

  // Context identity for the pulse rebaseline: scope, project, range, AND the
  // drilled day (payload rangeStart pins it) - any of these changing is a
  // context switch, not a live tick (restore-no-animation-replay).
  const resetKey = `${scopeKind}:${effectiveProjectId ?? 'all'}:${period}:${includeLive ? 'base' : payload?.rangeStartMs ?? 'drill'}`;

  return (
    <div className="flex flex-col gap-2" data-testid="kpi-tiles">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <HeroTile
          label={t`Tokens`}
          icon={<Braces size={14} />}
          value={hasTokens ? formatTokenCount(freshInputTokens + outputTokens) : '-'}
          sub={hasTokens
            ? t`${freshInputText} in / ${outputText} out`
            : undefined}
          tip={tokensTip}
          delta={tokenDelta}
          deltaBaseline={deltaBaseline}
          spark={tokenSparkline}
          sparkColorVar="--kng-accent"
          resetKey={resetKey}
          testId="kpi-tokens"
          animate={animate}
        />
        <HeroTile
          label={t`Cost`}
          icon={<CircleDollarSign size={14} />}
          value={formatCost(displayCost)}
          sub={costKnown ? t`API-equivalent` : undefined}
          tip={costKnown
            ? t`Priced at API list rates from the tokens each agent reported. Not what a subscription was billed.`
            : t`No cost reported by agents in this range`}
          delta={costDelta}
          deltaBaseline={deltaBaseline}
          spark={costSparkline}
          sparkColorVar="--kng-accent"
          resetKey={resetKey}
          testId="kpi-cost"
          animate={animate}
        />
        <HeroTile
          label={t`Burn Rate`}
          icon={<Flame size={14} />}
          value={burnValue}
          valueSuffix={burnValueSuffix}
          sub={burnSub}
          tip={t`Cost and main-thread tokens averaged over the whole selected range, idle time included. Both lines use the same hours, so each one times the range reproduces the tile above it.`}
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
      <div className="grid grid-cols-8 gap-2" data-testid="kpi-compact-strip">
        <CompactTile
          label={t`Sessions`}
          icon={<SquareTerminal size={14} />}
          value={(kpis?.sessionCount ?? 0).toLocaleString()}
          sub={liveSessionCount > 0 ? t`${liveSessionCount} active now` : undefined}
          // Names what it counts. A resume is a separate CLI invocation and so
          // a separate session, which is the convention Claude Code itself
          // uses, but it means the count is not a count of distinct pieces of
          // work: 277 of this project's 2,434 legs did nothing at all. Without
          // saying so the number reads as "tasks worked on".
          tip={t`CLI invocations, counting each resume of a conversation separately`}
          delta={sessionsDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-sessions"
        />
        <CompactTile
          label={t`Tool Calls`}
          icon={<Wrench size={14} />}
          value={formatTokenCount(kpis?.toolCallCount ?? 0)}
          delta={toolCallsDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-tool-calls"
        />
        <CompactTile
          label={t`Lines`}
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
          label={t`Files`}
          icon={<Files size={14} />}
          value={formatTokenCount(kpis?.filesChanged ?? 0)}
          delta={filesDelta}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-files"
        />
        <CompactTile
          label={t`Cache Reads`}
          icon={<Zap size={14} />}
          value={cacheReadShare != null ? `${Math.round(cacheReadShare * 100)}%` : '-'}
          // The absolute belongs on the tile, not only in the tooltip: a bare
          // 99% is a share of a number nothing else on the screen shows, and
          // cache read is the largest token bucket by an order of magnitude.
          sub={cacheReadShare != null ? t`${cacheReadText} read` : undefined}
          tip={cacheReadShare != null
            ? t`Cache read as a share of all input: ${cacheReadText} read against ${cacheWriteText} written and ${freshInputText} fresh.`
            : t`Not reported by these agents in this range`}
          resetKey={resetKey}
          testId="kpi-cache"
        />
        <CompactTile
          label={t`Subagents`}
          icon={<GitFork size={14} />}
          value={hasSubagentTurns ? formatTokenCount(subagentTokens) : '-'}
          sub={subagentSub}
          tip={subagentTip}
          delta={hasSubagentTurns ? subagentDelta : null}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-subagents"
        />
        <CompactTile
          label={t`Compactions`}
          icon={<Layers size={14} />}
          value={kpis && kpis.compactionCount > 0 ? String(kpis.compactionCount) : '-'}
          tip={kpis && kpis.compactionCount > 0
            ? t`Context compactions across the range`
            : t`None reported by these agents in this range`}
          delta={kpis && kpis.compactionCount > 0 ? compactionsDelta : null}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-compactions"
        />
        <CompactTile
          label={t`Avg Active`}
          icon={<Timer size={14} />}
          value={avgActiveMs !== null ? formatDuration(avgActiveMs) : '-'}
          // The covered-session count is on the tile, not buried in the
          // tooltip: it is a different population from the Sessions tile two
          // cards to the left, and a reader comparing them deserves to see why.
          sub={avgActiveMs !== null ? t`over ${coveredSessionsCompact} sessions` : undefined}
          tip={avgActiveMs !== null
            ? t`Time the agent was working, per session, excluding idle. Covers the ${coveredSessionsText} session(s) with activity tracking in this range, which is fewer than the Sessions tile counts.`
            : t`No activity tracking recorded in this range`}
          // Gated like the subagent and compaction tiles above: with no
          // coverage this range the value renders '-', and an ungated delta
          // would put a -100% pill beside it. "Not measured" is not "measured
          // as nothing", which is the whole reason resolveAvgActiveMs returns
          // null rather than 0.
          delta={avgActiveMs !== null ? avgActiveDelta : null}
          deltaBaseline={deltaBaseline}
          resetKey={resetKey}
          testId="kpi-avg-session"
        />
      </div>
    </div>
  );
}
