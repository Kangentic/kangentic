import React from 'react';
import { TINTED_PILL_EDGE, TINTED_PILL_FILL } from './Pill';

type CountBadgeVariant = 'solid' | 'tinted';
type CountBadgeSize = 'xs' | 'pill';

interface CountBadgeProps {
  count: number;
  /**
   * Visual variant. 'tinted' is the standard count: it sets no text color and takes the tone
   * of whatever it sits in. 'solid' is the title bar's unread overlay.
   */
  variant?: CountBadgeVariant;
  /**
   * Size. 'pill' = the standard 18px pill that widens with each digit, its digits centered on
   * their own ink. 'xs' = 14px circle overlaid on an icon.
   */
  size?: CountBadgeSize;
  className?: string;
  testId?: string;
}

const SIZE_CLASSES: Record<CountBadgeSize, string> = {
  // 'xs' exists for badges OVERLAID on a title-bar icon button, where the glyph
  // is 20px: an 18px badge is nearly icon-sized and buries whatever it sits on.
  // Keeps the 10px text floor the badge family is grandfathered at, and pairs
  // with a min-w so a 2-digit count widens into a pill instead of clipping.
  xs: 'h-3.5 min-w-3.5 px-[3px] text-[10px] tabular-nums',
  // Proportional figures: a tabular "1" is padded to a full digit's width, which
  // put "1204" up to 1.1px right of center when measured from the pixels;
  // proportional ones held every count from 1 to 4 digits within 0.51px.
  pill: 'h-[18px] min-w-[18px] px-1 text-[11px] proportional-nums',
};

const VARIANT_CLASSES: Record<CountBadgeVariant, string> = {
  solid: 'bg-accent-emphasis text-accent-on',
  // No text color: the count takes the tone of whatever it sits in (muted
  // while its tab is idle, bright when selected or hovered, red in a conflict
  // line), and its fill and edge are mixed from that same tone, so it reads on
  // any ground behind it.
  tinted: 'border',
};

const TINTED_STYLE: React.CSSProperties = {
  backgroundColor: TINTED_PILL_FILL,
  borderColor: TINTED_PILL_EDGE,
};

/**
 * Count badge for displaying numeric counts. The standard count is
 * `variant="tinted" size="pill"`, placed right after the label it counts. It
 * takes its parent's text color, so a call site whose parent sets no tone gives
 * the badge one through `className` (`<body>` is `text-fg`, so an untoned badge
 * renders bright). The one other shape is the title bar's unread announcements
 * badge, a solid 'xs' circle overlaid on its icon.
 *
 * 'pill' centers the digits' INK rather than their line box. `line-height: 1`
 * centers the em box, and the system UI font's tall ascent leaves digits 0.5 to
 * 1px below center. `text-box` trims the line to the digits' cap height and
 * baseline, but only on the inner span: a bare text node in a flex container
 * sits in an anonymous item the property never reaches. 11px digits are 8px of
 * ink, so the 18px pill leaves an even 5px above and below, which is exact at
 * 100% and 200% display scaling (an odd remainder can never center at 100%).
 *
 * Usage:
 *   <CountBadge count={21} variant="tinted" size="pill" />                       // inside a toned control
 *   <CountBadge count={4} variant="tinted" size="pill" className="text-fg-muted" /> // after a label, toned
 *   <CountBadge count={12} variant="solid" size="xs" />                           // overlaid on an icon
 */
export const CountBadge = React.memo(function CountBadge({
  count,
  variant = 'tinted',
  size = 'pill',
  className,
  testId,
}: CountBadgeProps) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold leading-none select-none ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className ?? ''}`}
      style={variant === 'tinted' ? TINTED_STYLE : undefined}
      data-testid={testId}
    >
      {size === 'pill' ? <span className="[text-box:trim-both_cap_alphabetic]">{count}</span> : count}
    </span>
  );
});
