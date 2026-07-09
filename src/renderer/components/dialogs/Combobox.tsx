import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  /** Currently selected value, or '' for "nothing selected / inherit". */
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  /** Shown as placeholder text when value is ''. */
  placeholder?: string;
  className?: string;
  testId?: string;
  /** Fired each time the dropdown opens (focus or chevron click). */
  onOpen?: () => void;
  /**
   * Whether the clear (X) button appears when a value is set. Default true.
   * Set false for a field that always has a concrete value with no inherit
   * state (e.g. the project's own Default Agent picker).
   */
  allowClear?: boolean;
  disabled?: boolean;
  /**
   * How the placeholder reads when value is ''. 'resolved' (default) renders
   * it at full text weight because it names a concrete value that will
   * actually run (an inherited agent/permission, or a project default the
   * caller resolved). 'muted' is a faint hint for the literal case where
   * nothing is configured at any tier and the placeholder is just the
   * generic "Agent default" fallback text - callers pass 'muted' only when
   * their own fallback computation bottomed out with no concrete value.
   */
  placeholderVariant?: 'resolved' | 'muted';
}

const NAVIGABLE_SELECTOR = '[data-combobox-option]';

/**
 * Generic searchable dropdown for a CLOSED set of options (effort levels,
 * permission modes, agent names): a text input shows the selected option's
 * label, or the resolved inherited default at full text weight when empty -
 * an inherited value is exactly what will run, not a vague hint, so it
 * reads as selected rather than muted. Focus/click opens a filterable list;
 * typing filters it but never becomes
 * the value itself - a selection only commits via click or Enter/keyboard on
 * a list item. This is the closed-enumeration counterpart to `ModelCombobox`,
 * whose free-form model ids ARE valid values just by typing them.
 *
 * Used wherever a field shows an inherited default alongside concrete
 * overrides: New Task Advanced / task-detail edit, the column manager, and
 * Project Settings (Settings > Agent).
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = 'Default',
  className = '',
  testId = 'combobox',
  onOpen,
  allowClear = true,
  disabled = false,
  placeholderVariant = 'resolved',
}: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? value,
    [options, value],
  );
  const searchQuery = filterText.toLowerCase();
  const filteredOptions = useMemo(
    () => options.filter((option) =>
      option.label.toLowerCase().includes(searchQuery) || option.value.toLowerCase().includes(searchQuery)),
    [options, searchQuery],
  );

  // Displayed text: the live filter while the dropdown is open (even if it
  // doesn't match anything yet - the user is mid-type), otherwise the
  // selected option's label (or '' -> placeholder).
  const displayValue = isOpen ? filterText : selectedLabel;
  const showSuggestions = isOpen && options.length > 0;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setFilterText('');
      }
    };
    if (isOpen) {
      // Capture phase: BaseDialog stops mousedown propagation on its content
      // wrapper, so a bubble-phase document listener never fires for clicks
      // inside the dialog. Mirrors ModelCombobox.
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }
  }, [isOpen]);

  const handleInputChange = (newValue: string) => {
    setFilterText(newValue);
    setIsOpen(true);
  };

  const handleSelectOption = (optionValue: string) => {
    onChange(optionValue);
    setFilterText('');
    setIsOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setFilterText('');
    inputRef.current?.focus();
  };

  const handleToggleDropdown = () => {
    if (isOpen) {
      setIsOpen(false);
      setFilterText('');
    } else {
      setIsOpen(true);
      onOpen?.();
      inputRef.current?.focus();
    }
  };

  const handleInputFocus = () => {
    if (!disabled && options.length > 0) {
      setIsOpen(true);
      onOpen?.();
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'Enter') {
      // Closed enumeration: typed text alone never commits as a value - just
      // close and revert the display to the current selection.
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'ArrowDown' && showSuggestions) {
      e.preventDefault();
      inputRef.current?.blur();
      (containerRef.current?.querySelector(NAVIGABLE_SELECTOR) as HTMLButtonElement)?.focus();
    }
  };

  const focusAdjacentOption = (current: HTMLButtonElement, delta: number) => {
    const navigable = Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>(NAVIGABLE_SELECTOR) ?? [],
    );
    const currentIndex = navigable.indexOf(current);
    const next = navigable[currentIndex + delta];
    if (next) {
      next.focus();
    } else if (delta < 0) {
      inputRef.current?.focus();
    }
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAdjacentOption(e.currentTarget, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAdjacentOption(e.currentTarget, -1);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setFilterText('');
      inputRef.current?.focus();
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}${disabled ? ' opacity-60' : ''}`}>
      <div className="flex items-center gap-0 border border-edge-input rounded bg-surface">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={handleInputFocus}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          disabled={disabled}
          className={`flex-1 bg-transparent px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed ${
            placeholderVariant === 'muted' ? 'placeholder-fg-faint' : 'placeholder-fg'
          }`}
        />
        {allowClear && value && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1 text-fg-faint hover:text-fg-muted transition-colors flex-shrink-0"
            title="Clear"
            aria-label="Clear"
          >
            <X size={16} />
          </button>
        )}
        {options.length > 0 && (
          <button
            type="button"
            onClick={handleToggleDropdown}
            disabled={disabled}
            className="p-1.5 text-fg-muted hover:text-fg transition-colors flex-shrink-0 border-l border-edge-input disabled:cursor-not-allowed"
            title={isOpen ? 'Close dropdown' : 'Open dropdown'}
            aria-label={isOpen ? 'Close dropdown' : 'Open dropdown'}
          >
            <ChevronDown
              size={16}
              className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-raised border border-edge rounded shadow-lg z-50 max-h-48 overflow-y-auto py-1">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                data-combobox-option
                data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                onClick={() => handleSelectOption(option.value)}
                onKeyDown={handleOptionKeyDown}
                title={option.label}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors truncate ${
                  option.value === value ? 'text-fg font-medium' : 'text-fg-muted'
                }`}
              >
                {option.label}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-fg-faint text-center">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}
