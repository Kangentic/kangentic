import { useState, useRef, useEffect } from 'react';
import { ArrowUp, ArrowDown, Loader2, Clock, Calendar, Wrench, Hourglass, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { RateLimitWindow } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/color-lerp';
import { windowElapsedPercentage } from '../../utils/rate-limit-window';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatDateTime, formatTime } from '../../lib/datetime';
import { agentDisplayName } from '../../utils/agent-display-name';
import { shellDisplayName } from '../../utils/shell-display-name';
import { useValuePulse } from '../../hooks/useValuePulse';
import { ModelEffortPicker } from './ModelEffortPicker';
import { ElapsedTime } from './ElapsedTime';
import { ToolBreakdownPopover } from './ToolBreakdownPopover';

interface ContextBarProps {
  sessionId: string;
  /** Fallback agent identifier when the session has no task row (e.g. transient command-terminal sessions). */
  agentFallback?: string | null;
}

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';
const containerClass = 'min-h-8 bg-surface/80 border-t border-edge flex flex-wrap items-center px-3 py-1.5 gap-x-2 gap-y-2 text-xs flex-shrink-0';

function formatResetTime(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'Resets now';
  if (ms < 24 * 60 * 60 * 1000) return `Resets in ${formatDuration(ms)}`;
  return `Resets ${formatDateTime(epochSeconds * 1000)}`;
}

// Maps adapter-declared RateLimitWindow.iconKind to a Lucide icon. The visual
// vocabulary lives here in the renderer so adapters declare semantics, not chrome.
const RATE_LIMIT_ICON: Record<RateLimitWindow['iconKind'], LucideIcon> = {
  session: Clock,
  period: Calendar,
};

/**
 * One rate-limit window row: icon + usage track + percent. The colored fill is
 * driven by `usedPercentage` (budget spent); the thin vertical line overlaid on
 * the track marks how far through the time window we are (elapsed time, not
 * budget), creeping right as the reset time draws nearer.
 *
 * Isolated as a leaf with its own interval so the periodic re-render that advances
 * the time marker touches only this row, not the whole ContextBar (model picker,
 * context bar, rate-limit math). Same rationale as ElapsedTime. A 30s tick is
 * ample: the 5h marker moves ~0.0056%/s, imperceptible per second. The interval
 * is component-local and cleared on unmount, so it needs no HMR Pattern A
 * preservation (see .claude/rules/hmr-patterns.md).
 */
function RateLimitBar({ limitWindow }: { limitWindow: RateLimitWindow }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(intervalId);
  }, []);

  const Icon = RATE_LIMIT_ICON[limitWindow.iconKind];
  const pctRow = Math.round(limitWindow.usedPercentage);
  // windowDurationSeconds is optional: a window with no fixed duration draws no
  // time marker, so only compute the position when the adapter supplied one.
  const markerPct = limitWindow.windowDurationSeconds === undefined
    ? null
    : windowElapsedPercentage(limitWindow.resetsAt, limitWindow.windowDurationSeconds, now);

  return (
    <span className="flex items-center gap-1.5 flex-1 min-w-0">
      <Icon size={11} className="text-fg-faint flex-shrink-0" aria-label={limitWindow.label} />
      {/* No overflow-hidden: the marker line below extends a couple px past the
          track so it stays visible where it overlaps the fill. The fill keeps
          its own rounded-full, so the track still reads as a pill. */}
      <span className="relative flex-1 min-w-[40px] h-1.5 bg-surface-hover rounded-full">
        <span
          className="block h-full rounded-full transition-[width,background-color] duration-300"
          style={{
            width: `${Math.min(pctRow, 100)}%`,
            minWidth: pctRow > 0 ? '2px' : undefined,
            backgroundColor: getProgressColor(pctRow),
          }}
        />
        {markerPct !== null && (
          <span
            data-testid="rate-limit-time-marker"
            aria-hidden="true"
            className="absolute -inset-y-0.5 w-px bg-fg/70"
            style={{ left: `${markerPct}%` }}
            title={formatResetTime(limitWindow.resetsAt)}
          />
        )}
      </span>
      <span className="flex-shrink-0">{pctRow}%</span>
    </span>
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
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);
  const latestRateLimits = useSessionStore((s) => s.latestRateLimits);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const sessionShell = session?.shell;
  const isResuming = session?.resuming ?? false;
  const injectTransientSettings = useSessionStore((s) => s.injectTransientSettings);
  const task = useBoardStore((s) => s.tasks.find((t) => t.session_id === sessionId));
  const taskAgent = task?.agent ?? agentFallback;
  // Resolve the agent that contributed the latest rate-limit snapshot so the
  // tooltip can name it. Falls back to undefined when the source session has
  // no task row (e.g. transient command-terminal sessions).
  const sourceAgent = useBoardStore((s) =>
    latestRateLimits ? s.tasks.find((t) => t.session_id === latestRateLimits.sourceSessionId)?.agent : undefined,
  );
  const agentVersionNumber = useConfigStore((s) => s.agentVersionNumber);
  const contextBarConfig = useConfigStore((s) => s.config.contextBar);
  // Adapter-declared affordance for agents whose CLI exposes no live-telemetry
  // channel. Label and tooltip live with the adapter (see AgentAdapter.liveTelemetryUnsupported);
  // this component never branches on agent name.
  const agentLiveTelemetryUnsupported = useConfigStore(
    (s) => s.agentList.find((a) => a.name === taskAgent)?.liveTelemetryUnsupported
  );

  // Pulse hooks -- always called unconditionally (hooks rules)
  const costRef = useValuePulse(usage?.cost.totalCostUsd);
  const toolCallRef = useValuePulse(usage?.toolCallCount);
  const inputTokens = usage?.contextWindow.totalInputTokens;
  const outputTokens = usage?.contextWindow.totalOutputTokens;
  const tokenKey = `${inputTokens}-${outputTokens}`;
  const tokenRef = useValuePulse(tokenKey);
  const pctRef = useValuePulse(usage ? Math.round(usage.contextWindow.usedPercentage) : 0);
  const fractionRef = useValuePulse(usage?.contextWindow.usedTokens);
  const rateLimitsKey = latestRateLimits
    ? latestRateLimits.rateLimits.map((limitWindow) => `${limitWindow.id}:${Math.round(limitWindow.usedPercentage)}`).join('|')
    : '';
  const rateLimitsRef = useValuePulse(rateLimitsKey);

  // Tool-call breakdown popover. This pill lives directly in ContextBar, so it
  // owns its own open state (unlike the model/effort popovers, which live in the
  // child ModelEffortPicker).
  const [openToolBreakdown, setOpenToolBreakdown] = useState(false);
  const toolCallTriggerRef = useRef<HTMLButtonElement>(null);

  // Model is "resolved" only when the CLI status line has reported a real
  // displayName. Until then we show a single spinner pill instead of flashing
  // through "Agent" -> "Claude" -> "Opus 4.6 (1M Context)" as data trickles in.
  const resolvedModelName = usage?.model.displayName || null;

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
        >
          <span
            className={`${pill} text-fg-muted`}
            title={agentLiveTelemetryUnsupported.unavailableTitle}
          >
            {agentLiveTelemetryUnsupported.unavailableLabel}
          </span>
        </div>
      );
    }
    const spinnerLabel = isResuming ? 'Resuming agent...' : 'Starting agent...';
    return (
      <div
        className={containerClass}
        data-testid="usage-bar"
      >
        <span className={`${pill} text-fg-muted flex items-center gap-1.5`}>
          <Loader2 size={12} className="animate-spin" />
          {spinnerLabel}
        </span>
      </div>
    );
  }

  const pct = Math.round(usage.contextWindow.usedPercentage);
  const progressColor = getProgressColor(pct);

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

  const barTooltip = `${formatTokenCount(cacheTokens)} cached (system) \u00b7 ${formatTokenCount(Math.max(0, usedTokens - cacheTokens))} conversation`;

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
  // Visibility gate stays per-session: only adapters that ever populated
  // rateLimits (currently Claude) earn the pill. The displayed *value* comes
  // from the global `latestRateLimits` snapshot so every agent in the window
  // shows the freshest account-wide numbers, not its own stale ones.
  const showRateLimits = !!usage.rateLimits && usage.rateLimits.length > 0
    && !!latestRateLimits && latestRateLimits.rateLimits.length > 0
    && contextBarConfig.showRateLimits;

  // No empty-state early-return: model pill is permanent (it doubles as
  // the picker trigger), so the bar always has at least one cell of content
  // by the time we reach this point.

  return (
    <div
      className={containerClass}
      data-testid="usage-bar"
    >
      {showShell && (
        <span className={`${pill} text-fg-faint`} title={sessionShell as string}>
          {shellDisplayName(sessionShell as string)}
        </span>
      )}
      {showVersion && (
        <span className={`${pill} text-fg-muted`}>
          {agentDisplayName(taskAgent)}
          {agentVersionNumber && (
            <span className="text-fg-faint ml-1.5">v{agentVersionNumber}</span>
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
          mode="live"
        />
      ) : transientAgent ? (
        <ModelEffortPicker
          target={{ kind: 'session', sessionId, onInject: handleTransientInject }}
          agent={transientAgent}
          liveModelName={modelName}
          liveModelId={liveModelId}
          liveEffort={liveEffort}
          mode="live"
        />
      ) : (
        <>
          <span className={`${pill} text-fg-muted`}>{modelName}</span>
          {usage.model.effort && (
            <span className={`${pill} text-fg-faint`}>{usage.model.effort}</span>
          )}
        </>
      )}
      {showRateLimits && latestRateLimits && (() => {
        const rateLimits = latestRateLimits.rateLimits;
        const sourceLabel = sourceAgent ? ` via ${agentDisplayName(sourceAgent)}` : '';
        const updatedSuffix = `\nUpdated ${formatTime(latestRateLimits.capturedAt)}${sourceLabel}`;
        const tooltipBody = rateLimits
          .map((limitWindow) => `${limitWindow.label}: ${formatResetTime(limitWindow.resetsAt)}`)
          .join('\n');
        return (
          <span
            ref={rateLimitsRef}
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-2 flex-1 basis-0 min-w-[220px]`}
            title={`${tooltipBody}${updatedSuffix}`}
            data-testid="rate-limits-pill"
          >
            {rateLimits.map((limitWindow) => (
              <RateLimitBar key={limitWindow.id} limitWindow={limitWindow} />
            ))}
          </span>
        );
      })()}
      {showCost && <span ref={costRef} className={`${pill} text-fg-muted tabular-nums`} title="Session API cost">{formatCost(usage.cost.totalCostUsd)}</span>}

      {/* Activity stats sit directly to the left of the token counts. Tool
          calls is the live cumulative count stamped onto the usage payload
          (the renderer's own event cache is bounded, so it cannot count past
          500 events itself). */}
      {showToolCalls && (
        <span className="relative inline-flex">
          <button
            ref={toolCallTriggerRef}
            type="button"
            onClick={() => setOpenToolBreakdown((previous) => !previous)}
            className={`${pill} text-fg-muted tabular-nums inline-flex items-center gap-1 cursor-pointer hover:bg-surface-hover`}
            title="Tool calls this session - click for the per-tool breakdown"
            aria-expanded={openToolBreakdown}
            data-testid="context-bar-tool-calls-trigger"
          >
            <Wrench size={11} className="text-fg-faint" />
            <span ref={toolCallRef}>{usage.toolCallCount ?? 0}</span>
            <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
          </button>
          {openToolBreakdown && (
            <ToolBreakdownPopover
              triggerRef={toolCallTriggerRef}
              sessionId={sessionId}
              refreshSignal={usage.toolCallCount ?? 0}
              onClose={() => setOpenToolBreakdown(false)}
              testId="context-bar-tool-breakdown-popover"
            />
          )}
        </span>
      )}

      {showAgentActive && usage.cost.totalDurationMs > 0 && (
        <span
          className={`${pill} text-fg-muted tabular-nums flex items-center gap-1`}
          title="Agent active time"
          data-testid="context-agent-active"
        >
          <Hourglass size={11} className="text-fg-faint" />
          {formatDuration(usage.cost.totalDurationMs)}
        </span>
      )}

      {showTokens && (
        <span ref={tokenRef} className={`${pill} text-fg-muted tabular-nums flex items-center gap-3`} title="Input / output tokens">
          <span className="flex items-center gap-1">
            <ArrowUp size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalInputTokens)}
          </span>
          <span className="flex items-center gap-1">
            <ArrowDown size={11} className="text-fg-faint" />
            {formatTokenCount(usage.contextWindow.totalOutputTokens)}
          </span>
        </span>
      )}

      {/* Context usage: the absolute fraction (used / total) sits to the LEFT of
          the bar inside one pill; the bar grows to fill, the percent trails it.
          When only the fraction is enabled (bar off), it renders as a minimal
          pill so the toggle stays meaningful. */}
      {(() => {
        // Shared so the bar-embedded fraction and the bare-fraction pill render
        // the identical "used / total" string from one source.
        const fractionLabel = `${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindowSize)}`;
        if (showProgressBar) {
          return (
            <div className={`${pill} text-fg-muted flex items-center gap-2 flex-1 basis-0 min-w-[160px]`}>
              {showFraction && (
                <span ref={fractionRef} className="tabular-nums text-fg-faint whitespace-nowrap" title="Context tokens used / total window size">
                  {fractionLabel}
                </span>
              )}
              <div className="flex-1 h-1.5 bg-surface-hover rounded-full overflow-hidden" title={barTooltip}>
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-300"
                  style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
                />
              </div>
              <span ref={pctRef} className="tabular-nums text-fg-faint whitespace-nowrap transition-colors duration-300" title={`${100 - pct}% remaining`}>{pct}%{!showFraction && ' context'}</span>
            </div>
          );
        }
        if (showFraction) {
          return (
            <span ref={fractionRef} className={`${pill} text-fg-muted tabular-nums`} title="Context tokens used / total window size">
              {fractionLabel}
            </span>
          );
        }
        return null;
      })()}

      {/* Elapsed wall-clock sits at the far right (after the progress bar), with
          auto width. Placed last, its per-second growth is absorbed by the
          flex-1 progress pill to its left and never reflows the other cells, so
          no fixed-width reservation is needed. */}
      {showElapsed && session?.startedAt && (
        <span
          className={`${pill} text-fg-muted tabular-nums flex items-center gap-1`}
          title="Elapsed session time"
          data-testid="context-elapsed"
        >
          <Clock size={11} className="text-fg-faint" />
          <ElapsedTime startedAt={session.startedAt} />
        </span>
      )}
    </div>
  );
}
