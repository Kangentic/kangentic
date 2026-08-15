import React from 'react';

type CountBadgeVariant = 'muted' | 'accent' | 'solid';
type CountBadgeSize = 'xs' | 'sm' | 'md';

interface CountBadgeProps {
  count: number;
  /** Visual variant. 'muted' for subtle, 'accent' for highlighted, 'solid' for strong emphasis. */
  variant?: CountBadgeVariant;
  /** Size. 'xs' = 14px circle (overlaid on an icon), 'sm' = 18px, 'md' = 20px. */
  size?: CountBadgeSize;
  className?: string;
}

const SIZE_CLASSES: Record<CountBadgeSize, string> = {
  // 'xs' exists for badges OVERLAID on a title-bar icon button, where the glyph
  // is 20px: an 18px badge is nearly icon-sized and buries whatever it sits on.
  // Keeps the 10px text floor the badge family is grandfathered at, and pairs
  // with a min-w so a 2-digit count widens into a pill instead of clipping.
  xs: 'h-3.5 min-w-3.5 px-[3px] text-[10px]',
  sm: 'w-[18px] h-[18px] text-[10px]',
  md: 'w-5 h-5 text-[12px]',
};

const VARIANT_CLASSES: Record<CountBadgeVariant, string> = {
  muted: 'bg-surface-hover/50 text-fg-faint',
  accent: 'bg-surface-hover/50 text-fg-muted',
  solid: 'bg-accent-emphasis text-accent-on',
};

/**
 * Circular count badge for displaying numeric counts. 'sm' and 'md' are fixed
 * circles; 'xs' is a circle at one digit that widens into a pill past that, so
 * an overlay badge stays small without clipping a 2-digit count.
 *
 * Usage:
 *   <CountBadge count={3} />
 *   <CountBadge count={12} variant="accent" />
 *   <CountBadge count={5} variant="solid" size="sm" />
 *   <CountBadge count={12} variant="solid" size="xs" />   // overlaid on an icon
 */
export const CountBadge = React.memo(function CountBadge({
  count,
  variant = 'muted',
  size = 'md',
  className,
}: CountBadgeProps) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold tabular-nums leading-none select-none ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className ?? ''}`}
    >
      {count}
    </span>
  );
});
