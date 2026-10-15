import React from 'react';
import { Tooltip } from './Tooltip';

/** Native span attributes, less `title`: the badge's explanation is its Tooltip. */
type IsolatedBadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'title'>;

/**
 * Text-only "Isolated" status badge. Neutral chip with the label in the theme
 * accent (text-accent-fg) so it re-colors across all themes (see index.css)
 * instead of a fixed purple. Shared by the bottom-panel session tab and the
 * task detail header so both stay visually identical.
 */
export const IsolatedBadge = React.memo(function IsolatedBadge({ className, ...rest }: IsolatedBadgeProps) {
  return (
    <Tooltip label="Its own context, separate from the main conversation">
      <span
        className={['inline-flex items-center text-[11px] text-accent-fg bg-surface-hover/60 border border-edge/50 rounded px-1.5 py-0.5 leading-none flex-shrink-0', className].filter(Boolean).join(' ')}
        {...rest}
      >
        Isolated
      </span>
    </Tooltip>
  );
});
