import { useState, useRef, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { Pill } from './Pill';

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
  const labelInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const filteredSuggestions = useMemo(() => {
    const query = labelInput.toLowerCase().trim();
    return allExistingLabels.filter(
      (label) => label.toLowerCase().includes(query) && !labels.includes(label),
    );
  }, [labelInput, allExistingLabels, labels]);

  // Close suggestions on click outside
  useEffect(() => {
    if (!showSuggestions) return;
    const handleClick = (event: MouseEvent) => {
      if (
        suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
        labelInputRef.current && !labelInputRef.current.contains(event.target as Node)
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
    <div className="flex-1 relative">
      <label className="text-xs text-fg-muted mb-1 block">Labels</label>
      <div className="flex flex-wrap items-center gap-1 bg-surface border border-edge-input rounded px-2 py-1 min-h-[32px] focus-within:border-accent">
        {labels.map((label) => {
          const color = labelColors[label];
          return (
            <Pill
              key={label}
              size="sm"
              className={color ? 'bg-surface-hover/60 font-medium' : 'bg-surface-raised text-fg-secondary font-medium border border-edge-input'}
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
          className="flex-1 min-w-[80px] bg-transparent text-xs text-fg placeholder-fg-faint outline-none py-0.5"
          data-testid={testId}
        />
      </div>

      {/* Label suggestions dropdown */}
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute z-50 left-0 right-0 mt-1 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 max-h-[150px] overflow-y-auto"
        >
          {filteredSuggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => addLabel(suggestion)}
              className="w-full px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
