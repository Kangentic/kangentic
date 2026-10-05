import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { newerModelFor, planModelPickerRows, type ModelDisplayGroup } from '../../../shared/model-id';
import type { ModelAliasOption } from '../../../shared/types';
import {
  aliasRowView,
  buildOfferedIdsByDisplayName,
  MODEL_ALIAS_GROUP_HEADING,
  modelAliasTitle,
  modelContextBadgeLabel,
  modelRowLabel,
  modelVersionSectionLabel,
} from '../../utils/format-tokens';
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
  /** Floating selectors from `useModelAliases`, listed in a "Latest" group
   *  above the specific versions. Empty keeps the list exactly as it was. */
  modelAliases?: ModelAliasOption[];
  /**
   * How the placeholder reads when value is ''. 'resolved' (default) renders
   * it at full text weight because it names a concrete model that will
   * actually run. 'muted' is a faint hint for the literal case where no
   * model is configured at any tier and the placeholder is just the generic
   * "Agent default" fallback text.
   */
  placeholderVariant?: 'resolved' | 'muted';
}

const NO_ALIASES: ModelAliasOption[] = [];
const NO_DISPLAY_NAMES: Record<string, string> = {};

/**
 * On close, rewrite text the user typed into the id the agent CLI accepts
 * (see `typedTextRef`), then forget it. The rewrite lands only when the text
 * is the display name of a value this agent actually offers, so another
 * agent's model typed as "Gemini 2.5" is never turned into an id it does not
 * have. Takes refs so the close paths inside once-per-open listeners always
 * see the latest typing, callback, and options (a rescan can land while the
 * menu is open).
 */
function commitNormalizedTypedValue(
  typedTextRef: React.MutableRefObject<string>,
  onChangeRef: React.MutableRefObject<(value: string) => void>,
  offeredIdsByNameRef: React.MutableRefObject<ReadonlyMap<string, string>>,
): void {
  const typed = typedTextRef.current;
  typedTextRef.current = '';
  if (!typed) return;
  const offeredId = offeredIdsByNameRef.current.get(typed.trim().toLowerCase());
  if (offeredId !== undefined && offeredId !== typed) onChangeRef.current(offeredId);
}

// Vertically-navigable suggestion buttons: model options (alias rows included)
// plus the versions toggle. 1M chips sit outside the vertical order and are
// reached with ArrowRight/ArrowLeft inside their row.
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
  modelDisplayNames = NO_DISPLAY_NAMES,
  modelAliases = NO_ALIASES,
  placeholderVariant = 'resolved',
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Set around a programmatic refocus of the input so `handleInputFocus` does
  // not reopen the menu (and fire `onOpen`, a model rescan, again) for a focus
  // the user did not give it. See the Escape listener below.
  const suppressOpenOnFocusRef = useRef(false);
  // What the user typed since the menu opened. Typed text is committed on every
  // keystroke, so when the menu closes a row's display name is rewritten to
  // that row's id: "Opus" -> `opus`, "Opus 5.5" -> `claude-opus-5-5`. Without
  // it a typed "Opus" would read exactly like the alias row and then fail at
  // spawn. A ref, because the close paths include listeners registered once
  // per open.
  const typedTextRef = useRef('');
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  // Every value the rows can select, alias ids included, keyed by display
  // name: the typed-text rewrite above only lands on one of these.
  const offeredIdsByNameRef = useRef<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    offeredIdsByNameRef.current = buildOfferedIdsByDisplayName(
      [...availableModels, ...modelAliases.map((alias) => alias.id)],
      modelDisplayNames,
    );
  }, [availableModels, modelAliases, modelDisplayNames]);

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
  // An alias value reads as its bare family name ("Opus"); the hover names
  // the version it runs today.
  const valueTitle = value ? modelAliasTitle(value, modelAliases, modelDisplayNames) : null;

  // Floating aliases first, then any current version no alias covers, then
  // one collapsed section with every specific version: [1m] variants collapse
  // onto their base row as a 1M chip, dated pins and superseded generations
  // sit in the section, and (with aliases) so do the current versions an alias
  // already runs. Every selectable value stays the exact discovered string.
  const pickerRows = useMemo(
    () => planModelPickerRows(availableModels, modelAliases),
    [availableModels, modelAliases],
  );
  const hasAliases = pickerRows.aliasRows.length > 0;
  const hasOptions = availableModels.length > 0 || hasAliases;
  // A value one generation behind (e.g. a column pinned to Sonnet 5 while
  // Sonnet 5.5 is known) says so on its own row.
  const newerThanValue = useMemo(
    () => (value ? newerModelFor(value, availableModels) : null),
    [value, availableModels],
  );

  const matchesQuery = (model: string) =>
    model.toLowerCase().includes(searchQuery) ||
    modelRowLabel(model, modelDisplayNames).toLowerCase().includes(searchQuery);
  const groupMatches = (group: ModelDisplayGroup) =>
    matchesQuery(group.primaryId) || (group.oneMillionId !== null && matchesQuery(group.oneMillionId));

  const filteredAliasRows = pickerRows.aliasRows.filter(
    (alias) => matchesQuery(alias.id) || (alias.resolvesTo !== undefined && matchesQuery(alias.resolvesTo)),
  );
  const filteredGroups = pickerRows.topGroups.filter(groupMatches);
  const filteredDemotedRows = pickerRows.versionRows.filter((row) =>
    row.kind === 'group' ? groupMatches(row.group) : matchesQuery(row.id),
  );

  // When the query only matches the collapsed section (e.g. typing an older
  // version or a pin's date), surface it even though the section is collapsed
  // by default. The toggle is hidden in this state (it cannot collapse a
  // force-open section).
  const autoExpandPinned =
    searchQuery.length > 0 &&
    filteredAliasRows.length === 0 &&
    filteredGroups.length === 0 &&
    filteredDemotedRows.length > 0;
  const showPinnedExpanded = pinnedExpanded || autoExpandPinned;

  const showSuggestions = isOpen && hasOptions;

  // Portaled to document.body (see render below), so measure and position against
  // the visible field rather than relying on an in-flow absolute offset that would
  // be clipped by an ancestor `overflow: hidden` / `overflow-y-auto` (the
  // task-detail edit scroller, the settings panel body, the board manager).
  // `matchTriggerWidth` replaces the old `left-0 right-0` in-flow stretch; the
  // hook applies it before it measures. Model often sits in a half-width
  // column, which makes a missing width obvious.
  const { style: popoverStyle, placement } = usePopoverPosition(containerRef, menuRef, showSuggestions, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
    matchTriggerWidth: true,
  });

  // Seed the expanded state only on the open transition (reading value and
  // the section's selectable ids from this render); re-running on every
  // keystroke while open would fight a manual collapse. A task/column already
  // set to a specific version opens with the section expanded instead of
  // hiding the current selection behind a collapsed toggle. A render-time
  // adjustment on the transition (React's "adjusting state when a prop
  // changes" pattern) rather than an effect, so the menu never paints a frame
  // in the wrong state.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    setPinnedExpanded(isOpen && Boolean(value) && pickerRows.versionSelectableIds.has(value));
  }

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
        commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
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

  // Escape while the menu is showing closes the menu and nothing else. The
  // host's dismiss listener (SettingsPanelShell, BaseDialog) is a bubble-phase
  // keydown on `document`, so a React key handler that only closed the menu let
  // the same keystroke close the panel or dialog underneath it. Capture-phase on
  // `document` wins the event ahead of the host; gated on a visible menu so a
  // plain Escape on a closed combobox still reaches the host. Mirrors
  // BranchPicker (LabelInput gets the same result from a `stopPropagation` in
  // its input's own key handler, since its suggestions never take keyboard
  // focus). Covers every focusable in the menu (rows, the 1M chips, the
  // versions toggle) without a handler on each.
  useEffect(() => {
    if (!showSuggestions) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // A menu child held focus: hand it back to the input. The suppress flag
      // keeps `handleInputFocus` from reopening the menu on that focus (the
      // same reopen `handleSelectModel` avoids by not refocusing at all).
      if (menuRef.current?.contains(document.activeElement)) {
        suppressOpenOnFocusRef.current = true;
        inputRef.current?.focus();
        suppressOpenOnFocusRef.current = false;
      }
      commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
      setIsOpen(false);
      setFilterText('');
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [showSuggestions]);

  const handleInputChange = (newValue: string) => {
    typedTextRef.current = newValue;
    onChange(newValue);
    setFilterText(newValue);
    setIsOpen(true);
  };

  const handleSelectModel = (model: string) => {
    // A picked row is already an exact spawn value; it replaces any typing.
    typedTextRef.current = '';
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
    typedTextRef.current = '';
    onChange('');
    setFilterText('');
    inputRef.current?.focus();
  };

  const handleToggleDropdown = () => {
    if (isOpen) {
      commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
      setIsOpen(false);
      setFilterText('');
    } else {
      setIsOpen(true);
      onOpen?.();
      inputRef.current?.focus();
    }
  };

  const handleInputFocus = () => {
    if (suppressOpenOnFocusRef.current) return;
    if (hasOptions) {
      setIsOpen(true);
      onOpen?.();
    }
  };

  // Focus leaving the field and its menu (a Tab to the dialog's Create button)
  // fires none of the close paths, so it commits the typing here. Bound on the
  // container, where React's onBlur bubbles like focusout, because a forward
  // Tab leaves through the field's own Clear and chevron buttons, not the
  // input. A move within the field or into the menu (a row press) does not.
  const handleFieldBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextFocus = event.relatedTarget as Node | null;
    if (nextFocus && (menuRef.current?.contains(nextFocus) || containerRef.current?.contains(nextFocus))) return;
    commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Reached only with no menu showing (the capture listener above consumes
      // Escape while one is): reset, and let the host see the key.
      commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'Enter') {
      // Accept typed value (in the CLI's spelling) and close dropdown
      commitNormalizedTypedValue(typedTextRef, onChangeRef, offeredIdsByNameRef);
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

  // Escape on a row is handled by the capture listener above, which runs
  // before this handler could see the key.
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

  // "Sonnet 5.5 available" on the row that holds the current value, when a
  // newer generation of its family is known. Shown only there: it describes
  // the choice already made, not every older row.
  const renderNewerHint = (rowIds: Array<string | null>) =>
    newerThanValue !== null && rowIds.includes(value) ? (
      <span data-model-newer className="ml-auto pl-2 text-xs text-fg-faint flex-shrink-0">
        {modelRowLabel(newerThanValue, modelDisplayNames)} available
      </span>
    ) : null;

  // One floating alias: its bare family name in a fixed-width column so the
  // resolved versions line up, then the version it runs today, muted. No 1M
  // chip and no context badge: an alias names a family, not a window.
  const renderAliasRow = (alias: ModelAliasOption) => {
    const row = aliasRowView(alias, modelAliases, modelDisplayNames);
    return (
      <div key={alias.id} data-model-row className="flex items-center hover:bg-surface-hover transition-colors">
        <button
          type="button"
          data-model-option
          data-model-alias={alias.id}
          onClick={() => handleSelectModel(alias.id)}
          onKeyDown={handleOptionKeyDown}
          title={row.title}
          className="flex-1 min-w-0 flex items-center gap-3 text-left px-3 py-1.5 text-sm text-fg focus:bg-surface-hover focus:outline-none"
        >
          <span className="min-w-16 truncate">{row.label}</span>
          {row.target !== null && (
            <span data-model-alias-target className="text-xs text-fg-faint truncate">
              {row.target}
            </span>
          )}
        </button>
      </div>
    );
  };

  // Shared row markup for a full model group (primary button + optional
  // context badge + optional 1M chip), reused for the top-level list and for
  // a generation inside the collapsed section (`indent` matches it visually
  // to the plain dated-pin rows in that same section).
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
          className={`flex-1 min-w-0 flex items-center text-left py-1.5 text-sm focus:bg-surface-hover focus:outline-none ${
            indent ? 'pl-7 pr-3 text-fg-muted' : 'px-3 text-fg'
          }`}
        >
          <span className="truncate">{modelRowLabel(group.primaryId, modelDisplayNames)}</span>
          {renderNewerHint([group.primaryId, oneMillionId])}
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

  const hasAnyRow = filteredAliasRows.length > 0 || filteredGroups.length > 0 || filteredDemotedRows.length > 0;

  return (
    <div ref={containerRef} className={`relative ${className}`} onBlur={handleFieldBlur}>
      <div className="flex items-center gap-0 border border-edge-input rounded bg-surface-control">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={handleInputFocus}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          title={valueTitle ?? undefined}
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
        {hasOptions && (
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
        style={popoverStyle}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] bg-surface-raised border border-edge rounded shadow-lg max-h-[min(16rem,var(--popover-available-height,16rem))] overflow-y-auto"
        data-testid={`${testId}-menu`}
      >
        {hasAnyRow ? (
          <div className="py-1">
            {filteredAliasRows.length > 0 && (
              <div data-model-alias-group>
                <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-fg-faint">{MODEL_ALIAS_GROUP_HEADING}</div>
                {filteredAliasRows.map(renderAliasRow)}
              </div>
            )}
            {filteredGroups.length > 0 && (
              <div className={filteredAliasRows.length > 0 ? 'border-t border-edge mt-1 pt-1' : undefined}>
                {filteredGroups.map((group) => renderGroupRow(group, false))}
              </div>
            )}
            {filteredDemotedRows.length > 0 && (
              <div className="border-t border-edge mt-1 pt-1">
                {/* During auto-expand (a query that matches only the section)
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
                    {modelVersionSectionLabel(hasAliases)} ({filteredDemotedRows.length})
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
                        className="w-full flex items-center text-left pl-7 pr-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors"
                      >
                        <span className="truncate">{modelRowLabel(row.id, modelDisplayNames)}</span>
                        {renderNewerHint([row.id])}
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
