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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (activeIndex + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (activeIndex - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === null) return;
    // Only swallow the keys actually handled, so nothing the surrounding toolbar
    // or dialog binds is eaten by having focus inside the control.
    event.preventDefault();
    event.stopPropagation();
    focusOption(next);
  };

  const tone = GROUND_CLASSES[ground];

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      data-testid={testId}
      className={`inline-flex rounded-md border p-0.5 ${tone.track} ${fullWidth ? 'flex w-full' : ''} ${
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
          return (
            <button
              key={option.value}
              // Not optional: several dialogs wrap their body in a <form>, where
              // a bare button submits it (see WorktreeChip).
              type="button"
              ref={(element) => { optionRefs.current[index] = element; }}
              role="radio"
              aria-checked={selected}
              // Roving tabindex: the group is one tab stop, arrows move within it.
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              title={option.title}
              onClick={() => onChange(option.value)}
              data-testid={option.testId}
              data-selected={selected}
              className={`relative z-[1] flex items-center justify-center gap-1.5 rounded px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                fullWidth ? 'flex-1' : ''
              } ${
                selected
                  ? 'text-fg'
                  : `text-fg-muted ${disabled ? '' : 'hover:text-fg'}`
              } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
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
