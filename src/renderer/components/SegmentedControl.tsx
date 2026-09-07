import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading glyph. Render at 14px to sit on the 14px label. */
  icon?: React.ReactNode;
  /** Optional trailing node, e.g. a `CountBadge`. */
  trailing?: React.ReactNode;
  /** Per-option test hook. Not derived from `value`, so adopters keep their existing ids. */
  testId?: string;
  title?: string;
  /**
   * Disable this one option: it cannot be selected by click or arrow key and
   * reads dimmed, while the rest of the group stays live. For a group that is
   * unavailable as a whole, use the group-level `disabled` instead.
   */
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Which ground the control sits on. This is a real fork, not a style
   * preference: the surface ramp INVERTS between themes. In dark themes the
   * control fill is LIGHTER than its ground; in the light themes it is DARKER.
   * So one hardcoded thumb fill reads as "raised" in dark and "pressed" in
   * light, and which of those is correct depends on the ground.
   *
   *   - `'control'` (default) - the control sits in a form row on a
   *     `surface-raised` ground, beside `Select` / `Combobox`. The thumb takes
   *     `surface-control`, the same fill those controls use, so a segmented
   *     control and a select in one row read as the same species of control.
   *   - `'raised'` - the control sits on the app ground (the board toolbar). The
   *     thumb takes `surface-raised`, which stays lighter than its track in every
   *     theme.
   */
  ground?: 'control' | 'raised';
  /**
   * Soften the control for a dialog form row where it stands beside muted
   * inputs (the New Task dialog's Branch row). The default, a bold `fg` label
   * on the thumb, is right in the board toolbar and the Board Manager's
   * settings grid, but beside a quiet field shell it reads as a primary
   * button. Quiet keeps the `control` ground's fills, which are the pairing
   * `theme-contrast.test.ts` guarantees separates in every theme (a `surface`
   * recess under a `surface-control` thumb, the same fill as the field beside
   * it, so the selected option sits at the field's own level), and drops the
   * labels to the field's text scale and weight, which was the part that read
   * as a button. A translucent `surface-hover` lift on the field fill was
   * tried first and vanished in the default theme, where hover and control
   * are six units apart. Height stays 34px: `py-1.5` makes up for `text-xs`,
   * and the track takes the field shell's `rounded` so the row shares one
   * corner radius. Overrides `ground`.
   */
  quiet?: boolean;
  /** Stretch to fill the container, options sharing the width equally. */
  fullWidth?: boolean;
  /** Group-level test hook. */
  testId?: string;
  /** Announced name for the group. */
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

const GROUND_CLASSES = {
  // Matches `FIELD_CONTROL_BASE` / `Combobox` / `ToggleCard`, so a segmented
  // control reads as the same species as the fields it sits among.
  control: { track: 'bg-surface border-edge-input', thumb: 'bg-surface-control' },
  raised: { track: 'bg-surface/50 border-edge/30', thumb: 'bg-surface-raised shadow-sm' },
  // Same fills as `control`: that pairing is the one the theme-contrast test
  // holds apart in every theme. Quiet differs in its text, not its fills.
  quiet: { track: 'bg-surface border-edge-input', thumb: 'bg-surface-control' },
} as const;

const OPTION_TEXT = {
  default: {
    size: 'px-3 py-1 text-sm font-medium',
    selected: 'text-fg',
    idle: 'text-fg-muted',
    idleHover: 'hover:text-fg',
    optionDisabled: 'text-fg-disabled',
  },
  quiet: {
    size: 'px-3 py-1.5 text-xs',
    selected: 'text-fg-secondary',
    idle: 'text-fg-muted',
    idleHover: 'hover:text-fg-secondary',
    optionDisabled: 'text-fg-disabled',
  },
} as const;

/**
 * A recessed track with a sliding thumb marking the selected option: the shared
 * control for a small, flat set of mutually exclusive choices where showing the
 * alternatives is worth the width. For a long or open-ended list use the shared
 * `Select`; for a boolean whose off state has no name, use `ToggleCard`.
 *
 * There is deliberately ONE height. It is padding-derived (`p-0.5` track +
 * `py-1` + `text-sm` options + 1px borders = 34px) rather than a fixed
 * `h-[34px]`, exactly as `FIELD_CONTROL_CLASS` derives its own, so the control
 * keeps matching `Select` and `Combobox` if the text scale ever changes. A
 * shorter variant was considered and dropped: the whole reason this control
 * exists is to sit in a row beside those inputs, and a second height would make
 * it the ragged one.
 *
 * Interaction is the WAI-ARIA radiogroup pattern, not a row of buttons: one tab
 * stop for the group (roving tabindex), arrows move selection, Home/End jump to
 * the ends. That is what `role="radiogroup"` promises a screen reader, so the
 * keyboard model and the role have to agree.
 *
 * The thumb is measured, never computed from padding arithmetic. Option widths
 * depend on label text, icons, and trailing badges, so any hand-derived offset
 * is wrong the moment a caller passes a different label.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ground = 'control',
  quiet = false,
  fullWidth = false,
  testId,
  ariaLabel,
  className = '',
  disabled = false,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  /**
   * Measured with `getBoundingClientRect`, NOT `offsetLeft` / `offsetWidth`.
   * Those two round to integers, and option widths are routinely fractional
   * (text metrics rarely land on whole pixels), so a rounded thumb sits a
   * fraction narrow. On the LAST option that shortfall is not distributed
   * anywhere - it shows up as a visibly wider gap on the trailing edge than the
   * 2px inset above and below.
   *
   * The row is the positioning context and carries no border or padding, so its
   * border box, padding box, and content box coincide: the thumb's containing
   * block origin is exactly `rowRect.left`, with no correction term.
   */
  const measure = useCallback(() => {
    const active = optionRefs.current[activeIndex];
    const row = rowRef.current;
    if (!active || !row) return;
    const rowRect = row.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const next = { left: activeRect.left - rowRect.left, width: activeRect.width };
    setThumb((current) =>
      current && current.left === next.left && current.width === next.width ? current : next,
    );
  }, [activeIndex]);

  useLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    // Labels reflow with the container (`fullWidth`) and with font loading, and
    // neither fires anything else this component would see.
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const option of optionRefs.current) {
      if (option) observer.observe(option);
    }
    return () => observer.disconnect();
  }, [measure, options]);

  const focusOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    optionRefs.current[index]?.focus();
    onChange(option.value);
  };

  const isOptionDisabled = (index: number) => options[index]?.disabled === true;

  /** The nearest enabled option `step` away from `from`, wrapping; null when none. */
  const nextEnabled = (from: number, step: 1 | -1): number | null => {
    for (let hop = 1; hop < options.length; hop += 1) {
      const candidate = (from + step * hop + options.length * hop) % options.length;
      if (!isOptionDisabled(candidate)) return candidate;
    }
    return null;
  };

  const endEnabled = (from: 'first' | 'last'): number | null => {
    const order = options.map((_option, index) => index);
    if (from === 'last') order.reverse();
    const found = order.find((index) => !isOptionDisabled(index));
    return found === undefined ? null : found;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | null | undefined;
    // Arrows and Home/End skip a disabled option, so a per-option `disabled`
    // holds for the keyboard exactly as it does for the mouse.
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = nextEnabled(activeIndex, 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = nextEnabled(activeIndex, -1);
    else if (event.key === 'Home') next = endEnabled('first');
    else if (event.key === 'End') next = endEnabled('last');
    if (next === undefined) return;
    // Only swallow the keys actually handled, so nothing the surrounding toolbar
    // or dialog binds is eaten by having focus inside the control.
    event.preventDefault();
    event.stopPropagation();
    if (next === null || next === activeIndex) return;
    focusOption(next);
  };

  const tone = GROUND_CLASSES[quiet ? 'quiet' : ground];
  const text = OPTION_TEXT[quiet ? 'quiet' : 'default'];

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      data-testid={testId}
      data-quiet={quiet || undefined}
      // Quiet takes the field shell's `rounded` (4px) rather than `rounded-md`,
      // so the two boxes in a form row share one corner radius.
      className={`inline-flex ${quiet ? 'rounded' : 'rounded-md'} border p-0.5 ${tone.track} ${fullWidth ? 'flex w-full' : ''} ${
        disabled ? 'opacity-50' : ''
      } ${className}`}
    >
      <div ref={rowRef} className={`relative flex items-stretch ${fullWidth ? 'w-full' : ''}`}>
        {thumb && (
          <span
            aria-hidden="true"
            // `kng-segmented-thumb` carries only the reduced-motion opt-out
            // (index.css); everything visual stays in utilities.
            className={`kng-segmented-thumb absolute inset-y-0 left-0 rounded ${tone.thumb} ${
              // No transition until the thumb has been placed once, so it does
              // not slide in from the left edge on first paint.
              thumb ? 'transition-[transform,width] duration-150 ease-out' : ''
            }`}
            style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
          />
        )}
        {options.map((option, index) => {
          const selected = index === activeIndex;
          const optionDisabled = disabled || option.disabled === true;
          return (
            <button
              key={option.value}
              // Not optional: several dialogs wrap their body in a <form>, where
              // a bare button submits it (the New Task dialog's Branch row is
              // one such adopter).
              type="button"
              ref={(element) => { optionRefs.current[index] = element; }}
              role="radio"
              aria-checked={selected}
              // Roving tabindex: the group is one tab stop, arrows move within it.
              tabIndex={selected ? 0 : -1}
              disabled={optionDisabled}
              title={option.title}
              onClick={() => onChange(option.value)}
              data-testid={option.testId}
              data-selected={selected}
              className={`relative z-[1] flex items-center justify-center gap-1.5 rounded ${text.size} whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                fullWidth ? 'flex-1' : ''
              } ${
                selected
                  ? text.selected
                  : option.disabled && !disabled
                    ? text.optionDisabled
                    : `${text.idle} ${disabled ? '' : text.idleHover}`
              } ${optionDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {option.icon}
              <span>{option.label}</span>
              {option.trailing}
            </button>
          );
        })}
      </div>
    </div>
  );
}
