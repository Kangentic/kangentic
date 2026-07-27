import { useState, useEffect, useRef } from 'react';
import { Search, Filter, X } from 'lucide-react';
import { CountBadge } from './CountBadge';
import { FilterPopover } from './FilterPopover';
import { OverlayPopover } from './OverlayPopover';

interface ToolbarSearchFilterProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  /** Optional ref to the search input (e.g. so a keybind can focus it). */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  searchTestId: string;
  searchClearTestId: string;
  filterTestId: string;
  priorities: Array<{ label: string; color: string }>;
  priorityFilters: Set<number>;
  onTogglePriority: (index: number) => void;
  allLabels: string[];
  labelColors: Record<string, string>;
  labelFilters: Set<string>;
  onToggleLabel: (label: string) => void;
  onClearFilters: () => void;
}

/**
 * Shared toolbar control pairing a scoped text search with a priority/label
 * filter popover. Used by both the board and backlog toolbars (both rendered in
 * ViewToggle). Presentational: the filter values and the search value are owned
 * by the caller's store; this component owns only the popover open-state, its
 * refs, and click-outside dismissal. The "Filter" button styling mirrors the
 * search box (bordered, same height) so the pair reads as one group.
 */
export function ToolbarSearchFilter({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchInputRef,
  searchTestId,
  searchClearTestId,
  filterTestId,
  priorities,
  priorityFilters,
  onTogglePriority,
  allLabels,
  labelColors,
  labelFilters,
  onToggleLabel,
  onClearFilters,
}: ToolbarSearchFilterProps) {
  const [showFilterPopover, setShowFilterPopover] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);

  const hasActiveFilters = priorityFilters.size > 0 || labelFilters.size > 0;

  // Close the popover on click outside (button or popover).
  useEffect(() => {
    if (!showFilterPopover) return;
    const handleClick = (event: MouseEvent) => {
      if (
        filterPopoverRef.current && !filterPopoverRef.current.contains(event.target as Node) &&
        filterButtonRef.current && !filterButtonRef.current.contains(event.target as Node)
      ) {
        setShowFilterPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showFilterPopover]);

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="w-[21rem] bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-disabled pl-8 pr-8 py-1.5 outline-none focus:border-edge-input"
          data-testid={searchTestId}
          aria-label={searchPlaceholder}
        />
        {searchValue && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-muted transition-colors"
            aria-label="Clear search"
            data-testid={searchClearTestId}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="relative">
        <button
          ref={filterButtonRef}
          type="button"
          onClick={() => setShowFilterPopover(!showFilterPopover)}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded transition-colors ${
            hasActiveFilters
              ? 'text-accent-fg border-accent/50 bg-accent-bg/10'
              : 'text-fg-muted hover:text-fg border-edge/50 hover:bg-surface-hover/40'
          }`}
          data-testid={filterTestId}
        >
          <Filter size={14} />
          Filter
          {hasActiveFilters && (
            <CountBadge
              count={priorityFilters.size + labelFilters.size}
              variant="solid"
              className="absolute -top-2 -right-2"
            />
          )}
        </button>

        <OverlayPopover
          open={showFilterPopover}
          popoverRef={filterPopoverRef}
          transformOrigin="top right"
          // popover-inflow-ok: this renders only in the ViewToggle toolbar row,
          // which sits ABOVE the board/backlog content wells (AppLayout's
          // `flex-1 min-h-0 overflow-hidden`), so there is no clipping ancestor.
          // Portal + fixed if this ever moves inside a scroller.
          className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-2 w-[260px] max-h-[380px] overflow-y-auto"
        >
          <FilterPopover
            priorities={priorities}
            priorityFilters={priorityFilters}
            onTogglePriority={onTogglePriority}
            allLabels={allLabels}
            labelColors={labelColors}
            labelFilters={labelFilters}
            onToggleLabel={onToggleLabel}
            onClearAll={onClearFilters}
            hasActiveFilters={hasActiveFilters}
          />
        </OverlayPopover>
      </div>
    </div>
  );
}
