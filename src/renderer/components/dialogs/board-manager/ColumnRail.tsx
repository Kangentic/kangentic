import React from 'react';
import { Plus, GripVertical, LayoutGrid, Bot, Split } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ICON_REGISTRY, ROLE_DEFAULTS } from '../../../utils/swimlane-icons';
import { useHmrGeneration } from '../../../utils/hmr-generation';
import type { SwimlaneRole } from '../../../../shared/types';

/** Sentinel id for the "All columns" overview entry. Shared with the dialog. */
export const ALL_COLUMNS_ID = 'overview';

/** One precomputed row for the left rail (derived from the dialog's drafts). */
export interface RailRow {
  id: string;
  /** Display name (draft name; falls back to 'Untitled' in render). */
  name: string;
  /** Saved name if persisted, else the draft name. Drives `data-tab-name`. */
  tabName: string;
  color: string;
  icon: string | null;
  role: SwimlaneRole | null;
  dirty: boolean;
  /** Display label of the column's agent override, or null when none. */
  agentOverrideLabel: string | null;
  isolated: boolean;
}

interface ColumnRailProps {
  rows: RailRow[];
  /** The selected id: a column id, or ALL_COLUMNS_ID for the overview. */
  activeId: string;
  onSelect: (id: string) => void;
  onSelectOverview: () => void;
  onReorder: (nextOrder: string[]) => void;
  onAddColumn: () => void;
}

function ColumnRailRow({ row, active, sortable, onSelect }: {
  row: RailRow;
  active: boolean;
  sortable: boolean;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !sortable,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const Icon = row.icon ? ICON_REGISTRY.get(row.icon) : (row.role ? ROLE_DEFAULTS[row.role] : null);

  // Single-line row of uniform height: variable-height rows break @dnd-kit's
  // verticalListSortingStrategy (drag displacement looks amplified/jumpy). At-a-
  // glance config lives in the "All columns" overview; the rail keeps only tiny
  // icon hints for the genuinely distinguishing overrides (agent, isolated).
  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-0.5">
      {sortable ? (
        <div
          {...attributes}
          {...listeners}
          data-drag-handle
          title="Drag to reorder"
          className="flex items-center px-0.5 cursor-grab active:cursor-grabbing text-fg-disabled hover:text-fg-muted flex-shrink-0"
        >
          <GripVertical size={13} />
        </div>
      ) : (
        <div className="w-[17px] flex-shrink-0" />
      )}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-testid="board-manager-tab"
        data-tab-name={row.tabName}
        data-tab-id={row.id}
        onClick={() => onSelect(row.id)}
        className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded text-left transition-colors ${
          active
            ? 'bg-surface-hover text-fg'
            : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/50'
        }`}
      >
        {Icon ? (
          <Icon size={14} strokeWidth={1.75} style={{ color: row.color }} className="flex-shrink-0" />
        ) : (
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.color }} />
        )}
        <span className="flex-1 min-w-0 truncate text-sm">{row.name || 'Untitled'}</span>
        {row.agentOverrideLabel && (
          <span title={`Agent: ${row.agentOverrideLabel}`} className="flex-shrink-0 text-fg-faint">
            <Bot size={12} strokeWidth={2} />
          </span>
        )}
        {row.isolated && (
          <span title="Isolated session" className="flex-shrink-0 text-fg-faint">
            <Split size={12} strokeWidth={2} />
          </span>
        )}
        {row.dirty && (
          <span
            aria-label="unsaved changes"
            data-testid="board-manager-tab-dirty"
            className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"
          />
        )}
      </button>
    </div>
  );
}

/**
 * The left rail: an "All columns" overview entry, a drag-to-reorder list of
 * columns, and an "Add column" button. The To Do column is pinned at the top
 * (no drag handle, outside the SortableContext) so index 0 is structurally
 * unreachable, matching `swimlane-repository.reorder`'s constraint that To Do
 * stays first. Reorder is local (mutates the dialog's laneOrder); persistence
 * happens on Save.
 */
export function ColumnRail({ rows, activeId, onSelect, onSelectOverview, onReorder, onAddColumn }: ColumnRailProps) {
  // Re-key DndContext on HMR; see src/renderer/utils/hmr-generation.ts (Pattern C).
  const hmrGeneration = useHmrGeneration();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const overviewSelected = activeId === ALL_COLUMNS_ID;
  const todoRow = rows.find((row) => row.role === 'todo') ?? null;
  const sortableRows = rows.filter((row) => row.role !== 'todo');
  const sortableIds = sortableRows.map((row) => row.id);

  const handleDragEnd = (event: { active: { id: string | number }; over: { id: string | number } | null }) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sortableIds.indexOf(String(active.id));
    const to = sortableIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const movedSubset = arrayMove(sortableIds, from, to);
    onReorder(todoRow ? [todoRow.id, ...movedSubset] : movedSubset);
  };

  // Focus-scoped ArrowUp/Down to walk the rail (overview + every column),
  // wrapping. Skipped while a drag handle is focused so the KeyboardSensor
  // owns the arrows during a keyboard-initiated sort.
  const handleRailKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if ((event.target as HTMLElement).closest('[data-drag-handle]')) return;
    event.preventDefault();
    const navIds = [ALL_COLUMNS_ID, ...rows.map((row) => row.id)];
    const index = navIds.indexOf(activeId);
    if (index < 0) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextKey = navIds[(index + delta + navIds.length) % navIds.length];
    if (nextKey === ALL_COLUMNS_ID) onSelectOverview();
    else onSelect(nextKey);
  };

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      onKeyDown={handleRailKey}
      className="w-[224px] flex-shrink-0 border-r border-edge/60 bg-surface/40 flex flex-col"
    >
      <button
        type="button"
        role="tab"
        aria-selected={overviewSelected}
        data-testid="board-manager-tab-all"
        onClick={onSelectOverview}
        className={`flex items-center gap-2 mx-2 mt-2 mb-1 px-2 py-2 rounded text-sm transition-colors ${
          overviewSelected
            ? 'bg-surface-hover text-fg'
            : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/50'
        }`}
      >
        <LayoutGrid size={14} strokeWidth={1.75} className="flex-shrink-0" />
        <span className="flex-1 text-left">All columns</span>
      </button>
      <div className="mx-2 border-b border-edge/50" />

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {todoRow && (
          <ColumnRailRow row={todoRow} active={todoRow.id === activeId} sortable={false} onSelect={onSelect} />
        )}
        <DndContext
          key={hmrGeneration}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5">
              {sortableRows.map((row) => (
                <ColumnRailRow key={row.id} row={row} active={row.id === activeId} sortable onSelect={onSelect} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <div className="flex-shrink-0 border-t border-edge/60 p-2">
        <button
          type="button"
          onClick={onAddColumn}
          data-testid="board-manager-add-column"
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-fg-muted hover:text-fg hover:bg-surface-hover/60 transition-colors"
        >
          <Plus size={14} />
          Add column
        </button>
      </div>
    </div>
  );
}
