import React, { useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { UnfoldHorizontal } from 'lucide-react';
import { plural } from '@lingui/core/macro';
import { SwimlaneIcon } from '../../utils/swimlane-icons';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { CountBadge } from '../CountBadge';
import { Tooltip } from '../Tooltip';
import { COLLAPSED_LANE_WIDTH_PX } from './lane-widths';
import type { Swimlane as SwimlaneType } from '../../../shared/types';

export interface CollapsedLaneProps {
  swimlane: SwimlaneType;
  /** What the strip counts: the column's cards, or Done's completed tasks. */
  count: number;
}

/**
 * A column the user collapsed (#1056): a 40px strip that reads like the header
 * turned on its side, icon, name, then count. The whole strip is one button
 * that expands the column.
 *
 * It stays a drop target. It registers the lane's own droppable (the id a full
 * lane registers on its task list), and it carries `data-swimlane-id`, the
 * element the drag's highlight is toggled on, so a card dragged over it lights
 * it the way it lights a full column. Done has no `data-swimlane-id` (the
 * shared highlight never applies to Done), so its strip lights from `isOver`
 * and carries `data-done-drop-zone`, the target a completing card flies to.
 * A card dropped here lands at the end of the column, and the drop itself
 * expands the column (`useBoardDragDrop`).
 *
 * It has no grip: a collapsed column is reordered after it is expanded.
 */
export const CollapsedLane = React.memo(function CollapsedLane({ swimlane, count }: CollapsedLaneProps) {
  const isDone = swimlane.role === 'done';
  const setColumnCollapsed = useConfigStore((state) => state.setColumnCollapsed);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // Stable identity, as in DoneSwimlane: a fresh `data` object each render
  // makes dnd-kit register the droppable again.
  const droppableData = useMemo(() => ({ type: 'swimlane' as const }), []);
  const { setNodeRef, isOver } = useDroppable({ id: swimlane.id, data: droppableData });

  const dropColorStyle = useMemo(
    () => (swimlane.color ? ({ '--drop-color': swimlane.color } as React.CSSProperties) : undefined),
    [swimlane.color],
  );

  const columnName = swimlane.name;
  const expandLabel = plural(count, {
    one: `Expand ${columnName} column, # task`,
    other: `Expand ${columnName} column, # tasks`,
  });

  return (
    // The column's description, as its header shows. The strip's own name is
    // its accessible name, so the tip never repeats it.
    <Tooltip label={swimlane.description ?? ''}>
      <button
        type="button"
        ref={setNodeRef}
        onClick={() => {
          if (projectId) setColumnCollapsed(projectId, swimlane.id, false);
        }}
        aria-label={expandLabel}
        data-testid="swimlane"
        data-swimlane-name={swimlane.name}
        data-collapsed="true"
        {...(isDone ? { 'data-done-drop-zone': true } : { 'data-swimlane-id': swimlane.id })}
        // The transition names the background only. `transition-colors` also
        // eases `outline-color`, and an element with no outline has the text
        // colour there, so the drop highlight's outline eased in from white.
        className={`h-full w-full flex flex-col items-start rounded-lg overflow-clip text-left cursor-pointer hover:bg-surface-hover/30 transition-[background-color] duration-150 ${
          swimlane.is_ghost ? 'opacity-50 border-2 border-dashed border-fg-disabled' : ''
        } ${swimlane.role !== null ? 'ring-1 ring-edge/50 bg-surface-raised/70' : 'bg-surface-raised/50'} ${
          isDone && isOver ? 'drop-highlight' : ''
        }`}
        style={dropColorStyle}
      >
        {/* Accent bar, the full width of the strip. */}
        <span className="block h-0.5 w-full flex-shrink-0 rounded-t-lg" style={{ backgroundColor: swimlane.color }} />
        {/* A fixed column of content, so nothing slides sideways while the
            strip's width eases between collapsed and open. */}
        <span
          className="flex min-h-0 flex-1 flex-col items-center gap-2 pt-2 pb-2"
          style={{ width: COLLAPSED_LANE_WIDTH_PX }}
        >
          <UnfoldHorizontal size={14} className="flex-shrink-0 text-fg-disabled" />
          <SwimlaneIcon swimlane={swimlane} size={16} dotClassName="w-2.5 h-2.5 rounded-full flex-shrink-0" />
          <span
            className={`min-h-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium [writing-mode:vertical-rl] ${
              swimlane.role !== null ? 'text-fg' : 'text-fg-secondary'
            }`}
          >
            {swimlane.name}
          </span>
          <CountBadge count={count} variant="tinted" size="pill" className="shrink-0 text-fg-muted" testId="swimlane-task-count" />
        </span>
      </button>
    </Tooltip>
  );
});
