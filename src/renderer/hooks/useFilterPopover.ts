import { useState, useCallback, useEffect, useRef } from 'react';

export interface FilterPopoverState {
  priorityFilters: Set<number>;
  labelFilters: Set<string>;
  hasActiveFilters: boolean;
  showFilterPopover: boolean;
  setShowFilterPopover: (show: boolean) => void;
  togglePriorityFilter: (value: number) => void;
  toggleLabelFilter: (label: string) => void;
  clearAllFilters: () => void;
  filterButtonRef: React.RefObject<HTMLButtonElement | null>;
  filterPopoverRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Shared hook for filter popover state, toggle callbacks, and click-outside logic.
 * Used by both BacklogView and KanbanBoard.
 */
export function useFilterPopover(): FilterPopoverState {
  const [priorityFilters, setPriorityFilters] = useState<Set<number>>(new Set());
  const [labelFilters, setLabelFilters] = useState<Set<string>>(new Set());
  const [showFilterPopover, setShowFilterPopover] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);

  const hasActiveFilters = priorityFilters.size > 0 || labelFilters.size > 0;

  // Close filter popover on click outside
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

  const togglePriorityFilter = useCallback((value: number) => {
    setPriorityFilters((previous) => {
      const next = new Set(previous);
      if (next.has(value)) { next.delete(value); } else { next.add(value); }
      return next;
    });
  }, []);

  const toggleLabelFilter = useCallback((label: string) => {
    setLabelFilters((previous) => {
      const next = new Set(previous);
      if (next.has(label)) { next.delete(label); } else { next.add(label); }
      return next;
    });
  }, []);

  const clearAllFilters = useCallback(() => {
    setPriorityFilters(new Set());
    setLabelFilters(new Set());
  }, []);

  return {
    priorityFilters,
    labelFilters,
    hasActiveFilters,
    showFilterPopover,
    setShowFilterPopover,
    togglePriorityFilter,
    toggleLabelFilter,
    clearAllFilters,
    filterButtonRef,
    filterPopoverRef,
  };
}
