import React from 'react';

type PillSize = 'xs' | 'sm' | 'md' | 'lg';
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

// Each size carries the height its text line box used to give it (line box +
// vertical padding), because `trimTextChildren` below shrinks a text child to
// its cap height and a pill must not shrink with it.
const SIZE_CLASSES: Record<PillSize, string> = {
  xs: 'gap-1.5 min-h-[22px] px-2.5 py-[3px] text-xs',
  sm: 'gap-1 min-h-6 min-w-[32px] px-2.5 py-1 text-xs',
  md: 'gap-1.5 min-h-7 min-w-[40px] px-3 py-1.5 text-xs',
  lg: 'gap-2 min-h-9 min-w-[48px] px-4 py-2 text-sm',
};

/**
 * Trims a text run's line box to cap height and baseline, so the pill's
 * `items-center` centers the ink rather than the font's content area. A 12px
 * font's 16px line box centers that content area, and every UI font puts more
 * of it below the baseline than above the caps, so pill text sat ~2px low and
 * read as bottom-aligned beside an icon or a remove button. Metric-driven, so
 * it holds across platforms and fonts where a fixed nudge would not; a browser
 * without `text-box` simply keeps the old placement.
 */
const PILL_TEXT_CLASS = '[text-box:trim-both_cap_alphabetic]';

/**
 * Wrap bare text children in the trimmed span. Consecutive text runs merge into
 * ONE span, so `{count} items` does not become two flex items with the pill's
 * gap between them; whitespace-only runs are passed through, since a flex
 * container drops them anyway. Element children are untouched: a caller that
 * wraps its own text (a `truncate` span) keeps its own metrics.
 */
function trimTextChildren(children: React.ReactNode): React.ReactNode {
  const output: React.ReactNode[] = [];
  let textRun: string[] = [];
  const flush = () => {
    if (textRun.length === 0) return;
    const text = textRun.join('');
    textRun = [];
    if (text.trim() === '') {
      output.push(text);
      return;
    }
    output.push(<span key={`text-${output.length}`} className={PILL_TEXT_CLASS}>{text}</span>);
  };
  for (const child of React.Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') {
      textRun.push(String(child));
    } else {
      flush();
      output.push(child);
    }
  }
  flush();
  return output;
}

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

  return React.createElement(Element, elementProps, trimTextChildren(children));
}));

/** Renders a row of label pills with configured colors. Muted background, colored text. */
export const LabelPills = React.memo(function LabelPills({ labels, labelColors }: { labels: string[]; labelColors: Record<string, string> }) {
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => {
        const color = labelColors[label];
        return (
          <Pill
            key={label}
            size="sm"
            className={color ? 'bg-surface-hover/60 font-medium' : 'bg-surface-hover/60 text-fg-muted'}
            style={color ? { color } : undefined}
          >
            {label}
          </Pill>
        );
      })}
    </div>
  );
});
