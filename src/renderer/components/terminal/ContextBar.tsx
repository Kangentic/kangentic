import { useState, useRef, useEffect } from 'react';
import { ArrowUp, ArrowDown, Loader2, Clock, Calendar, Wrench, Hourglass, ChevronDown, Gauge } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { RateLimitWindow } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/progress-color';
import { liveRateLimitWindows, rateLimitWindowsShortestFirst, windowElapsedPercentage } from '../../utils/rate-limit-window';
import { formatTokenCount, isContextWindowKnown, contextWindowDisplayPercent } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatMonthDayTime, formatTimeAgo } from '../../lib/datetime';
import { agentDisplayName } from '../../utils/agent-display-name';
import { shellDisplayName } from '../../utils/shell-display-name';
import { useValuePulse } from '../../hooks/useValuePulse';
import { ModelEffortPicker } from './ModelEffortPicker';
import { ProfilePicker } from './ProfilePicker';
import { ElapsedTime } from './ElapsedTime';
import { ToolBreakdownPopover } from './ToolBreakdownPopover';
import { pill, pillForProvenance } from './context-bar-pill';
import { ContextBarOverflow, type ContextBarOverflowItem } from './ContextBarOverflow';
import { useContextBarFold } from './useContextBarFold';
import type { ContextBarFoldId } from './context-bar-fold';
import { Tooltip } from '../Tooltip';

/** The +N list's order: the row's own, left to right. The agent's name lists with its version. */
const OVERFLOW_LIST_ORDER: ContextBarFoldId[] = [
  'shell', 'version', 'rate-limits', 'cost', 'tool-calls', 'agent-active', 'tokens', 'context-fraction', 'context', 'elapsed',
];

/** What a pill in the row carries for the fold: its id, and while folded, out of reach. */
type ContextBarFoldAttributes =
  | { 'data-fold-id': ContextBarFoldId }
  | { 'data-fold-id': ContextBarFoldId; 'data-folded': string; 'aria-hidden': boolean; inert: boolean };

interface ContextBarProps {
  sessionId: string;
  /** Fallback agent identifier when the session has no task row (e.g. transient command-terminal sessions). */
  agentFallback?: string | null;
}

/** Extract the version number from the raw string (e.g. "2.1.50 (Claude Code)" -> "2.1.50"). */
function parseAgentVersion(version: string | null | undefined): string | null {
  return version?.replace(/\s*\(.*\)/, '') || null;
}

// `[transform:translateZ(0)]` promotes the footer to its own compositing layer.
// Without it, a freshly-spawned tiled window's frame composites such that the bar's
// text-only pills (shell / version / cost / tokens) lay out correctly but Chromium
// skips PAINTING them until a repaint is forced (pop-out / resize otherwise heals
// it). Its own layer makes the bar paint independently of the frame composite, so
// the pills render from the first frame. The bar's popovers (model / effort picker,
// token breakdown) BODY-PORTAL with `strategy: 'fixed'`, so they escape this layer's
// stacking context / hit-test clip rather than overflowing it.
//
// Every root using this class also carries `data-no-dismiss`. In the bottom panel the bar is a
// SIBLING of the terminal pane, so it is outside both the pane wrapper's marker and `.xterm`;
// without its own marker a click on the bar's padding, its inter-pill gaps, or any text-only
// pill (shell, version, cost, tokens, elapsed, the "Starting agent..." spinner) is dead space
// inside the board's dismiss layer and would close an open task-detail window instead - which
// also releases that window's session claim and re-creates the xterm. None of those pills has a
// pointer cursor, so the cursor heuristic in `useClickOutsideToClose.ts` cannot exclude them.
// The picker triggers are unaffected: the marker opts out of light dismiss, never of their own
// clicks. Harmless in the task-detail and command-terminal hosts, which are already excluded
// wholesale by `data-window-layer-root`.
//
// One row, inset 4px each side: what does not fit folds into the +N list (`useContextBarFold`).
const containerClass = 'relative min-h-8 bg-surface/80 border-t border-edge flex flex-nowrap items-center overflow-hidden px-1 py-1.5 gap-x-2 text-xs flex-shrink-0 [transform:translateZ(0)]';

function formatResetTime(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return i18n._(msg`Resets now`);
  if (ms < 24 * 60 * 60 * 1000) {
    const duration = formatDuration(ms);
    return i18n._(msg`Resets in ${duration}`);
  }
  const resetMoment = formatMonthDayTime(epochSeconds * 1000);
  return i18n._(msg`Resets ${resetMoment}`);
}

// Maps adapter-declared RateLimitWindow.iconKind to a Lucide icon. The visual
// vocabulary lives here in the renderer so adapters declare semantics, not chrome.
const RATE_LIMIT_ICON: Record<RateLimitWindow['iconKind'], LucideIcon> = {
  session: Clock,
  period: Calendar,
};

/**
 * One rate-limit window row: icon + usage track + percent. The colored fill is
 * driven by `usedPercentage` (budget spent); a caret-topped vertical tick
 * marks how far through the time window we are (elapsed time, not budget),
 * creeping right as the reset time draws nearer. `now` (epoch ms) comes from
 * the pill's tick (`RateLimitsPill`).
 */
function RateLimitBar({ limitWindow, now }: { limitWindow: RateLimitWindow; now: number }) {
  const Icon = RATE_LIMIT_ICON[limitWindow.iconKind];
  const roundedUsedPercentage = Math.round(limitWindow.usedPercentage);
  // windowDurationSeconds is optional: a window with no fixed duration draws no
  // time marker, so only compute the position when the adapter supplied one.
  const markerPercentage = limitWindow.windowDurationSeconds === undefined
    ? null
    : windowElapsedPercentage(limitWindow.resetsAt, limitWindow.windowDurationSeconds, now);

  return (
    <span className="flex items-center gap-1.5 flex-1 min-w-0">
      <Icon size={11} className="text-fg-faint flex-shrink-0" aria-label={limitWindow.label} />
      {/* No overflow-hidden so the caret atop the tick marker, which extends a
          few px above the track, is not clipped. The fill is width-capped at
          100%, so nothing overflows horizontally and the track still reads as a
          pill. */}
      <span className="relative flex-1 min-w-[40px] h-1.5 bg-surface-hover rounded-full" data-meter-track="">
        {/* This one stays on `width` on purpose, unlike the context fill above and
            ContextUsageFooter's. The `minWidth: 2px` floor below keeps a barely
            started window visible, and that is a width-space idea with no
            scale-space equivalent short of measuring the track and dividing - a
            layout read on every render, to remove a transition that fires when a
            rate-limit window ticks, which is minutes apart rather than per token.
            The composited-transform rewrite is not worth that trade here. */}
        <span
          className="block h-full rounded-full transition-[width,background-color] duration-300"
          style={{
            width: `${Math.min(roundedUsedPercentage, 100)}%`,
            minWidth: roundedUsedPercentage > 0 ? '2px' : undefined,
            backgroundColor: getProgressColor(roundedUsedPercentage),
          }}
        />
        {markerPercentage !== null && (
          <span
            data-testid="rate-limit-time-marker"
            aria-hidden="true"
            className="absolute inset-y-0 w-px -translate-x-1/2 bg-fg/70"
            style={{ left: `${markerPercentage}%` }}
          >
            {/* Caret cap riding on the top edge of the tick, so the marker reads
                as a deliberate playhead anchored to the bar rather than a bare
                line. It extends upward only; the tick itself stays inside the
                track height. */}
            <span
              aria-hidden="true"
              className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1 bg-fg/70"
              style={{ clipPath: 'polygon(50% 100%, 0 0, 100% 0)' }}
            />
          </span>
        )}
      </span>
      <span className="flex-shrink-0">{roundedUsedPercentage}%</span>
    </span>
  );
}

/**
 * The rate-limits tip's body: one block per window, its name and share, and
 * when it resets under them. It renders when the tip opens, so each reset is
 * read then rather than at the bar's last render.
 */
function RateLimitBlocks({ rateLimits }: { rateLimits: RateLimitWindow[] }) {
  return (
    <div className="flex min-w-[196px] flex-col gap-2.5" data-testid="rate-limits-tip-windows">
      {rateLimits.map((limitWindow) => {
        const Icon = RATE_LIMIT_ICON[limitWindow.iconKind];
        return (
          <div key={limitWindow.id} className="flex flex-col gap-0.5" data-testid="rate-limits-tip-window">
            <div className="flex items-center gap-1.5">
              <Icon size={12} className="shrink-0 text-tooltip-rich-muted" aria-hidden="true" />
              <span className="whitespace-nowrap font-semibold">{limitWindow.label}</span>
              <span className="ml-auto pl-7 tabular-nums text-fg-secondary">{Math.round(limitWindow.usedPercentage)}%</span>
            </div>
            <span className="whitespace-nowrap pl-[18px] text-tooltip-rich-muted">{formatResetTime(limitWindow.resetsAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The rate-limits tip's footer: how long ago the snapshot arrived, read when the tip opens. */
function RateLimitsUpdated({ capturedAt }: { capturedAt: number }) {
  const timeAgo = formatTimeAgo(capturedAt);
  return <span data-testid="rate-limits-tip-updated"><Trans>Updated {timeAgo}</Trans></span>;
}

interface RateLimitsPillProps {
  /** The shared snapshot's windows, as merged by the session store. */
  rateLimits: RateLimitWindow[];
  /** When the snapshot arrived (epoch ms), for the tip's "Updated" footer. */
  capturedAt: number;
  /** The session this ContextBar reports for, the pulse's context identity. */
  sessionId: string;
  /**
   * The pill in the bar's row: a meter that shares the row's room and folds
   * with it. Left out, the pill is the +N list's copy: a fixed width, no pulse.
   */
  rowFold?: { className: string; attributes: ContextBarFoldAttributes };
}

/**
 * The rate-limits pill: one bar per window that is still open, with the rich
 * tip. Renders nothing once every window has lapsed.
 *
 * It owns the 30s tick that advances each bar's time marker and expires a
 * window whose `resetsAt` passes while it is on screen (the store's merge drops
 * lapsed windows only when a report arrives). Isolated as a leaf so that
 * periodic re-render touches only this pill, not the whole ContextBar (model
 * picker, context bar, rate-limit math). Same rationale as ElapsedTime. A 30s
 * tick is ample: the 5h marker moves ~0.0056%/s, imperceptible per second, and a
 * lapsed window can linger at most one tick, reading "Resets now". The interval
 * is component-local and cleared on unmount, so it needs no HMR Pattern A
 * preservation (see .claude/rules/hmr-patterns.md).
 */
function RateLimitsPill({ rateLimits: reportedWindows, capturedAt, sessionId, rowFold }: RateLimitsPillProps) {
  const { t } = useLingui();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(intervalId);
  }, []);

  const rateLimits = rateLimitWindowsShortestFirst(liveRateLimitWindows(reportedWindows, now));
  const rateLimitsKey = rateLimits
    .map((limitWindow) => `${limitWindow.id}:${Math.round(limitWindow.usedPercentage)}`)
    .join('|');
  // Rebaselines on `sessionId`: switching the bar to another session is not a
  // live tick and must not animate (.claude/rules/restore-no-animation-replay.md).
  const rateLimitsRef = useValuePulse(rateLimitsKey, { resetKey: sessionId });

  if (rateLimits.length === 0) {
    return null;
  }

  // What a screen reader hears: each window's share and reset. The tip draws the same.
  const spoken = rateLimits
    .map((limitWindow) => `${limitWindow.label} ${Math.round(limitWindow.usedPercentage)}%. ${formatResetTime(limitWindow.resetsAt)}`)
    .join('. ');
  return (
    <Tooltip
      label={spoken}
      header={{ icon: <Gauge />, title: t`Rate limits` }}
      content={<RateLimitBlocks rateLimits={rateLimits} />}
      footer={<RateLimitsUpdated capturedAt={capturedAt} />}
      testId="rate-limits-tip"
    >
      <span
        ref={rowFold ? rateLimitsRef : undefined}
        className={rowFold
          ? `${pill} text-fg-muted tabular-nums flex items-center gap-2 flex-1 basis-0${rowFold.className}`
          : `${pill} text-fg-muted tabular-nums flex w-[220px] items-center gap-2`}
        data-testid={rowFold ? 'rate-limits-pill' : undefined}
        data-meter={rowFold ? '' : undefined}
        {...rowFold?.attributes}
      >
        {rateLimits.map((limitWindow) => (
          <RateLimitBar key={limitWindow.id} limitWindow={limitWindow} now={now} />
        ))}
      </span>
    </Tooltip>
  );
}

/**
 * Visual context window usage bar displayed below terminal areas. Same
 * content in both surfaces (task detail dialog and bottom panel) -
 * per-cell visibility is controlled by `contextBar.show*` settings, except
 * model/effort which are permanent (they double as the in-place picker
 * triggers, so a hide toggle would silently disable a feature).
 *
 * A fraction pill (e.g. "28k / 200k") shows absolute context usage.
 * Tooltip on the progress bar shows cache vs conversation breakdown.
 */
export function ContextBar({ sessionId, agentFallback = null }: ContextBarProps) {
  const { t } = useLingui();
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);
  const latestRateLimits = useSessionStore((s) => s.latestRateLimits);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const sessionShell = session?.shell;
  const isResuming = session?.resuming ?? false;
  const injectTransientSettings = useSessionStore((s) => s.injectTransientSettings);
  // Resolve via the session's own taskId, not the task's forward session_id: a
  // model/effort restart (column edit or manual override) respawns the session
  // and updates the DB row, but the board store's task.session_id goes stale
  // until the next reload. session.taskId stays correct across the restart.
  // Transient command-terminal sessions carry a synthetic uuid taskId that
  // matches no tasks row, so they still fall through to the transient/static
  // branches below.
  const task = useBoardStore((s) => s.tasks.find((t) => t.id === session?.taskId));
  const taskAgent = task?.agent ?? agentFallback;
  // The agent's own list entry - not agentDisplayName's separate hardcoded map - so the
  // version pill can never name one agent while showing another's version number.
  const taskAgentDisplayName = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.displayName
  );
  const taskAgentVersion = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.version
  );
  const contextBarConfig = useConfigStore((s) => s.config.contextBar);
  // Adapter-declared affordance for agents whose CLI exposes no live-telemetry
  // channel. Label and tooltip live with the adapter (see AgentAdapter.liveTelemetryUnsupported);
  // this component never branches on agent name.
  const agentLiveTelemetryUnsupported = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.liveTelemetryUnsupported
  );
  // Adapter-declared: this agent streams account-wide rate-limit windows. Gating
  // the rate-limit pill on the CAPABILITY (not this session's own first report)
  // means a freshly spawned terminal shows the shared global snapshot immediately,
  // matching its siblings, while agents with no rate-limit telemetry never show it.
  const agentReportsRateLimits = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.reportsRateLimits ?? false
  );

  // Pulse hooks - always called unconditionally (hooks rules). Every pulse
  // rebaselines on `sessionId`: switching the bar to a different session (a
  // project/task switch swaps it) flips all these metrics to another context's
  // numbers, which is not a live tick and must not animate
  // (.claude/rules/restore-no-animation-replay.md).
  const costRef = useValuePulse(usage?.cost.totalCostUsd, { resetKey: sessionId });
  const toolCallRef = useValuePulse(usage?.toolCallCount, { resetKey: sessionId });
  const inputTokens = usage?.contextWindow.totalInputTokens;
  const outputTokens = usage?.contextWindow.totalOutputTokens;
  const tokenKey = `${inputTokens}-${outputTokens}`;
  const tokenRef = useValuePulse(tokenKey, { resetKey: sessionId });
  // Pulse on the CLAMPED display percent, not the raw usedPercentage: an
  // over-budget window paints a fixed "100%" while the raw value keeps climbing
  // (105 -> 110 ...), and pulsing on the raw value would flash the pill on every
  // status update even though the visible text never changes.
  const pctRef = useValuePulse(
    usage
      ? contextWindowDisplayPercent(
          usage.contextWindow.contextWindowSize,
          usage.contextWindow.usedTokens ?? 0,
          usage.contextWindow.usedPercentage,
        )
      : 0,
    { resetKey: sessionId },
  );
  const fractionRef = useValuePulse(usage?.contextWindow.usedTokens, { resetKey: sessionId });

  // Tool-call breakdown popover. This pill lives directly in ContextBar, so it
  // owns its own open state (unlike the model/effort popovers, which live in the
  // child ModelEffortPicker).
  const [openToolBreakdown, setOpenToolBreakdown] = useState(false);
  const toolCallTriggerRef = useRef<HTMLButtonElement>(null);
  // The +N pill, which the breakdown opens above when tool calls is folded into its list.
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const [toolBreakdownFromOverflow, setToolBreakdownFromOverflow] = useState(false);

  // Model is "resolved" only when the CLI status line has reported a real
  // displayName. Until then we show a single spinner pill instead of flashing
  // through "Agent" -> "Claude" -> "Opus 4.6 (1M Context)" as data trickles in.
  const resolvedModelName = usage?.model.displayName || null;

  // One row: what does not fit folds into the +N list, held while the list is open.
  const barRef = useRef<HTMLDivElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const folded = useContextBarFold(barRef, { active: !!usage && !!resolvedModelName, frozen: overflowOpen });

  if (!usage || !resolvedModelName) {
    // Adapter-declared "no live telemetry" branch. The spinner would otherwise
    // display forever for these agents - show the adapter's static affordance
    // instead. Branching on a generic capability flag (not agent name) keeps
    // agent-specific copy inside src/main/agent/adapters/<agent>/.
    if (agentLiveTelemetryUnsupported) {
      return (
        <div
          className={containerClass}
          data-testid="usage-bar"
          data-live-telemetry="unsupported"
          data-no-dismiss
        >
          <Tooltip label={agentLiveTelemetryUnsupported.unavailableTitle}>
            <span className={`${pill} text-fg-muted`}>
              {agentLiveTelemetryUnsupported.unavailableLabel}
            </span>
          </Tooltip>
        </div>
      );
    }
    const spinnerLabel = isResuming ? t`Resuming agent...` : t`Starting agent...`;
    return (
      <div
        className={containerClass}
        data-testid="usage-bar"
        data-no-dismiss
      >
        <span className={`${pill} text-fg-muted flex items-center gap-1.5`}>
          <Loader2 size={12} className="animate-spin" />
          {spinnerLabel}
        </span>
      </div>
    );
  }

  const modelName = resolvedModelName;

  // Transient (command-terminal) sessions have no task row, so the task-keyed
  // picker branch below never fires for them. When the project agent is known
  // we render the picker in session-inject mode instead: selecting a value
  // best-effort injects the adapter's `/model` / `/effort` slash command into
  // the live PTY (no DB persistence - transient sessions are not resumable).
  // Capture the live values here (where `usage` is narrowed non-undefined) so
  // the inject closure does not depend on closure narrowing of `usage`.
  const liveModelId = usage.model.id;
  const liveEffort = usage.model.effort || null;
  // Whether a real telemetry snapshot has arrived, as opposed to the spawn-time
  // seed that fills in the model name from the `--model` flag before the agent
  // has said anything. Without this the model pill reads as confirmed from the
  // moment the session starts.
  const telemetryLanded = usage.model.reportedByAgent === true;
  const isTransientSession = session?.transient === true;
  const transientAgent = !task && isTransientSession ? taskAgent : null;
  const handleTransientInject = (patch: { model?: string | null; effort?: string | null }) => {
    if (transientAgent == null) return;
    injectTransientSettings({
      sessionId,
      agent: transientAgent,
      ...patch,
      currentModel: liveModelId,
      currentEffort: liveEffort,
    });
  };

  // Fallback to 0 for fields that may be absent from older main-process sessions
  const usedTokens = usage.contextWindow.usedTokens ?? 0;
  const cacheTokens = usage.contextWindow.cacheTokens ?? 0;
  const { contextWindowSize } = usage.contextWindow;

  // Render the context fraction/bar/percent whenever the window is KNOWN (a
  // positive size - 0 is the "unknown size" sentinel before any window has
  // been learned for this session's model). `pct` is the shared clamped
  // display percentage: an over-budget pairing (usedTokens > window) is a
  // legitimate critical state on this authoritative status.json snapshot, not a
  // broken denominator, so contextWindowDisplayPercent forces a full 100%
  // critical bar rather than hiding it - a near-full/auto-compacting session
  // still shows a full bar instead of vanishing.
  const windowKnown = isContextWindowKnown(contextWindowSize);
  const pct = contextWindowDisplayPercent(contextWindowSize, usedTokens, usage.contextWindow.usedPercentage);
  const progressColor = getProgressColor(pct);

  const cachedTokenText = formatTokenCount(cacheTokens);
  const conversationTokenText = formatTokenCount(Math.max(0, usedTokens - cacheTokens));
  const barTooltip = t`${cachedTokenText} cached (system) \u00b7 ${conversationTokenText} conversation`;

  // Determine which elements are visible. The settings toggles are the
  // single source of truth for both the task-detail and bottom-panel
  // surfaces - we no longer suppress fields based on `compact`. Users who
  // want a leaner bottom panel can flip the toggles off; users who enable
  // them get the same info in both places (feature parity).
  const showShell = !!sessionShell && contextBarConfig.showShell;
  const showVersion = contextBarConfig.showVersion;
  const showElapsed = contextBarConfig.showElapsed;
  const showToolCalls = contextBarConfig.showToolCalls;
  const showAgentActive = contextBarConfig.showAgentActive;
  // Model + Effort are always shown when usage is present - they double as
  // the in-place model/effort picker triggers, so a "hide" toggle would
  // silently disable a feature, not just declutter chrome.
  const showCost = contextBarConfig.showCost;
  const showTokens = contextBarConfig.showTokens;
  const showFraction = contextBarConfig.showContextFraction;
  const showProgressBar = contextBarConfig.showProgressBar;
  // Visibility gate is the AGENT CAPABILITY, not this session's own first report:
  // any session of a rate-limit-reporting agent (e.g. Claude) earns the pill, so a
  // freshly spawned terminal shows the shared account-wide numbers from the global
  // `latestRateLimits` snapshot immediately instead of a blank gap until it reports
  // its own. When no session anywhere has reported yet (`latestRateLimits` null) the
  // pill stays hidden. Agents with no rate-limit telemetry never show it.
  const showRateLimits = agentReportsRateLimits
    && !!latestRateLimits && latestRateLimits.rateLimits.length > 0
    && contextBarConfig.showRateLimits;
  const taskAgentVersionNumber = parseAgentVersion(taskAgentVersion);
  // Raw, as the pill and its name have always printed it.
  const toolCallCountText = String(usage.toolCallCount ?? 0);

  // No empty-state early-return: model pill is permanent (it doubles as
  // the picker trigger), so the bar always has at least one cell of content
  // by the time we reach this point.

  // A folded pill stays mounted, out of the row and out of sight: its width is
  // still its own, and its pulses and refs keep working (`useContextBarFold`).
  const foldAttributes = (id: ContextBarFoldId): ContextBarFoldAttributes => (folded.has(id)
    ? { 'data-fold-id': id, 'data-folded': '', 'aria-hidden': true, inert: true }
    : { 'data-fold-id': id });
  const foldClass = (id: ContextBarFoldId): string => (folded.has(id) ? ' absolute invisible pointer-events-none' : '');
  const agentLabel = taskAgentDisplayName ?? agentDisplayName(taskAgent);
  const fractionLabel = windowKnown ? `${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindowSize)}` : '';
  const remainingPercent = 100 - pct;
  const openToolBreakdownFrom = (fromOverflow: boolean): void => {
    setToolBreakdownFromOverflow(fromOverflow);
    setOpenToolBreakdown((previous) => !previous || fromOverflow !== toolBreakdownFromOverflow);
  };

  // What the +N list shows: copies of the folded pills, with their tips but no pulses.
  const overflowCopies: Partial<Record<ContextBarFoldId, React.ReactNode>> = {
    shell: showShell && (
      <Tooltip label={sessionShell as string}>
        <span className={`${pill} text-fg-faint`}>{shellDisplayName(sessionShell as string)}</span>
      </Tooltip>
    ),
    // The version, or the agent's name with it once that folds too, under the floor.
    version: showVersion && (
      <span className={`${pill} text-fg-muted`}>
        {agentLabel}
        {taskAgentVersionNumber && <span className="text-fg-faint ml-1.5"><Trans>v{taskAgentVersionNumber}</Trans></span>}
      </span>
    ),
    'rate-limits': showRateLimits && latestRateLimits && (
      <RateLimitsPill
        rateLimits={latestRateLimits.rateLimits}
        capturedAt={latestRateLimits.capturedAt}
        sessionId={sessionId}
      />
    ),
    // The context under the floor, its counts with it.
    context: windowKnown && (showProgressBar || showFraction) && (
      <Tooltip label={barTooltip}>
        <span className={`${pill} text-fg-muted tabular-nums flex w-[220px] items-center gap-2`}>
          {showFraction && <span className="text-fg-faint whitespace-nowrap">{fractionLabel}</span>}
          {showProgressBar && (
            <span className="flex-1 h-1.5 bg-surface-hover rounded-full overflow-hidden">
              <span
                className="block h-full w-full origin-left rounded-full"
                style={{ transform: `scaleX(${Math.min(pct, 100) / 100})`, backgroundColor: progressColor }}
              />
            </span>
          )}
          {showProgressBar && <span className="text-fg-faint whitespace-nowrap">{pct}%</span>}
        </span>
      </Tooltip>
    ),
    'agent-active': showAgentActive && usage.cost.totalDurationMs > 0 && (
      <Tooltip label={t`Agent active time`}>
        <span className={`${pill} text-fg-muted tabular-nums flex items-center gap-1`}>
          <Hourglass size={11} className="text-fg-faint" />
          {formatDuration(usage.cost.totalDurationMs)}
        </span>
      </Tooltip>
    ),
    elapsed: showElapsed && session?.startedAt && (
      <Tooltip label={t`Elapsed session time`}>
        <span className={`${pill} text-fg-muted tabular-nums flex items-center gap-1`}>
          <Clock size={11} className="text-fg-faint" />
          <ElapsedTime startedAt={session.startedAt} />
        </span>
      </Tooltip>
    ),
    tokens: showTokens && (
      <Tooltip label={t`Input / output tokens`}>
        <span className={`${pill} text-fg-muted tabular-nums flex items-center gap-3`}>
          <span className="flex items-center gap-1">
            <ArrowUp size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalInputTokens)}
          </span>
          <span className="flex items-center gap-1">
            <ArrowDown size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalOutputTokens)}
          </span>
        </span>
      </Tooltip>
    ),
    'tool-calls': showToolCalls && (
      <Tooltip label={t`Tool calls across every run of this session`}>
        <button
          type="button"
          onClick={() => {
            setOverflowOpen(false);
            openToolBreakdownFrom(true);
          }}
          className={`${pill} text-fg-muted tabular-nums inline-flex items-center gap-1 cursor-pointer hover:bg-surface-hover`}
          aria-label={t`Tool calls: ${toolCallCountText}`}
          data-testid="context-bar-tool-calls-overflow"
        >
          <Wrench size={11} className="text-fg-faint" />
          <span>{usage.toolCallCount ?? 0}</span>
          <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
        </button>
      </Tooltip>
    ),
    cost: showCost && (
      <Tooltip label={t`Session API cost`}>
        <span className={`${pill} text-fg-muted tabular-nums`}>{formatCost(usage.cost.totalCostUsd)}</span>
      </Tooltip>
    ),
    'context-fraction': windowKnown && showFraction && (
      <Tooltip label={t`Context tokens used / total window size`}>
        <span className={`${pill} text-fg-muted tabular-nums`}>{fractionLabel}</span>
      </Tooltip>
    ),
  };
  const overflowItems: ContextBarOverflowItem[] = [];
  for (const id of OVERFLOW_LIST_ORDER) {
    const isFolded = id === 'version'
      ? folded.has('version') || folded.has('agent')
      // A folded context lists its counts with it.
      : id === 'context-fraction' ? folded.has(id) && !folded.has('context') : folded.has(id);
    const node = overflowCopies[id];
    if (isFolded && node) overflowItems.push({ id, node });
  }

  return (
    <div
      ref={barRef}
      className={containerClass}
      data-testid="usage-bar"
      data-no-dismiss
    >
      {/* First in the row: the profile determines the agent/model/effort to its
          right. Task-scoped only - the transient Command Terminal variant below
          has no task, so there is no profile to pick. */}
      {task && <ProfilePicker taskId={task.id} />}
      {showShell && (
        <Tooltip label={sessionShell as string}>
          <span className={`${pill} text-fg-faint${foldClass('shell')}`} {...foldAttributes('shell')}>
            {shellDisplayName(sessionShell as string)}
          </span>
        </Tooltip>
      )}
      {showVersion && (
        <span className={`${pill} text-fg-muted${foldClass('agent')}`} {...foldAttributes('agent')}>
          {agentLabel}
          {taskAgentVersionNumber && (
            <span className={`text-fg-faint ml-1.5${foldClass('version')}`} {...foldAttributes('version')}>
              <Trans>v{taskAgentVersionNumber}</Trans>
            </span>
          )}
        </span>
      )}
      {task ? (
        <ModelEffortPicker
          target={{ kind: 'task', taskId: task.id }}
          agent={taskAgent}
          liveModelName={modelName}
          liveModelId={liveModelId}
          /* `||` (not `??`) so an empty-string effort coerces to null and the
             picker falls through to task/swimlane overrides. The CLI never
             emits "" today, but matches the original ContextBar semantics. */
          liveEffort={liveEffort}
          telemetryLanded={telemetryLanded}
          mode="live"
        />
      ) : transientAgent ? (
        <ModelEffortPicker
          target={{ kind: 'session', sessionId, onInject: handleTransientInject }}
          agent={transientAgent}
          liveModelName={modelName}
          liveModelId={liveModelId}
          liveEffort={liveEffort}
          telemetryLanded={telemetryLanded}
          mode="live"
        />
      ) : (
        /* No task row and no known transient agent: no picker, but the same two
           values, so they declare provenance the same way. Effort here is read
           straight off the snapshot, hence always live when present; the model
           name can still be the spawn-time seed. */
        <>
          <span
            className={`${pillForProvenance(telemetryLanded)} text-fg-muted`}
            data-model-source={telemetryLanded ? 'live' : 'configured'}
          >
            {modelName}
          </span>
          {usage.model.effort && (
            <span className={`${pill} text-fg-faint`} data-effort-source="live">
              {usage.model.effort}
            </span>
          )}
        </>
      )}
      {showRateLimits && latestRateLimits && (
        <RateLimitsPill
          rateLimits={latestRateLimits.rateLimits}
          capturedAt={latestRateLimits.capturedAt}
          sessionId={sessionId}
          rowFold={{ className: foldClass('rate-limits'), attributes: foldAttributes('rate-limits') }}
        />
      )}
      {showCost && (
        <Tooltip label={t`Session API cost`}>
          <span ref={costRef} className={`${pill} text-fg-muted tabular-nums${foldClass('cost')}`} {...foldAttributes('cost')}>
            {formatCost(usage.cost.totalCostUsd)}
          </span>
        </Tooltip>
      )}

      {/* Activity stats sit directly to the left of the token counts. Tool
          calls is the cumulative count main stamps onto the usage payload:
          this run's calls plus the session's earlier runs, since every resume
          is a new run (the renderer's own event cache is bounded, so it could
          not count past 500 events itself either). */}
      {showToolCalls && (
        <span
          className={`inline-flex${folded.has('tool-calls') ? foldClass('tool-calls') : ' relative'}`}
          {...foldAttributes('tool-calls')}
        >
          <Tooltip label={t`Tool calls across every run of this session`} enabled={!openToolBreakdown}>
            <button
              ref={toolCallTriggerRef}
              type="button"
              onClick={() => openToolBreakdownFrom(false)}
              className={`${pill} text-fg-muted tabular-nums inline-flex items-center gap-1 cursor-pointer hover:bg-surface-hover`}
              aria-label={t`Tool calls: ${toolCallCountText}`}
              aria-expanded={openToolBreakdown}
              data-testid="context-bar-tool-calls-trigger"
            >
              <Wrench size={11} className="text-fg-faint" />
              <span ref={toolCallRef}>{usage.toolCallCount ?? 0}</span>
              <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
            </button>
          </Tooltip>
          {openToolBreakdown && (
            <ToolBreakdownPopover
              // Opened from the +N list, it sits above the +N pill: the trigger in the row is out of sight.
              triggerRef={toolBreakdownFromOverflow ? overflowButtonRef : toolCallTriggerRef}
              sessionId={sessionId}
              refreshSignal={usage.toolCallCount ?? 0}
              onClose={() => setOpenToolBreakdown(false)}
              testId="context-bar-tool-breakdown-popover"
            />
          )}
        </span>
      )}

      {showAgentActive && usage.cost.totalDurationMs > 0 && (
        <Tooltip label={t`Agent active time`}>
          <span
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-1${foldClass('agent-active')}`}
            data-testid="context-agent-active"
            {...foldAttributes('agent-active')}
          >
            <Hourglass size={11} className="text-fg-faint" />
            {formatDuration(usage.cost.totalDurationMs)}
          </span>
        </Tooltip>
      )}

      {showTokens && (
        <Tooltip label={t`Input / output tokens`}>
          <span
            ref={tokenRef}
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-3${foldClass('tokens')}`}
            {...foldAttributes('tokens')}
          >
            <span className="flex items-center gap-1">
              <ArrowUp size={11} className="text-fg-faint" />
              {formatTokenCount(usage.contextWindow.totalInputTokens)}
            </span>
            <span className="flex items-center gap-1">
              <ArrowDown size={11} className="text-fg-faint" />
              {formatTokenCount(usage.contextWindow.totalOutputTokens)}
            </span>
          </span>
        </Tooltip>
      )}

      {/* Context usage: the absolute fraction (used / total) sits to the LEFT of
          the bar inside one pill; the bar grows to fill, the percent trails it.
          When only the fraction is enabled (bar off), it renders as a minimal
          pill so the toggle stays meaningful. */}
      {(() => {
        // No bar/fraction/percent when the window is unknown (size 0, no
        // denominator to draw a bar against): show the model name only. An
        // over-budget window (usedTokens > size) still renders below, clamped
        // to a full 100% critical bar rather than hidden. The hidden sentinel
        // keeps the state queryable for tests without adding a visible element.
        if (!windowKnown) {
          return <span data-context-window="unknown" className="hidden" />;
        }
        // `fractionLabel` is shared, so the bar-embedded fraction and the
        // bare-fraction pill render the identical "used / total" string. In the
        // bar the counts fold on their own before the context itself does.
        if (showProgressBar) {
          return (
            <div
              className={`${pill} text-fg-muted flex items-center gap-2 flex-1 basis-0${foldClass('context')}`}
              data-meter=""
              {...foldAttributes('context')}
            >
              {showFraction && (
                <Tooltip label={t`Context tokens used / total window size`}>
                  <span
                    ref={fractionRef}
                    className={`tabular-nums text-fg-faint whitespace-nowrap${foldClass('context-fraction')}`}
                    {...foldAttributes('context-fraction')}
                  >
                    {fractionLabel}
                  </span>
                </Tooltip>
              )}
              {/* Scaled on X rather than width-animated: `transform` is composited,
                  `width` costs layout and paint on every frame of the 300ms. Keep
                  `transform` in the transition list - naming `width` here would
                  leave the bar drawing at the right size but never animating, and
                  no test asserts motion. See ContextUsageFooter.tsx, which carries
                  the same treatment for the board and monitor cards. */}
              <Tooltip label={barTooltip}>
                <div className="flex-1 min-w-[40px] h-1.5 bg-surface-hover rounded-full overflow-hidden" data-meter-track="">
                  <div
                    className="h-full w-full origin-left rounded-full transition-[transform,background-color] duration-300"
                    data-percent={Math.min(pct, 100)}
                    style={{ transform: `scaleX(${Math.min(pct, 100) / 100})`, backgroundColor: progressColor }}
                  />
                </div>
              </Tooltip>
              <Tooltip label={t`${remainingPercent}% remaining`}>
                <span ref={pctRef} className="tabular-nums text-fg-faint whitespace-nowrap transition-colors duration-300">{showFraction ? `${pct}%` : t`${pct}% context`}</span>
              </Tooltip>
            </div>
          );
        }
        if (showFraction) {
          return (
            <Tooltip label={t`Context tokens used / total window size`}>
              <span
                ref={fractionRef}
                className={`${pill} text-fg-muted tabular-nums${foldClass('context')}`}
                {...foldAttributes('context')}
              >
                {fractionLabel}
              </span>
            </Tooltip>
          );
        }
        return null;
      })()}

      {/* Elapsed wall-clock sits at the far right (after the progress bar), with
          auto width. Placed last, its per-second growth is absorbed by the
          flex-1 progress pill to its left and never reflows the other cells, so
          no fixed-width reservation is needed. */}
      {showElapsed && session?.startedAt && (
        <Tooltip label={t`Elapsed session time`}>
          <span
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-1${foldClass('elapsed')}`}
            data-testid="context-elapsed"
            {...foldAttributes('elapsed')}
          >
            <Clock size={11} className="text-fg-faint" />
            <ElapsedTime startedAt={session.startedAt} />
          </span>
        </Tooltip>
      )}

      <ContextBarOverflow
        buttonRef={overflowButtonRef}
        items={overflowItems}
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
      />
    </div>
  );
}
