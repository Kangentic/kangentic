import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';

interface FontComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Detected system fonts (monospace-filtered when available; see
   *  FontResolver). Empty when enumeration is unsupported or fails - the
   *  field then behaves exactly like a plain text input. */
  fonts: string[];
  placeholder?: string;
  className?: string;
  testId?: string;
}

const NAVIGABLE_SELECTOR = '[data-font-option]';

/**
 * Free-typing font-family picker: a text input whose typed value always
 * commits directly (unlike the closed-enumeration `Combobox`), backed by a
 * filterable suggestion list of detected system fonts. This is the
 * font-specific counterpart to `ModelCombobox` - a font not present in
 * `fonts` (a stale detection, or an empty list when enumeration failed) is
 * still a valid typed value, so the picker never blocks entry the way a
 * closed dropdown would.
 */
export function FontCombobox({
  value,
  onChange,
  fonts,
  placeholder = 'Menlo, Consolas, "Courier New", monospace',
  className = '',
  testId = 'font-combobox',
}: FontComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  // `null` means "not typed since opening" (show the committed `value`); any
  // string - INCLUDING the empty string when the user clears the field - is
  // the live edit. Distinguishing the two matters because `onChange` persists
  // through an async IPC round trip, so `value` lags a just-cleared field by a
  // render; falling back to `value` on an empty string would snap the input
  // back to the stale font name mid-edit.
  const [filterText, setFilterText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayValue = isOpen && filterText !== null ? filterText : value;
  const searchQuery = (isOpen && filterText !== null ? filterText : '').toLowerCase();
  const filteredFonts = useMemo(
    () => fonts.filter((font) => font.toLowerCase().includes(searchQuery)),
    [fonts, searchQuery],
  );
  const showSuggestions = isOpen && fonts.length > 0;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setFilterText(null);
      }
    };
    if (isOpen) {
      // Capture phase: BaseDialog stops mousedown propagation on its content
      // wrapper, so a bubble-phase document listener never fires for clicks
      // inside the dialog. Mirrors Combobox / ModelCombobox.
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }
  }, [isOpen]);

  const handleInputChange = (newValue: string) => {
    onChange(newValue);
    setFilterText(newValue);
    setIsOpen(true);
  };

  const handleSelectFont = (font: string) => {
    onChange(font);
    setFilterText(null);
    setIsOpen(false);
  };

  const handleToggleDropdown = () => {
    if (isOpen) {
      setIsOpen(false);
      setFilterText(null);
    } else {
      setIsOpen(true);
      inputRef.current?.focus();
    }
  };

  const handleInputFocus = () => {
    if (fonts.length > 0) setIsOpen(true);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setFilterText(null);
    } else if (event.key === 'Enter') {
      setIsOpen(false);
      setFilterText(null);
    } else if (event.key === 'ArrowDown' && showSuggestions) {
      event.preventDefault();
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

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAdjacentOption(event.currentTarget, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAdjacentOption(event.currentTarget, -1);
    } else if (event.key === 'Escape') {
      setIsOpen(false);
      setFilterText(null);
      inputRef.current?.focus();
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="flex items-center gap-0 border border-edge-input rounded bg-surface">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={(event) => handleInputChange(event.target.value)}
          onFocus={handleInputFocus}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          className="flex-1 bg-transparent px-3 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none"
        />
        {fonts.length > 0 && (
          <button
            type="button"
            onClick={handleToggleDropdown}
            className="p-1.5 text-fg-muted hover:text-fg transition-colors flex-shrink-0 border-l border-edge-input"
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
          {filteredFonts.length > 0 ? (
            filteredFonts.map((font) => (
              <button
                key={font}
                type="button"
                data-font-option
                data-testid={`${testId}-option-${font}`}
                onClick={() => handleSelectFont(font)}
                onKeyDown={handleOptionKeyDown}
                title={font}
                style={{ fontFamily: font }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors truncate ${
                  font === value ? 'text-fg font-medium' : 'text-fg-muted'
                }`}
              >
                {font}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-fg-faint text-center">No fonts match "{filterText}"</div>
          )}
        </div>
      )}
    </div>
  );
}
