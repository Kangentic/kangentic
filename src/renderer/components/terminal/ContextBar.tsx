import { ArrowUp, ArrowDown } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/color-lerp';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost } from '../../utils/format-session';
import { agentDisplayName, agentShortName } from '../../utils/agent-display-name';
import { shellDisplayName } from '../../utils/shell-display-name';
import { useValuePulse } from '../../hooks/useValuePulse';

interface ContextBarProps {
  sessionId: string;
  compact?: boolean; // hide version label -- used in the bottom panel
}

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';

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
  const sessionShell = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === sessionId)?.shell,
  );
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

  if (!usage) return null;

  const pct = Math.round(usage.contextWindow.usedPercentage);
  const progressColor = getProgressColor(pct);

  const modelName = usage.model.displayName || agentShortName(taskAgent);

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

  // Left pills: shell, version, model, cost. Right pills: tokens, fraction, progress bar.
  const hasLeftPills = showShell || showVersion || showModel || showCost;
  const hasRightPills = showTokens || showFraction || showProgressBar;

  // Return null if everything is hidden
  if (!hasLeftPills && !hasRightPills) return null;

  return (
    <div
      className="h-8 bg-surface/80 border-t border-edge flex items-center px-3 gap-2 text-xs flex-shrink-0"
      data-testid="usage-bar"
    >
      {showShell && (
        <>
          <span className={`${pill} text-fg-faint`} title={sessionShell as string}>
            {shellDisplayName(sessionShell as string)}
          </span>
          <div className="w-px h-3.5 bg-surface-hover flex-shrink-0" />
        </>
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
      {showCost && <span ref={costRef} className={`${pill} text-fg-muted tabular-nums`} title="Session API cost">{formatCost(usage.cost.totalCostUsd)}</span>}

      {hasLeftPills && hasRightPills && (
        <div className="w-px h-3.5 bg-surface-hover flex-shrink-0" />
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
