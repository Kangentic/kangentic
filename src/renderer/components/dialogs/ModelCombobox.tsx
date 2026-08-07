import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { groupModelIds, type ModelDisplayGroup } from '../../../shared/model-id';
import { modelContextBadgeLabel, modelRowLabel } from '../../utils/format-tokens';
import { OverlayPopover } from '../OverlayPopover';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';

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
  /** Friendly display name per model id, from `useModelDisplayNames`. A row
   *  without an entry falls back to its raw id (see `modelRowLabel`). */
  modelDisplayNames?: Record<string, string>;
  /**
   * How the placeholder reads when value is ''. 'resolved' (default) renders
   * it at full text weight because it names a concrete model that will
   * actually run. 'muted' is a faint hint for the literal case where no
   * model is configured at any tier and the placeholder is just the generic
   * "Agent default" fallback text.
   */
  placeholderVariant?: 'resolved' | 'muted';
}

// Vertically-navigable suggestion buttons: model options plus the older-versions
// toggle. 1M chips sit outside the vertical order and are reached with
// ArrowRight/ArrowLeft inside their row.
const NAVIGABLE_SELECTOR = '[data-model-option], [data-model-pinned-toggle]';

/** A row demoted to the "Older versions" section: either a whole superseded
 *  generation (keeps its 1M chip / context badge) or a bare dated pin. Both
 *  are sorted together by their selectable id, so a superseded alias renders
 *  directly above its own dated pins and families stay clustered. */
type DemotedRow = { kind: 'group'; group: ModelDisplayGroup; sortId: string } | { kind: 'pin'; id: string; sortId: string };

export function ModelCombobox({
  value,
  onChange,
  availableModels,
  placeholder = 'Default',
  className = '',
  testId = 'model-combobox',
  onOpen,
  contextWindows = {},
  modelDisplayNames = {},
  placeholderVariant = 'resolved',
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The committed value's friendly label (matches the dropdown rows and the
  // inherited-default placeholder, both of which already go through
  // modelRowLabel) - shown whenever the user isn't actively typing, so
  // opening the dropdown on an already-selected value doesn't flash to the
  // raw id. Once typing starts, filterText (not value, which for an async
  // caller like a project-default setter can lag a keystroke behind) takes
  // over as the displayed text - matching (see matchesQuery below) checks
  // the raw id AND the friendly label, so filtering by either still works.
  const selectedLabel = value ? modelRowLabel(value, modelDisplayNames) : '';
  const displayValue = isOpen ? (filterText || selectedLabel) : selectedLabel;
  const searchQuery = filterText.toLowerCase();

  // One row per base model: [1m] variants collapse onto their base row as a 1M
  // chip, dated pins are demoted to the bottom section, and a superseded
  // generation (an older Opus/Sonnet/Haiku version whose family has a newer
  // one) is demoted alongside them. Every selectable value stays the exact
  // discovered string (it is the spawn value).
  const modelGroups = useMemo(() => groupModelIds(availableModels), [availableModels]);
  const latestGroups = useMemo(() => modelGroups.filter((group) => !group.isSuperseded), [modelGroups]);
  const supersededGroups = useMemo(() => modelGroups.filter((group) => group.isSuperseded), [modelGroups]);

  const matchesQuery = (model: string) =>
    model.toLowerCase().includes(searchQuery) ||
    modelRowLabel(model, modelDisplayNames).toLowerCase().includes(searchQuery);
  const groupMatches = (group: ModelDisplayGroup) =>
    matchesQuery(group.primaryId) || (group.oneMillionId !== null && matchesQuery(group.oneMillionId));

  const filteredGroups = latestGroups.filter(groupMatches);

  const demotedRows: DemotedRow[] = useMemo(() => {
    const rows: DemotedRow[] = supersededGroups.map((group) => ({
      kind: 'group',
      group,
      sortId: group.primaryId,
    }));
    for (const group of modelGroups) {
      for (const id of group.pinnedBuildIds) {
        rows.push({ kind: 'pin', id, sortId: id });
      }
    }
    return rows.sort((first, second) => first.sortId.localeCompare(second.sortId));
  }, [modelGroups, supersededGroups]);

  const filteredDemotedRows = demotedRows.filter((row) =>
    row.kind === 'group' ? groupMatches(row.group) : matchesQuery(row.id),
  );

  // When the query only matches demoted rows (e.g. typing an older version or
  // a pin's date), surface them even though the section is collapsed by
  // default. The toggle is hidden in this state (it cannot collapse a
  // force-open section).
  const autoExpandPinned =
    searchQuery.length > 0 && filteredGroups.length === 0 && filteredDemotedRows.length > 0;
  const showPinnedExpanded = pinnedExpanded || autoExpandPinned;

  const showSuggestions = isOpen && availableModels.length > 0;

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
  // the trigger width has to be measured and applied explicitly. Model often sits
  // in a half-width column, which makes a missing width obvious.
  useLayoutEffect(() => {
    if (showSuggestions && containerRef.current) {
      setTriggerWidth(containerRef.current.getBoundingClientRect().width);
    }
  }, [showSuggestions]);

  // Ids selectable from within the demoted section, so a task/column already
  // set to a superseded generation or a dated pin opens with the section
  // expanded instead of hiding the current selection behind a collapsed toggle.
  const demotedSelectableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of supersededGroups) {
      ids.add(group.primaryId);
      if (group.oneMillionId !== null) ids.add(group.oneMillionId);
    }
    for (const group of modelGroups) {
      for (const id of group.pinnedBuildIds) ids.add(id);
    }
    return ids;
  }, [modelGroups, supersededGroups]);

  useEffect(() => {
    if (!isOpen) {
      setPinnedExpanded(false);
      return;
    }
    if (value && demotedSelectableIds.has(value)) setPinnedExpanded(true);
    // Seed the expanded state only on the open transition (reading value and
    // demotedSelectableIds fresh from this render's closure); re-running on
    // every keystroke while open would fight a manual collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [isOpen]);

  useEffect(() => {
    // The menu is portaled OUT of containerRef, so a click inside it must also
    // count as "inside" - otherwise this capture-phase listener unmounts the
    // option before its own click fires and the selection silently no-ops.
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node) &&
        (!menuRef.current || !menuRef.current.contains(event.target as Node))
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
    } else if (e.key === 'ArrowRight') {
      const chip = e.currentTarget
        .closest('[data-model-row]')
        ?.querySelector<HTMLButtonElement>('[data-model-1m]');
      if (chip) {
        e.preventDefault();
        chip.focus();
      }
    } else if (e.key === 'Escape') {
      // Collapse the menu and hand focus back to the input, matching Combobox /
      // FontCombobox. NOTE: this does NOT keep the host dialog open. The event is
      // not stopped, and a dialog's Escape listener is bubble-phase on `document`
      // (BaseDialog.tsx), so it still fires and closes the dialog underneath -
      // verified against the task-detail window. Stopping that would need
      // `e.stopPropagation()` here and in the other two comboboxes, which is a
      // deliberate change to what Escape means inside a dialog, not a local fix.
      setIsOpen(false);
      setFilterText('');
      inputRef.current?.focus();
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

  // Shared row markup for a full model group (primary button + optional
  // context badge + optional 1M chip), reused for the top-level list and for
  // a superseded generation demoted into "Older versions" (`indent` matches
  // it visually to the plain dated-pin rows in that same section).
  const renderGroupRow = (group: ModelDisplayGroup, indent: boolean) => {
    const oneMillionId = group.oneMillionId;
    // Right-aligned context-size badge (1M / 200K). See modelContextBadgeLabel:
    // a `[1m]`-only row badges "1M" from its id alone, a row with a selectable
    // `[1m]` chip is suppressed, and everything else uses the
    // telemetry-learned window (absent -> none).
    const contextLabel = modelContextBadgeLabel(group, contextWindows);
    return (
      <div key={group.primaryId} data-model-row className="flex items-center hover:bg-surface-hover transition-colors">
        <button
          type="button"
          data-model-option
          onClick={() => handleSelectModel(group.primaryId)}
          onKeyDown={handleOptionKeyDown}
          title={group.primaryId}
          className={`flex-1 min-w-0 text-left py-1.5 text-sm focus:bg-surface-hover focus:outline-none truncate ${
            indent ? 'pl-7 pr-3 text-fg-muted' : 'px-3 text-fg'
          }`}
        >
          {modelRowLabel(group.primaryId, modelDisplayNames)}
        </button>
        {contextLabel && (
          <span
            data-model-context-window
            title={`${contextLabel} context window`}
            className="mr-2 px-1.5 py-0.5 text-[11px] rounded border border-edge bg-surface text-fg-faint flex-shrink-0"
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
            className="mr-2 px-1.5 py-0.5 text-[11px] rounded border border-edge bg-surface text-fg-muted hover:text-fg hover:border-fg-faint focus:outline focus:outline-1 focus:outline-fg-faint transition-colors flex-shrink-0"
          >
            1M
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
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
          className={`flex-1 bg-transparent px-3 py-1.5 text-sm text-fg focus:outline-none ${
            placeholderVariant === 'muted' ? 'placeholder-fg-faint' : 'placeholder-fg'
          }`}
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
        className="fixed z-[2147483646] bg-surface-raised border border-edge rounded shadow-lg max-h-48 overflow-y-auto"
        data-testid={`${testId}-menu`}
      >
        {filteredGroups.length > 0 || filteredDemotedRows.length > 0 ? (
          <div className="py-1">
            {filteredGroups.map((group) => renderGroupRow(group, false))}
            {filteredDemotedRows.length > 0 && (
              <div className="border-t border-edge mt-1 pt-1">
                {/* During auto-expand (a query that matches only demoted rows)
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
                    Older versions ({filteredDemotedRows.length})
                  </button>
                )}
                {showPinnedExpanded &&
                  filteredDemotedRows.map((row) =>
                    row.kind === 'group' ? (
                      renderGroupRow(row.group, true)
                    ) : (
                      <button
                        key={row.id}
                        type="button"
                        data-model-option
                        data-model-pinned-option
                        onClick={() => handleSelectModel(row.id)}
                        onKeyDown={handleOptionKeyDown}
                        title={row.id}
                        className="w-full text-left pl-7 pr-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors truncate"
                      >
                        {modelRowLabel(row.id, modelDisplayNames)}
                      </button>
                    ),
                  )}
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-fg-faint text-center">
            No models match "{filterText}"
          </div>
        )}
      </OverlayPopover>
    </div>
  );
}
