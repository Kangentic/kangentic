import React from 'react';

type PillSize = 'sm' | 'md' | 'lg';
type PillShape = 'round' | 'square';

type PillElement = 'button' | 'span' | 'div';

type PillOwnProps = {
  size?: PillSize;
  shape?: PillShape;
  /** Explicit element type. Auto-detected from `onClick` if omitted. */
  as?: PillElement;
  className?: string;
  children?: React.ReactNode;
};

/** Native attributes for each element type. */
type ButtonAttrs = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof PillOwnProps>;
type SpanAttrs = Omit<React.HTMLAttributes<HTMLSpanElement>, keyof PillOwnProps>;
type DivAttrs = Omit<React.HTMLAttributes<HTMLDivElement>, keyof PillOwnProps>;

type PillProps = PillOwnProps & (ButtonAttrs | SpanAttrs | DivAttrs);

const SIZE_CLASSES: Record<PillSize, string> = {
  sm: 'gap-1 min-w-[32px] px-2.5 py-1 text-xs',
  md: 'gap-1.5 min-w-[40px] px-3 py-1.5 text-xs',
  lg: 'gap-2 min-w-[48px] px-4 py-2 text-sm',
};

const SHAPE_CLASSES: Record<PillShape, string> = {
  round: 'rounded-full',
  square: 'rounded-lg',
};

/**
 * Shared pill/badge/tag component.
 *
 * Provides structural layout (inline-flex, select-none, size-appropriate
 * padding/gap/text, shape rounding). Callers own colors, hover states,
 * transitions, and extras via `className`.
 */
export const Pill = React.memo(React.forwardRef<HTMLElement, PillProps>(function Pill(
  { size = 'md', shape = 'round', as, className, children, ...rest },
  ref,
) {
  const isInteractive = as === 'button' || (!as && 'onClick' in rest && rest.onClick != null);
  const Element = as ?? (isInteractive ? 'button' : 'span');

  const base = `inline-flex items-center justify-center select-none ${SIZE_CLASSES[size]} ${SHAPE_CLASSES[shape]}`;
  const interactive = isInteractive ? 'cursor-pointer' : '';
  const classes = `${base} ${interactive} ${className ?? ''}`;

  const elementProps: Record<string, unknown> = { ...rest, ref, className: classes };
  if (Element === 'button' && !('type' in rest)) {
    elementProps.type = 'button';
  }

  return React.createElement(Element, elementProps, children);
}));
