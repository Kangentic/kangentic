import React from 'react';

type CountBadgeVariant = 'muted' | 'accent' | 'solid';
type CountBadgeSize = 'sm' | 'md';

interface CountBadgeProps {
  count: number;
  /** Visual variant. 'muted' for subtle, 'accent' for highlighted, 'solid' for strong emphasis. */
  variant?: CountBadgeVariant;
  /** Size. 'sm' = 18px circle, 'md' = 20px circle. */
  size?: CountBadgeSize;
  className?: string;
}

const SIZE_CLASSES: Record<CountBadgeSize, string> = {
  sm: 'w-[18px] h-[18px] text-[10px]',
  md: 'w-5 h-5 text-[12px]',
};

const VARIANT_CLASSES: Record<CountBadgeVariant, string> = {
  muted: 'bg-surface-hover/50 text-fg-faint',
  accent: 'bg-surface-hover/50 text-fg-muted',
  solid: 'bg-accent-emphasis text-accent-on',
};

/**
 * Circular count badge for displaying numeric counts.
 * Always renders as a perfect circle with centered text.
 *
 * Usage:
 *   <CountBadge count={3} />
 *   <CountBadge count={12} variant="accent" />
 *   <CountBadge count={5} variant="solid" size="sm" />
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
