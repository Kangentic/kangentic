import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { OverlayPopover } from '../OverlayPopover';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';

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
  const [triggerWidth, setTriggerWidth] = useState<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Portaled to document.body (see render below), so measure and position against
  // the visible field rather than relying on an in-flow absolute offset that would
  // be clipped by an ancestor `overflow: hidden` / `overflow-y-auto` (the
  // task-detail edit scroller, the settings panel body, the board manager).
  const { style: popoverStyle, placement } = usePopoverPosition(containerRef, menuRef, showSuggestions, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
  });

  // The fixed-strategy popover lost the old `left-0 right-0` in-flow stretch, so
  // the trigger width has to be measured and applied explicitly.
  useLayoutEffect(() => {
    if (showSuggestions && containerRef.current) {
      setTriggerWidth(containerRef.current.getBoundingClientRect().width);
    }
  }, [showSuggestions]);

  useEffect(() => {
    // The menu is portaled OUT of containerRef, so a click inside it must also
    // count as "inside" - otherwise this capture-phase listener unmounts the
    // option before its own click fires and the selection silently no-ops.
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current && !containerRef.current.contains(event.target as Node) &&
        (!menuRef.current || !menuRef.current.contains(event.target as Node))
      ) {
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
      // menuRef, not containerRef: the options live in a body portal now.
      (menuRef.current?.querySelector(NAVIGABLE_SELECTOR) as HTMLButtonElement)?.focus();
    }
  };

  const focusAdjacentOption = (current: HTMLButtonElement, delta: number) => {
    const navigable = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(NAVIGABLE_SELECTOR) ?? [],
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
      {/* `surface-control`, matching FIELD_CONTROL_BASE: this is an input, not a
          text-bearing card. See the note there for the split. */}
      <div className="flex items-center gap-0 border border-edge-input rounded bg-surface-control">
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
          // `fg-tertiary`, matching FIELD_CONTROL_BASE: see the note there on
          // why value text steps down rather than the fill stepping up.
          className={`flex-1 bg-transparent px-3 py-1.5 text-sm text-fg-tertiary focus:outline-none disabled:cursor-not-allowed ${
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

      {/* Portaled to escape clipping ancestors (the task-detail window's
          overflow-y-auto edit form, the settings panel body, the board manager
          scroller). z-[2147483646] rather than z-50 because BaseDialog is
          itself z-50 and this now renders as a sibling of it under <body>. */}
      <OverlayPopover
        open={showSuggestions}
        popoverRef={menuRef}
        style={{ ...popoverStyle, width: triggerWidth }}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] bg-surface-raised border border-edge rounded shadow-lg max-h-48 overflow-y-auto py-1"
        data-testid={`${testId}-menu`}
      >
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
      </OverlayPopover>
    </div>
  );
}
