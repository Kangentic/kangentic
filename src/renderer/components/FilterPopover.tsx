import React from 'react';
import { X } from 'lucide-react';
import { Pill } from './Pill';

interface FilterPopoverProps {
  priorities: Array<{ label: string; color: string }>;
  priorityFilters: Set<number>;
  onTogglePriority: (index: number) => void;
  allLabels: string[];
  labelColors: Record<string, string>;
  labelFilters: Set<string>;
  onToggleLabel: (label: string) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
}

/**
 * Shared filter popover content for filtering by priority and labels.
 * Used by both BacklogView and KanbanBoard.
 *
 * Renders the inner popover content only - the caller is responsible for
 * the outer positioned container and click-outside logic.
 */
export const FilterPopover = React.memo(function FilterPopover({
  priorities,
  priorityFilters,
  onTogglePriority,
  allLabels,
  labelColors,
  labelFilters,
  onToggleLabel,
  onClearAll,
  hasActiveFilters,
}: FilterPopoverProps) {
  return (
    <>
      {/* Priority section - horizontal toggleable pills */}
      <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        Priority
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-1.5">
        {priorities.map((priority, index) => {
          const isActive = priorityFilters.has(index);
          return (
            <button
              key={index}
              type="button"
              onClick={() => onTogglePriority(index)}
            >
              {index === 0 ? (
                <Pill
                  size="sm"
                  className={`font-medium ${isActive ? 'bg-surface-hover text-fg ring-1 ring-fg-muted' : 'bg-surface-hover/60 text-fg-muted'}`}
                >
                  {priority.label}
                </Pill>
              ) : (
                <Pill
                  size="sm"
                  className={`bg-surface-hover/60 font-medium ${isActive ? 'ring-1 ring-fg-muted' : ''}`}
                  style={{ color: priority.color }}
                >
                  {priority.label}
                </Pill>
              )}
            </button>
          );
        })}
      </div>

      {/* Labels section - 2-column grid */}
      {allLabels.length > 0 && (
        <>
          <div className="my-1.5 border-t border-edge" />
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Labels
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-3 py-1.5">
            {allLabels.map((label) => {
              const color = labelColors[label];
              const isActive = labelFilters.has(label);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => onToggleLabel(label)}
                  className="flex items-center justify-center"
                >
                  <Pill
                    size="sm"
                    className={color
                      ? `bg-surface-hover/60 font-medium w-full ${isActive ? 'ring-1 ring-fg-muted' : ''}`
                      : `w-full ${isActive ? 'bg-surface-hover text-fg ring-1 ring-fg-muted' : 'bg-surface-hover/60 text-fg-muted'}`
                    }
                    style={color ? { color } : undefined}
                  >
                    {label}
                  </Pill>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Clear all */}
      {hasActiveFilters && (
        <>
          <div className="mx-2 my-1.5 border-t border-edge" />
          <button
            type="button"
            onClick={onClearAll}
            className="w-full px-3 py-1.5 text-xs text-fg-secondary hover:text-fg text-left hover:bg-surface-hover/30 flex items-center gap-1.5"
          >
            <X size={12} />
            Clear all filters
          </button>
        </>
      )}
    </>
  );
});
