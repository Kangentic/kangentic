import React from 'react';
import { ActivityMark } from '../../ActivityMark';

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

  // 16, the same size `TaskCard` renders these two marks at - one mark, one meaning, one size.
  // Not 14, which is what the lucide glyphs used: the branding envelope is 18 wide where
  // lucide's Mail was 20, so a same-number swap silently shrank it ~10%. 15 restored the drawn
  // WIDTH production shipped (11.25px against the old 11.67); width is the advance that aligns
  // the row and height is absorbed by centring, which is why the keyline is a width. Height has
  // since moved anyway: branding 2.7.1's 18 x 16 envelope draws 10.0px tall at 15, where
  // 18 x 14.4 drew 9.0 against lucide's 9.33. 16 is a deliberate one-step bump on top of that
  // for legibility. Keep in step with TaskCard's mark and SidebarCommandTerminalIndicator - the
  // three indicators form one tabular column.
  //
  // 12 is the floor: below it the 2px stroke scales to a sub-pixel hairline and smears, which
  // is why the branding set declares `floors.indicator = 12`.
  const iconSize = size === 'group' ? 12 : 16;
  const labelParts: string[] = [];
  if (hasIdle) labelParts.push(`${idleCount} idle`);
  if (hasThinking) labelParts.push(`${thinkingCount} thinking`);

  const countBoxStyle: React.CSSProperties = { height: iconSize };

  return (
    <span
      className={`flex-shrink-0 flex items-center gap-2 text-[11px] tabular-nums ${className ?? ''}`}
      aria-label={labelParts.join(', ')}
      data-testid="sidebar-activity-counts"
    >
      {hasIdle && (
        <span className="flex items-center gap-1" aria-hidden>
          <ActivityMark mark="agent-idle" size={iconSize} className="text-attention flex-shrink-0" />
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
          <ActivityMark mark="agent-working" size={iconSize} className="text-active flex-shrink-0" />
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
