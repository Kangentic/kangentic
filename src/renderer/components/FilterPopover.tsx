import React from 'react';
import { X } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
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
 * Builds the className for a toggleable filter pill. Inactive pills get a hover
 * affordance (bg brighten + subtle ring + pointer) so they read as clickable;
 * the active state stays distinct via a stronger `ring-fg-muted`. Colored pills
 * carry their text color via an inline style, so we vary only bg + ring for them.
 */
function pillClassName({ isActive, colored, fullWidth }: {
  isActive: boolean;
  colored: boolean;
  fullWidth: boolean;
}): string {
  const parts = ['font-medium cursor-pointer transition-colors'];
  if (fullWidth) parts.push('w-full');
  if (colored) {
    parts.push('bg-surface-hover/60');
    parts.push(isActive
      ? 'ring-1 ring-fg-muted'
      : 'hover:bg-surface-hover hover:ring-1 hover:ring-edge');
  } else {
    parts.push(isActive
      ? 'bg-surface-hover text-fg ring-1 ring-fg-muted'
      : 'bg-surface-hover/60 text-fg-muted hover:bg-surface-hover hover:text-fg hover:ring-1 hover:ring-edge');
  }
  return parts.join(' ');
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
        <Trans>Priority</Trans>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-1.5">
        {priorities.map((priority, index) => {
          const isActive = priorityFilters.has(index);
          const isColored = index !== 0;
          return (
            <button
              key={index}
              type="button"
              onClick={() => onTogglePriority(index)}
              aria-pressed={isActive}
              data-testid="filter-priority"
              data-priority={index}
            >
              <Pill
                size="sm"
                className={pillClassName({ isActive, colored: isColored, fullWidth: false })}
                style={isColored ? { color: priority.color } : undefined}
              >
                {priority.label}
              </Pill>
            </button>
          );
        })}
      </div>

      {/* Labels section - 2-column grid */}
      {allLabels.length > 0 && (
        <>
          <div className="my-1.5 border-t border-edge" />
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            <Trans>Labels</Trans>
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
                  aria-pressed={isActive}
                  data-testid="filter-label"
                  data-label={label}
                >
                  <Pill
                    size="sm"
                    className={pillClassName({ isActive, colored: Boolean(color), fullWidth: true })}
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
            className="w-full px-3 py-1.5 text-xs leading-none text-fg-secondary hover:text-fg text-left hover:bg-surface-hover/30 flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <X size={12} />
            <Trans>Clear all filters</Trans>
          </button>
        </>
      )}
    </>
  );
});
