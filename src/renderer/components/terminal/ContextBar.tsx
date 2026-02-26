import React from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { getProgressColor } from '../../utils/color-lerp';

interface ContextBarProps {
  sessionId: string;
  compact?: boolean; // hide version label — used in the bottom panel
}

const pill = 'px-2 py-0.5 rounded bg-zinc-800 whitespace-nowrap';

/**
 * Visual context window usage bar displayed below terminal areas.
 * Full mode (task detail): version, model, progress bar, percentage, cost.
 * Compact mode (bottom panel): model, progress bar, percentage, cost.
 */
export function ContextBar({ sessionId, compact = false }: ContextBarProps) {
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);
  const claudeVersionNumber = useConfigStore((s) => s.claudeVersionNumber);

  if (!usage) return null;

  const pct = Math.round(usage.contextWindow.usedPercentage);
  const progressColor = getProgressColor(pct);

  const modelName = usage.model.displayName || 'Claude';

  return (
    <div
      className="h-8 bg-zinc-900/80 border-t border-zinc-700 flex items-center px-3 gap-2 text-xs flex-shrink-0"
      data-testid="usage-bar"
    >
      {!compact && (
        <span className={`${pill} text-zinc-400`}>
          Claude Code
          {claudeVersionNumber && (
            <span className="text-zinc-500 ml-1.5">v{claudeVersionNumber}</span>
          )}
        </span>
      )}
      <span className={`${pill} text-zinc-400`}>{modelName}</span>
      <span className={`${pill} text-zinc-400 tabular-nums`}>${usage.cost.totalCostUsd.toFixed(2)}</span>

      <div className="w-px h-3.5 bg-zinc-700 flex-shrink-0" />

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
          />
        </div>
        <span className="tabular-nums text-zinc-500 whitespace-nowrap transition-colors duration-300">{pct}% context</span>
      </div>
    </div>
  );
}
