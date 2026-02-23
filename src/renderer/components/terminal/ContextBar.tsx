import React from 'react';
import { useSessionStore } from '../../stores/session-store';

interface ContextBarProps {
  sessionId: string;
}

/**
 * Visual context window usage bar displayed below terminal areas.
 * Shows model name, a color-coded progress bar, percentage, and cost.
 */
export function ContextBar({ sessionId }: ContextBarProps) {
  const usage = useSessionStore((s) => s.sessionUsage[sessionId]);

  if (!usage) return null;

  const pct = Math.round(usage.contextWindow.usedPercentage);
  const barColor =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div
      className="h-7 bg-zinc-900/80 border-t border-zinc-700 flex items-center px-3 gap-3 text-xs flex-shrink-0"
      data-testid="usage-bar"
    >
      <span className="text-zinc-400 whitespace-nowrap">
        {usage.model.displayName || 'Claude'}
      </span>

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="w-32 h-1.5 bg-zinc-700 rounded-full overflow-hidden flex-shrink-0">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className="text-zinc-500 tabular-nums">{pct}%</span>
      </div>

      <span className="text-zinc-500 tabular-nums whitespace-nowrap">
        ${usage.cost.totalCostUsd.toFixed(2)}
      </span>
    </div>
  );
}
