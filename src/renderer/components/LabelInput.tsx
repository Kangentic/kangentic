import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { Pill } from './Pill';
import { OverlayPopover } from './OverlayPopover';
import { usePopoverPosition } from '../hooks/usePopoverPosition';

interface LabelInputProps {
  labels: string[];
  setLabels: (labels: string[]) => void;
  labelColors: Record<string, string>;
  allExistingLabels: string[];
  testId?: string;
}

/**
 * Shared label input with autocomplete suggestions.
 * Shows existing labels as pills with remove buttons, and a text input
 * with a suggestion dropdown for adding labels.
 */
export function LabelInput({ labels, setLabels, labelColors, allExistingLabels, testId }: LabelInputProps) {
  const [labelInput, setLabelInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState<number>();
  const labelInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const filteredSuggestions = useMemo(() => {
    const query = labelInput.toLowerCase().trim();
    return allExistingLabels.filter(
      (label) => label.toLowerCase().includes(query) && !labels.includes(label),
    );
  }, [labelInput, allExistingLabels, labels]);

  const suggestionsOpen = showSuggestions && filteredSuggestions.length > 0;

  // Portaled to document.body (see render below), so measure and position against
  // the visible field rather than relying on an in-flow absolute offset that would
  // be clipped by an ancestor `overflow: hidden` / `overflow-y-auto`.
  const { style: popoverStyle, placement } = usePopoverPosition(containerRef, suggestionsRef, suggestionsOpen, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
  });

  useLayoutEffect(() => {
    if (suggestionsOpen && containerRef.current) {
      setTriggerWidth(containerRef.current.getBoundingClientRect().width);
    }
  }, [suggestionsOpen]);

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

  const addLabel = (label: string) => {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed)) {
      setLabels([...labels, trimmed]);
    }
    setLabelInput('');
    setShowSuggestions(false);
    labelInputRef.current?.focus();
  };

  const removeLabel = (label: string) => {
    setLabels(labels.filter((existingLabel) => existingLabel !== label));
  };

  const handleLabelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (labelInput.trim()) {
        addLabel(labelInput);
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
          return (
            <Pill
              key={label}
              size="sm"
              className={color ? 'bg-surface-control/60 font-medium' : 'bg-surface-raised text-fg-secondary font-medium border border-edge-input'}
              style={color ? { color } : undefined}
            >
              {label}
              <button
                type="button"
                onClick={() => removeLabel(label)}
                className="ml-px rounded-full hover:bg-black/20 p-0.5 opacity-60 hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </Pill>
          );
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
              addLabel(labelInput);
            }
          }}
          onKeyDown={handleLabelKeyDown}
          placeholder={labels.length === 0 ? 'Type to add...' : ''}
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
        style={{ ...popoverStyle, width: triggerWidth }}
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
            className="w-full px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40"
            data-testid="label-suggestion"
          >
            {suggestion}
          </button>
        ))}
      </OverlayPopover>
    </div>
  );
}
