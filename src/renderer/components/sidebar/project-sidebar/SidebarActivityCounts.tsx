import React from 'react';
import { Loader2, Mail } from 'lucide-react';

export interface SidebarActivityCountsProps {
  thinkingCount: number;
  idleCount: number;
  size?: 'row' | 'group';
  className?: string;
}

export const SidebarActivityCounts = React.memo(function SidebarActivityCounts({
  thinkingCount,
  idleCount,
  size = 'row',
  className,
}: SidebarActivityCountsProps) {
  const hasThinking = thinkingCount > 0;
  const hasIdle = idleCount > 0;
  if (!hasThinking && !hasIdle) return null;

  const iconSize = size === 'group' ? 11 : 12;
  const labelParts: string[] = [];
  if (hasIdle) labelParts.push(`${idleCount} idle`);
  if (hasThinking) labelParts.push(`${thinkingCount} thinking`);

  const countBoxStyle: React.CSSProperties = { height: iconSize };

  return (
    <span
      className={`flex-shrink-0 flex items-center gap-2 text-[11px] tabular-nums ${className ?? ''}`}
      aria-label={labelParts.join(', ')}
    >
      {hasIdle && (
        <span className="flex items-center gap-1" aria-hidden>
          <Mail size={iconSize} className="text-amber-400 flex-shrink-0" />
          <span
            className="flex items-center justify-center min-w-[1ch] font-semibold text-amber-400"
            style={countBoxStyle}
          >
            {idleCount}
          </span>
        </span>
      )}
      {hasThinking && (
        <span className="flex items-center gap-1" aria-hidden>
          <Loader2 size={iconSize} className="text-green-400 animate-spin flex-shrink-0" />
          <span
            className="flex items-center justify-center min-w-[1ch] font-semibold text-green-400"
            style={countBoxStyle}
          >
            {thinkingCount}
          </span>
        </span>
      )}
    </span>
  );
});
