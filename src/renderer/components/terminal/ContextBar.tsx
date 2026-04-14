import { ArrowUp, ArrowDown, Loader2, Clock, Calendar } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/color-lerp';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost, formatDuration } from '../../utils/format-session';
import { formatDateTime } from '../../lib/datetime';
import { agentDisplayName } from '../../utils/agent-display-name';
import { shellDisplayName } from '../../utils/shell-display-name';
import { useValuePulse } from '../../hooks/useValuePulse';

interface ContextBarProps {
  sessionId: string;
  compact?: boolean; // hide version label -- used in the bottom panel
}

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';

function formatResetTime(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'Resets now';
  if (ms < 24 * 60 * 60 * 1000) return `Resets in ${formatDuration(ms)}`;
  return `Resets ${formatDateTime(epochSeconds * 1000)}`;
}

/**
 * Visual context window usage bar displayed below terminal areas.
 * Full mode (task detail): version, model, progress bar, percentage, cost.
 * Compact mode (bottom panel): model, progress bar, percentage, cost.
 *
 * A fraction pill (e.g. "28k / 200k") shows absolute context usage.
 * Tooltip on the bar shows cache vs conversation breakdown.
 */
export function ContextBar({ sessionId, compact = false }: ContextBarProps) {
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const sessionShell = session?.shell;
  const isResuming = session?.resuming ?? false;
  const taskAgent = useBoardStore((s) => s.tasks.find((t) => t.session_id === sessionId)?.agent ?? null);
  const agentVersionNumber = useConfigStore((s) => s.agentVersionNumber);
  const contextBarConfig = useConfigStore((s) => s.config.contextBar);

  // Pulse hooks -- always called unconditionally (hooks rules)
  const costRef = useValuePulse(usage?.cost.totalCostUsd);
  const inputTokens = usage?.contextWindow.totalInputTokens;
  const outputTokens = usage?.contextWindow.totalOutputTokens;
  const tokenKey = `${inputTokens}-${outputTokens}`;
  const tokenRef = useValuePulse(tokenKey);
  const pctRef = useValuePulse(usage ? Math.round(usage.contextWindow.usedPercentage) : 0);
  const fractionRef = useValuePulse(usage?.contextWindow.usedTokens);
  const rateLimitsKey = usage?.rateLimits
    ? `${Math.round(usage.rateLimits.fiveHour.usedPercentage)}-${Math.round(usage.rateLimits.sevenDay.usedPercentage)}`
    : '';
  const rateLimitsRef = useValuePulse(rateLimitsKey);

  // Model is "resolved" only when the CLI status line has reported a real
  // displayName. Until then we show a single spinner pill instead of flashing
  // through "Agent" -> "Claude" -> "Opus 4.6 (1M Context)" as data trickles in.
  const resolvedModelName = usage?.model.displayName || null;

  if (!usage || !resolvedModelName) {
    const spinnerLabel = isResuming ? 'Resuming agent...' : 'Starting agent...';
    return (
      <div
        className="h-8 bg-surface/80 border-t border-edge flex items-center px-3 gap-2 text-xs flex-shrink-0"
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

  // Fallback to 0 for fields that may be absent from older main-process sessions
  const usedTokens = usage.contextWindow.usedTokens ?? 0;
  const cacheTokens = usage.contextWindow.cacheTokens ?? 0;
  const { contextWindowSize } = usage.contextWindow;

  const barTooltip = `${formatTokenCount(cacheTokens)} cached (system) \u00b7 ${formatTokenCount(Math.max(0, usedTokens - cacheTokens))} conversation`;

  // Determine which elements are visible
  const showShell = !compact && !!sessionShell && contextBarConfig.showShell;
  const showVersion = !compact && contextBarConfig.showVersion;
  const showModel = contextBarConfig.showModel;
  const showCost = contextBarConfig.showCost;
  const showTokens = !compact && contextBarConfig.showTokens;
  const showFraction = contextBarConfig.showContextFraction;
  const showProgressBar = contextBarConfig.showProgressBar;
  const showRateLimits = !!usage.rateLimits && contextBarConfig.showRateLimits;

  // Left pills: shell, version, model, rate limits, cost. Right pills: tokens, fraction, progress bar.
  const hasLeftPills = showShell || showVersion || showModel || showRateLimits || showCost;
  const hasRightPills = showTokens || showFraction || showProgressBar;

  // Return null if everything is hidden
  if (!hasLeftPills && !hasRightPills) return null;

  return (
    <div
      className="h-8 bg-surface/80 border-t border-edge flex items-center px-3 gap-2 text-xs flex-shrink-0"
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
      {showModel && <span className={`${pill} text-fg-muted`}>{modelName}</span>}
      {showRateLimits && usage.rateLimits && (() => {
        const rateLimits = usage.rateLimits;
        return (
          <span
            ref={rateLimitsRef}
            className={`${pill} text-fg-muted tabular-nums flex items-center gap-2`}
            title={`5h session: ${formatResetTime(rateLimits.fiveHour.resetsAt)}\n7d weekly: ${formatResetTime(rateLimits.sevenDay.resetsAt)}`}
            data-testid="rate-limits-pill"
          >
            {(['fiveHour', 'sevenDay'] as const).map((key) => {
              const row = rateLimits[key];
              const Icon = key === 'fiveHour' ? Clock : Calendar;
              const pctRow = Math.round(row.usedPercentage);
              return (
                <span key={key} className="flex items-center gap-1.5">
                  <Icon size={11} className="text-fg-faint" aria-label={key === 'fiveHour' ? '5h session' : '7d weekly'} />
                  <span className="w-20 h-1.5 bg-surface-hover rounded-full overflow-hidden">
                    <span
                      className="block h-full rounded-full transition-[width,background-color] duration-300"
                      style={{
                        width: `${Math.min(pctRow, 100)}%`,
                        minWidth: pctRow > 0 ? '2px' : undefined,
                        backgroundColor: getProgressColor(pctRow),
                      }}
                    />
                  </span>
                  <span>{pctRow}%</span>
                </span>
              );
            })}
          </span>
        );
      })()}
      {showCost && <span ref={costRef} className={`${pill} text-fg-muted tabular-nums`} title="Session API cost">{formatCost(usage.cost.totalCostUsd)}</span>}

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

      {showFraction && (
        <span ref={fractionRef} className={`${pill} text-fg-muted tabular-nums`} title="Context tokens used / total window size">
          {formatTokenCount(usedTokens)} / {formatTokenCount(contextWindowSize)}
        </span>
      )}

      {showProgressBar && (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex-1 h-1.5 bg-surface-hover rounded-full overflow-hidden" title={barTooltip}>
            <div
              className="h-full rounded-full transition-[width,background-color] duration-300"
              style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
            />
          </div>
          <span ref={pctRef} className="tabular-nums text-fg-faint whitespace-nowrap transition-colors duration-300" title={`${100 - pct}% remaining`}>{pct}% context</span>
        </div>
      )}
    </div>
  );
}
