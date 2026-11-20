import React, { useState, useRef, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from './Pill';
import { OverlayPopover } from './OverlayPopover';
import { Tooltip } from './Tooltip';
import { usePopoverPosition } from '../hooks/usePopoverPosition';

interface LabelInputProps {
  labels: string[];
  setLabels: (labels: string[]) => void;
  labelColors: Record<string, string>;
  allExistingLabels: string[];
  testId?: string;
  /**
   * How a value reads, in its chip's tip and its suggestion, and what typing
   * filters on. Defaults to the value itself. The Edit automation dialog's
   * Priority line (#872) holds level numbers and reads them as level names.
   */
  displayValue?: (value: string) => string;
  /**
   * Drawn in place of a chip's text and before a suggestion's (a priority
   * level's meter). With it, a chip carries its text as its tip and its
   * accessible name instead.
   */
  renderLeading?: (value: string) => React.ReactNode;
  /** Whether typed text that is no suggestion becomes a value. Defaults to true. */
  allowCustom?: boolean;
  /** The empty field's placeholder. */
  placeholder?: string;
  /** The text input's accessible name, where no label element names it. */
  ariaLabel?: string;
}

/**
 * Shared chip input with autocomplete suggestions: a task's labels, and the
 * Edit automation dialog's Labels and Priority lines.
 * Shows existing values as pills with remove buttons, and a text input
 * with a suggestion dropdown for adding values.
 */
export function LabelInput({
  labels,
  setLabels,
  labelColors,
  allExistingLabels,
  testId,
  displayValue,
  renderLeading,
  allowCustom = true,
  placeholder,
  ariaLabel,
}: LabelInputProps) {
  const { t } = useLingui();
  const [labelInput, setLabelInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const readAs = useMemo(() => displayValue ?? ((value: string) => value), [displayValue]);

  const filteredSuggestions = useMemo(() => {
    const query = labelInput.toLowerCase().trim();
    return allExistingLabels.filter(
      (label) => readAs(label).toLowerCase().includes(query) && !labels.includes(label),
    );
  }, [labelInput, allExistingLabels, labels, readAs]);

  const suggestionsOpen = showSuggestions && filteredSuggestions.length > 0;

  // Portaled to document.body (see render below), so measure and position against
  // the visible field rather than relying on an in-flow absolute offset that would
  // be clipped by an ancestor `overflow: hidden` / `overflow-y-auto`.
  // `matchTriggerWidth` replaces the old `left-0 right-0` in-flow stretch; the
  // hook applies it before it measures.
  const { style: popoverStyle, placement } = usePopoverPosition(containerRef, suggestionsRef, suggestionsOpen, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
    matchTriggerWidth: true,
  });

  // Close suggestions on click outside. The popover is portaled OUT of
  // containerRef, so a click inside it must also count as "inside".
  useEffect(() => {
    if (!showSuggestions) return;
    const handleClick = (event: MouseEvent) => {
      if (
        suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
        containerRef.current && !containerRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showSuggestions]);

  /**
   * The value typed text names: itself when custom values are allowed, else
   * the one suggestion that reads as it (any case), or none.
   */
  const valueForTyped = (typed: string): string | null => {
    const trimmed = typed.trim();
    if (!trimmed) return null;
    if (allowCustom) return trimmed;
    const key = trimmed.toLowerCase();
    return allExistingLabels.find((candidate) => readAs(candidate).toLowerCase() === key && !labels.includes(candidate))
      ?? (filteredSuggestions.length === 1 ? filteredSuggestions[0] : null);
  };

  const addLabel = (label: string) => {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed)) {
      setLabels([...labels, trimmed]);
    }
    setLabelInput('');
    setShowSuggestions(false);
    labelInputRef.current?.focus();
  };

  /**
   * Add what was typed. Text that names no value (a list that takes no custom
   * value, typed past every suggestion or matching several) stays in the field
   * with the suggestions open on Enter, so the user can finish it, and goes when
   * the field loses focus, since it was never a value.
   */
  const addTyped = (onMiss: 'keep' | 'clear') => {
    const value = valueForTyped(labelInput);
    if (value !== null) addLabel(value);
    else if (onMiss === 'clear') setLabelInput('');
    else setShowSuggestions(true);
  };

  const removeLabel = (label: string) => {
    setLabels(labels.filter((existingLabel) => existingLabel !== label));
  };

  const handleLabelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (labelInput.trim()) {
        addTyped('keep');
      }
    } else if (event.key === 'Backspace' && !labelInput && labels.length > 0) {
      removeLabel(labels[labels.length - 1]);
    } else if (event.key === 'Escape' && showSuggestions) {
      event.stopPropagation();
      setShowSuggestions(false);
    }
  };

  return (
    // No "Labels" <label> of its own: the caller wraps this in `Field`, which
    // owns the label for every dialog field. Rendering one here too put two
    // labels side by side in the same row at different font weights.
    <div className="relative">
      <div
        ref={containerRef}
        className="flex flex-wrap items-center gap-1 bg-surface-control border border-edge-input rounded px-2 py-1 min-h-[34px] focus-within:border-accent"
      >
        {labels.map((label) => {
          const color = labelColors[label];
          const text = readAs(label);
          const leading = renderLeading?.(label);
          const chip = (
            <Pill
              key={label}
              size="sm"
              // A configured label used to get `surface-control/60`, which is 60 percent of the
              // SAME token as the field it sits in, and no border: the pill was painted its own
              // background and vanished. It now carries the tint its colour gives it, matching
              // the pill on a card. An unconfigured label keeps the solid fill and edge below,
              // since it has no colour to tint with.
              className={color ? 'font-medium border' : 'bg-surface-raised text-fg-secondary font-medium border border-edge-input'}
              style={color ? { color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE } : undefined}
              data-testid={testId ? `${testId}-chip` : undefined}
              data-value={label}
            >
              {/* The text is centered by `Pill` itself (it trims bare text to
                  its cap height, see `trimTextChildren`). The button is a flex
                  container so the icon is a flex item rather than an inline svg
                  parked on the baseline of an empty line box, which had it
                  sitting ~1px high while the text sat ~2px low. */}
              {leading ?? text}
              <button
                type="button"
                onClick={() => removeLabel(label)}
                className="ml-px flex items-center justify-center rounded-full hover:bg-black/20 p-0.5 opacity-60 hover:opacity-100 transition-opacity"
                aria-label={t`Remove ${text}`}
              >
                <X size={12} />
              </button>
            </Pill>
          );
          // A chip drawn as a mark alone (a priority's meter) says its value in its tip.
          return leading ? <Tooltip key={label} label={text} describe={false}>{chip}</Tooltip> : chip;
        })}
        <input
          ref={labelInputRef}
          type="text"
          value={labelInput}
          onChange={(event) => {
            setLabelInput(event.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            if (labelInput.trim()) {
              addTyped('clear');
            }
          }}
          onKeyDown={handleLabelKeyDown}
          placeholder={labels.length === 0 ? (placeholder ?? t`Type to add...`) : ''}
          aria-label={ariaLabel}
          // text-sm matches the Priority select beside it, so an empty Labels
          // field reads at the same size as its neighbour. The pills above stay
          // text-xs - they are pills, sized like every other pill in the app.
          className="flex-1 min-w-[80px] bg-transparent text-sm text-fg placeholder-fg-faint outline-none py-0.5"
          data-testid={testId}
        />
      </div>

      {/* Label suggestions dropdown - portaled to escape clipping ancestors (e.g. the
          task-detail window's overflow-y-auto edit form) */}
      <OverlayPopover
        open={suggestionsOpen}
        popoverRef={suggestionsRef}
        style={popoverStyle}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl py-1 max-h-[150px] overflow-y-auto"
        data-testid="label-suggestions"
      >
        {filteredSuggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => addLabel(suggestion)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40"
            data-testid="label-suggestion"
          >
            {renderLeading?.(suggestion)}
            {readAs(suggestion)}
          </button>
        ))}
      </OverlayPopover>
    </div>
  );
}
