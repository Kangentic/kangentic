import React from 'react';
import { Split } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from './Tooltip';

/** Native span attributes, less `title`: the badge's explanation is its Tooltip. */
type IsolatedBadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'title'>;

/**
 * lucide's Split, the one mark for an isolated session wherever the app names
 * one, so a column that runs its own conversation reads the same everywhere.
 * `size` is the size of the text beside it. Muted unless `inheritTone`, for a
 * row whose own text is fainter than muted (the conversation's move divider).
 *
 * Leading the word "Isolated", it is decorative. `explained` is for an icon
 * that stands alone after a name: it carries its own name and its tip.
 */
export function IsolatedIcon({ size, explained = false, inheritTone = false, className }: {
  size: number;
  explained?: boolean;
  inheritTone?: boolean;
  /** Extra classes, for a surface whose text needs the icon nudged to sit on its baseline. */
  className?: string;
}) {
  const { t } = useLingui();
  const toneClass = [inheritTone ? 'flex-shrink-0' : 'flex-shrink-0 text-fg-muted', className].filter(Boolean).join(' ');
  if (!explained) {
    return <Split size={size} aria-hidden="true" className={toneClass} data-testid="isolated-icon" />;
  }
  const isolatedSessionLabel = t`Isolated session`;
  return (
    <Tooltip label={isolatedSessionLabel}>
      <span role="img" aria-label={isolatedSessionLabel} className={`inline-flex ${toneClass}`} data-testid="isolated-icon">
        <Split size={size} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/**
 * "Isolated" status badge, led by the Split icon. Neutral chip with the label in
 * the theme accent (text-accent-fg) so it re-colors across all themes (see
 * index.css) instead of a fixed purple. Shared by the bottom-panel session tab
 * and the task detail header so both stay visually identical.
 */
export const IsolatedBadge = React.memo(function IsolatedBadge({ className, ...rest }: IsolatedBadgeProps) {
  const { t } = useLingui();
  return (
    <Tooltip label={t`Its own context, separate from the main conversation`}>
      <span
        className={['inline-flex items-center gap-1 text-[11px] text-accent-fg bg-surface-hover/60 border border-edge/50 rounded px-1.5 py-0.5 leading-none flex-shrink-0', className].filter(Boolean).join(' ')}
        {...rest}
      >
        <IsolatedIcon size={11} />
        <Trans>Isolated</Trans>
      </span>
    </Tooltip>
  );
});
