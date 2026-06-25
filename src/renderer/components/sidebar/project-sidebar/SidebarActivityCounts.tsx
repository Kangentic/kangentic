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

  // Match the row's sibling icons (project name text, kebab) and the task-card
  // indicator at 14px: the lucide Mail/Loader2 glyphs smear at 11-12px because the
  // 2px stroke scales down to a sub-pixel hairline.
  const iconSize = size === 'group' ? 12 : 14;
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
          <Mail size={iconSize} className="text-attention flex-shrink-0" />
          <span
            className="flex items-center justify-center min-w-[1ch] font-semibold text-attention"
            style={countBoxStyle}
          >
            {idleCount}
          </span>
        </span>
      )}
      {hasThinking && (
        <span className="flex items-center gap-1" aria-hidden>
          <Loader2 size={iconSize} className="text-active animate-spin flex-shrink-0" />
          <span
            className="flex items-center justify-center min-w-[1ch] font-semibold text-active"
            style={countBoxStyle}
          >
            {thinkingCount}
          </span>
        </span>
      )}
    </span>
  );
});
