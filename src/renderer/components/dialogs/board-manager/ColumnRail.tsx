import React from 'react';
import { Plus, GripVertical, LayoutGrid, Bot, Split, Trash2 } from 'lucide-react';
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
  /**
   * The Board Profile switcher, rendered above the column list. Passed in
   * rather than built here so the rail stays a pure presentation component and
   * all profile state lives with the dialog.
   */
  profileBar?: React.ReactNode;
  /**
   * True while a non-Default profile is selected. Column STRUCTURE (which
   * columns exist and their order) is singular across profiles - only strategy
   * is profile-scoped - so adding, deleting, and reordering are suppressed.
   * Allowing them here would silently restructure the board for every task,
   * not just the ones on this profile.
   */
  structureLocked?: boolean;
  /** Delete the selected column. Surfaced as a trash control on the selected row. */
  onDeleteColumn?: () => void;
}

function ColumnRailRow({ row, active, sortable, onSelect, showDelete = false, onDelete }: {
  row: RailRow;
  active: boolean;
  sortable: boolean;
  onSelect: (id: string) => void;
  /**
   * Show the delete control on this row. Gated on the row being SELECTED rather
   * than hovered: a hover-only control gets overlooked and excludes keyboard and
   * touch users, while a trash on all seven rows is noise. Selection means
   * exactly one is ever on screen, and it is the column you are already editing.
   */
  showDelete?: boolean;
  onDelete?: () => void;
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
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-0.5 relative">
      {sortable ? (
        /* light-dismiss-ok: the board manager is a BaseDialog, which stamps
           `data-dismissable-layer` on its backdrop, and light dismiss abandons any press made
           while a dismissable layer is open. So this `cursor-grab` handle cannot close a task
           window behind the dialog even though its cursor is not `pointer`. */
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
          showDelete ? 'pr-8' : ''
        } ${
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
      {/* Sibling of the row button, not a child: a button inside a button is
          invalid HTML and breaks click handling. Absolutely positioned so it
          still reads as sitting inside the row's highlighted area. */}
      {showDelete && (
        <button
          type="button"
          onClick={onDelete}
          data-testid="board-manager-delete"
          aria-label={`Delete "${row.name || 'column'}"`}
          title={`Delete "${row.name || 'column'}"`}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded text-fg-faint
            hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

/**
 * The left rail: an "All columns" overview entry, a drag-to-reorder list of
 * columns, the Board Profile switcher, and an "Add column" button. The two
 * board-level controls sit together at the bottom, below the per-column list
 * they both act on. The To Do column is pinned at the top
 * (no drag handle, outside the SortableContext) so index 0 is structurally
 * unreachable, matching `swimlane-repository.reorder`'s constraint that To Do
 * stays first. Reorder is local (mutates the dialog's laneOrder); persistence
 * happens on Save.
 */
export function ColumnRail({
  rows, activeId, onSelect, onSelectOverview, onReorder, onAddColumn, profileBar,
  structureLocked = false, onDeleteColumn,
}: ColumnRailProps) {
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
      {/* Profile leads by precedence: it is the lens you choose BEFORE editing
          the columns below, and every row under it is shown through it.
          Grouped-with-a-label structure mirrors the Settings panel's rail. */}
      {profileBar}

      {/* Step 2 of the rail's top-down flow: pick a profile, optionally compare
          every column through it, then pick one column to edit. Its own labelled
          and bounded section, because a step folded into a neighbouring group's
          heading is the thing that gets skimmed past.
          What it compares is all columns AS SEEN THROUGH the selected profile,
          so it sits below the selector and above the list. */}
      <div className="flex-shrink-0 border-b border-edge/50 px-2 pt-3 pb-2">
        <div className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-fg-faint">Overview</div>
        <button
          type="button"
          role="tab"
          aria-selected={overviewSelected}
          onClick={onSelectOverview}
          data-testid="board-manager-tab-all"
          title="Compare every column's settings side by side"
          className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs transition-colors ${
            overviewSelected
              ? 'bg-surface-hover text-fg'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/60'
          }`}
        >
          <LayoutGrid size={14} className="flex-shrink-0" />
          All columns
        </button>
      </div>

      <div className="pl-4 pr-2 pt-3 pb-1.5 text-[11px] uppercase tracking-wide text-fg-faint flex-shrink-0">
        Columns
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {/* To Do is role-pinned: it can never be deleted, so no delete control. */}
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
                <ColumnRailRow
                  key={row.id}
                  row={row}
                  active={row.id === activeId}
                  sortable={!structureLocked}
                  onSelect={onSelect}
                  showDelete={row.id === activeId && !structureLocked && row.role !== 'done'}
                  onDelete={onDeleteColumn}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {/* Ends the column list rather than anchoring the rail, so it reads as
            "add one more of these" and scrolls with the rows it extends. Spans
            the full width - unlike a real row it can never be dragged, so
            reserving the rows' drag-handle gutter would just be dead space. The
            dashed outline reads as a vacant slot rather than competing with the
            real rows for attention. */}
        {!structureLocked && (
          <button
            type="button"
            onClick={onAddColumn}
            data-testid="board-manager-add-column"
            // h-8 matches "New profile" and the profile action row in ProfileBar:
            // peer affordances that must not drift apart in height.
            className="flex items-center gap-2 w-full mt-1.5 h-8 px-2 rounded border border-dashed border-edge/70
              text-xs text-fg-faint hover:text-fg-secondary hover:border-edge hover:bg-surface-hover/40 transition-colors"
          >
            <Plus size={13} className="flex-shrink-0" />
            Add column
          </button>
        )}

      </div>
    </div>
  );
}
