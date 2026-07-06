import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { groupModelIds } from '../../../shared/model-id';
import { modelContextBadgeLabel } from '../../utils/format-tokens';

interface ModelComboboxProps {
  value: string;
  onChange: (value: string) => void;
  availableModels: string[];
  placeholder?: string;
  className?: string;
  testId?: string;
  /** Fired each time the dropdown is opened (focus or chevron). Callers use it
   *  to kick off an on-demand model rescan so a newly shipped model appears
   *  without a restart. Non-blocking: the dropdown opens immediately with the
   *  current list and re-renders if the rescan surfaces anything new. */
  onOpen?: () => void;
  /** Empirically-observed context-window size (tokens) per BASE model id, from
   *  `useModelContextWindows`. Renders a right-aligned size badge (1M / 200K)
   *  on rows that have no selectable `[1m]` variant chip. Absent entries render
   *  no badge (the window is discovered from telemetry, never hardcoded). */
  contextWindows?: Record<string, number>;
}

// Vertically-navigable suggestion buttons: model options plus the pinned
// builds toggle. 1M chips sit outside the vertical order and are reached
// with ArrowRight/ArrowLeft inside their row.
const NAVIGABLE_SELECTOR = '[data-model-option], [data-model-pinned-toggle]';

export function ModelCombobox({
  value,
  onChange,
  availableModels,
  placeholder = 'Default',
  className = '',
  testId = 'model-combobox',
  onOpen,
  contextWindows = {},
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayValue = value || '';
  const searchQuery = filterText.toLowerCase();

  // One row per base model: [1m] variants collapse onto their base row as a
  // 1M chip and dated pins are demoted to the bottom section. Every selectable
  // value stays the exact discovered string (it is the spawn value).
  const modelGroups = useMemo(() => groupModelIds(availableModels), [availableModels]);

  const matchesQuery = (model: string) => model.toLowerCase().includes(searchQuery);
  const filteredGroups = modelGroups.filter(
    (group) =>
      matchesQuery(group.primaryId) ||
      (group.oneMillionId !== null && matchesQuery(group.oneMillionId)),
  );
  const filteredPinned = modelGroups
    .flatMap((group) => group.pinnedBuildIds)
    .filter((model) => searchQuery.length === 0 || matchesQuery(model));
  // When the query only matches pinned builds (e.g. typing a date), surface
  // them even though the section is collapsed by default.
  const autoExpandPinned =
    searchQuery.length > 0 && filteredGroups.length === 0 && filteredPinned.length > 0;
  const showPinnedExpanded = pinnedExpanded || autoExpandPinned;

  const showSuggestions = isOpen && availableModels.length > 0;

  useEffect(() => {
    if (!isOpen) setPinnedExpanded(false);
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setFilterText('');
      }
    };

    if (isOpen) {
      // Capture phase: BaseDialog stops mousedown propagation on its content
      // wrapper, so a bubble-phase document listener never fires for clicks
      // inside the dialog. Capturing the event before it reaches the dialog
      // wrapper lets us close the menu when the user clicks any other field
      // in the same dialog.
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }
  }, [isOpen]);

  const handleInputChange = (newValue: string) => {
    onChange(newValue);
    setFilterText(newValue);
    setIsOpen(true);
  };

  const handleSelectModel = (model: string) => {
    onChange(model);
    setFilterText('');
    setIsOpen(false);
    // Do NOT refocus the input here - handleInputFocus auto-reopens the
    // dropdown when models are available, which would cancel the close.
    // The user has made their choice; let focus settle wherever the click
    // landed.
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
    if (availableModels.length > 0) {
      setIsOpen(true);
      onOpen?.();
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'Enter') {
      // Accept typed value and close dropdown
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'ArrowDown' && showSuggestions) {
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
    } else if (e.key === 'ArrowRight') {
      const chip = e.currentTarget
        .closest('[data-model-row]')
        ?.querySelector<HTMLButtonElement>('[data-model-1m]');
      if (chip) {
        e.preventDefault();
        chip.focus();
      }
    }
  };

  const handleChipKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const primary = e.currentTarget
      .closest('[data-model-row]')
      ?.querySelector<HTMLButtonElement>('[data-model-option]');
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      primary?.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && primary) {
      e.preventDefault();
      focusAdjacentOption(primary, e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
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
          className="flex-1 bg-transparent px-3 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none"
        />
        {displayValue && (
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
        {availableModels.length > 0 && (
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
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-raised border border-edge rounded shadow-lg z-50 max-h-48 overflow-y-auto">
          {filteredGroups.length > 0 || filteredPinned.length > 0 ? (
            <div className="py-1">
              {filteredGroups.map((group) => {
                const oneMillionId = group.oneMillionId;
                // Right-aligned context-size badge (1M / 200K). See
                // modelContextBadgeLabel: a `[1m]`-only row badges "1M" from its id
                // alone, a row with a selectable `[1m]` chip is suppressed, and
                // everything else uses the telemetry-learned window (absent -> none).
                const contextLabel = modelContextBadgeLabel(group, contextWindows);
                return (
                  <div key={group.primaryId} data-model-row className="flex items-center">
                    <button
                      type="button"
                      data-model-option
                      onClick={() => handleSelectModel(group.primaryId)}
                      onKeyDown={handleOptionKeyDown}
                      className="flex-1 min-w-0 text-left px-3 py-1.5 text-sm text-fg hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors truncate"
                    >
                      {group.primaryId}
                    </button>
                    {contextLabel && (
                      <span
                        data-model-context-window
                        title={`${contextLabel} context window`}
                        className="mr-2 px-1.5 py-0.5 text-[11px] rounded border border-edge text-fg-faint flex-shrink-0"
                      >
                        {contextLabel}
                      </span>
                    )}
                    {oneMillionId !== null && (
                      <button
                        type="button"
                        data-model-1m
                        onClick={() => handleSelectModel(oneMillionId)}
                        onKeyDown={handleChipKeyDown}
                        title={oneMillionId}
                        className="mr-2 px-1.5 py-0.5 text-[11px] rounded border border-edge text-fg-muted hover:text-fg hover:border-fg-faint focus:outline focus:outline-1 focus:outline-fg-faint transition-colors flex-shrink-0"
                      >
                        1M
                      </button>
                    )}
                  </div>
                );
              })}
              {filteredPinned.length > 0 && (
                <div className="border-t border-edge mt-1 pt-1">
                  {/* During auto-expand (a query that matches only pinned builds)
                      the section is forced open, so the toggle cannot collapse
                      anything: hide the dead control rather than render it inert. */}
                  {!autoExpandPinned && (
                    <button
                      type="button"
                      data-model-pinned-toggle
                      onClick={() => setPinnedExpanded((previous) => !previous)}
                      onKeyDown={handleOptionKeyDown}
                      className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-fg-faint hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors"
                    >
                      <ChevronDown
                        size={12}
                        className={`transition-transform ${showPinnedExpanded ? '' : '-rotate-90'}`}
                      />
                      Pinned builds ({filteredPinned.length})
                    </button>
                  )}
                  {showPinnedExpanded &&
                    filteredPinned.map((model) => (
                      <button
                        key={model}
                        type="button"
                        data-model-option
                        data-model-pinned-option
                        onClick={() => handleSelectModel(model)}
                        onKeyDown={handleOptionKeyDown}
                        className="w-full text-left pl-7 pr-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors truncate"
                      >
                        {model}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-fg-faint text-center">
              No models match "{filterText}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
