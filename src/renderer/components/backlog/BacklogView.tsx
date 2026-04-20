import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Plus, Search, Inbox, Filter, X, GripVertical } from 'lucide-react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { DataTable } from '../DataTable';
import { BacklogContextMenu } from './BacklogContextMenu';
import { BacklogBulkToolbar } from './BacklogBulkToolbar';
import { ImportPopover } from './ImportPopover';
import { CountBadge } from '../CountBadge';
import { FilterPopover } from '../FilterPopover';
import { useBacklogDragDrop } from '../../hooks/useBacklogDragDrop';
import { useFilterPopover } from '../../hooks/useFilterPopover';
import { useBacklogStore } from '../../stores/backlog-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { BacklogTask } from '../../../shared/types';
import { useBacklogColumns, type SortKey } from './view/useBacklogColumns';

/** Debounce between keystroke and filter recompute. Keeps the input responsive
 *  while deferring the filtering pass (which walks all backlog items + tests
 *  title/description/labels) until the user pauses typing. Matches the board
 *  search debounce in BoardSearchBar. */
const BACKLOG_SEARCH_DEBOUNCE_MS = 120;

export function BacklogView() {
  const hydrated = useBacklogStore((state) => state.hydrated);
  const items = useBacklogStore((state) => state.items);
  const selectedIds = useBacklogStore((state) => state.selectedIds);
  const toggleSelected = useBacklogStore((state) => state.toggleSelected);
  const selectAll = useBacklogStore((state) => state.selectAll);
  const clearSelection = useBacklogStore((state) => state.clearSelection);
  const deleteItem = useBacklogStore((state) => state.deleteItem);
  const bulkDelete = useBacklogStore((state) => state.bulkDelete);
  const promoteItems = useBacklogStore((state) => state.promoteItems);
  const openNewDialog = useBacklogStore((state) => state.openNewDialog);
  const setEditingItem = useBacklogStore((state) => state.setEditingItem);
  const setPendingDeleteId = useBacklogStore((state) => state.setPendingDeleteId);
  const setPendingBulkDelete = useBacklogStore((state) => state.setPendingBulkDelete);
  const setImportSource = useBacklogStore((state) => state.setImportSource);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const boardTasks = useBoardStore((state) => state.tasks);
  // Narrow config subscriptions: previously subscribed to the whole `config`
  // object, so any unrelated config change (notification toggle, theme,
  // statusBarPeriod) re-rendered the whole backlog view. Split into the three
  // fields actually used here.
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const priorities = useConfigStore((state) => state.config.backlog.priorities);
  const labelColors = useConfigStore((state) => state.config.backlog.labelColors);

  // `searchInput` is the immediate input value (updates per keystroke).
  // `searchQuery` is the debounced value that drives filtering. Keeps typing
  // smooth even when an import recently replaced `items`.
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setSearchInput(nextValue);
    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      setSearchQuery(nextValue);
    }, BACKLOG_SEARCH_DEBOUNCE_MS);
  }, []);

  const handleSearchClear = useCallback(() => {
    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchInput('');
    setSearchQuery('');
  }, []);

  useEffect(() => () => {
    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
  }, []);

  const {
    priorityFilters, labelFilters, hasActiveFilters,
    showFilterPopover, setShowFilterPopover,
    togglePriorityFilter, toggleLabelFilter, clearAllFilters,
    filterButtonRef, filterPopoverRef,
  } = useFilterPopover();
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; item: BacklogTask } | null>(null);

  // All unique labels across backlog tasks and board tasks
  const allLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const item of items) {
      for (const label of item.labels) labelSet.add(label);
    }
    for (const task of boardTasks) {
      for (const label of (task.labels ?? [])) labelSet.add(label);
    }
    return [...labelSet].sort();
  }, [items, boardTasks]);

  // --- Sort state (column sort disables drag-to-reorder) ---
  const [isColumnSorted, setIsColumnSorted] = useState(false);

  // --- Filtered data ---

  const filteredItems = useMemo(() => {
    let filtered = items;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.labels.some((label) => label.toLowerCase().includes(query)),
      );
    }
    if (priorityFilters.size > 0) {
      filtered = filtered.filter((item) => priorityFilters.has(item.priority));
    }
    if (labelFilters.size > 0) {
      filtered = filtered.filter((item) => item.labels.some((label) => labelFilters.has(label)));
    }
    return filtered;
  }, [items, searchQuery, priorityFilters, labelFilters]);

  // --- Action handlers ---

  const handleMoveSingle = useCallback(async (itemId: string, swimlaneId: string) => {
    await promoteItems([itemId], swimlaneId);
  }, [promoteItems]);

  const handleBulkMove = useCallback(async (swimlaneId: string) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    await promoteItems(ids, swimlaneId);
  }, [selectedIds, promoteItems]);

  const handleEdit = useCallback((itemId: string) => {
    const item = items.find((backlogItem) => backlogItem.id === itemId);
    if (item) setEditingItem(item);
  }, [items, setEditingItem]);

  const handleDelete = useCallback((itemId: string) => {
    if (skipDeleteConfirm) {
      deleteItem(itemId);
    } else {
      setPendingDeleteId(itemId);
    }
  }, [skipDeleteConfirm, deleteItem, setPendingDeleteId]);

  const handleBulkDelete = useCallback(() => {
    if (skipDeleteConfirm) {
      bulkDelete([...selectedIds]);
    } else {
      setPendingBulkDelete(true);
    }
  }, [selectedIds, skipDeleteConfirm, bulkDelete, setPendingBulkDelete]);

  const handleRowContextMenu = useCallback((item: BacklogTask, event: React.MouseEvent) => {
    // If right-clicked item is not in current selection,
    // clear selection and select only the right-clicked item
    if (!selectedIds.has(item.id)) {
      clearSelection();
      toggleSelected(item.id);
    }
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, item });
  }, [selectedIds, clearSelection, toggleSelected]);

  // Context menu acts on all selected items when the right-clicked item is part of a multi-selection
  const contextMenuIsMultiSelect = contextMenu !== null && selectedIds.size > 1 && selectedIds.has(contextMenu.item.id);

  // --- Columns ---

  const columns = useBacklogColumns({
    selectedIds,
    swimlanes,
    labelColors,
    toggleSelected,
    selectAll,
    handleMoveSingle,
    handleEdit,
    handleDelete,
  });

  // --- Drag-to-reorder ---
  // Drag is allowed with filters/search (slot algorithm preserves hidden items),
  // but disabled when column sort is active (sort determines order, not position).
  const canDrag = !isColumnSorted;
  const {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    activeItem,
  } = useBacklogDragDrop(filteredItems, items);

  const emptyMessage = searchQuery || hasActiveFilters
    ? 'No items match your filters'
    : undefined;

  if (!hydrated) return null;

  return (
    <div className="h-full flex flex-col" data-testid="backlog-view">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-edge">
        <button
          type="button"
          onClick={openNewDialog}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
          data-testid="new-backlog-task-btn"
        >
          <Plus size={14} />
          New Task
        </button>

        <ImportPopover onOpenImportDialog={setImportSource} />

        <div className="flex-1" />

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            type="text"
            value={searchInput}
            onChange={handleSearchChange}
            placeholder="Search backlog..."
            className="w-56 bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-disabled pl-8 pr-8 py-1.5 outline-none focus:border-edge-input"
            data-testid="backlog-search"
          />
          {searchInput && (
            <button
              type="button"
              onClick={handleSearchClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-muted transition-colors"
              data-testid="backlog-search-clear"
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
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded transition-colors ${
              hasActiveFilters
                ? 'text-accent-fg border-accent/50 bg-accent-bg/10'
                : 'text-fg-muted hover:text-fg border-edge/50 hover:bg-surface-hover/40'
            }`}
            data-testid="backlog-filter-btn"
          >
            <Filter size={14} />
            Filter
            {hasActiveFilters && (
              <CountBadge count={priorityFilters.size + labelFilters.size} variant="solid" />
            )}
          </button>

          {showFilterPopover && (
            <div
              ref={filterPopoverRef}
              className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-2 w-[260px] max-h-[380px] overflow-y-auto"
            >
              <FilterPopover
                priorities={priorities}
                priorityFilters={priorityFilters}
                onTogglePriority={togglePriorityFilter}
                allLabels={allLabels}
                labelColors={labelColors}
                labelFilters={labelFilters}
                onToggleLabel={toggleLabelFilter}
                onClearAll={clearAllFilters}
                hasActiveFilters={hasActiveFilters}
              />
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-faint gap-4">
            <Inbox size={48} strokeWidth={1} />
            <div className="text-center">
              <div className="text-lg font-medium text-fg-muted">Backlog is empty</div>
              <div className="text-sm mt-1">Create or import items to stage work before promoting to the board</div>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button
                type="button"
                onClick={openNewDialog}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
              >
                <Plus size={14} />
                Create your first task
              </button>
              <ImportPopover onOpenImportDialog={setImportSource} />
            </div>
          </div>
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              autoScroll={{ enabled: filteredItems.length > 15, threshold: { x: 0, y: 0.15 }, acceleration: 10 }}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={filteredItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <DataTable<BacklogTask, SortKey>
                  columns={columns}
                  data={filteredItems}
                  rowKey={(item) => item.id}
                  onRowClick={(item) => toggleSelected(item.id)}
                  onRowDoubleClick={(item) => handleEdit(item.id)}
                  onRowContextMenu={handleRowContextMenu}
                  emptyMessage={emptyMessage}
                  rowTestId="backlog-task-row"
                  virtualized
                  sortableEnabled={canDrag}
                  onSortChange={(key) => setIsColumnSorted(key !== undefined)}
                />
              </SortableContext>
              <DragOverlay style={{ pointerEvents: 'none' }}>
                {activeItem ? (
                  <table className="w-full table-fixed text-sm bg-surface-raised border border-edge rounded shadow-lg opacity-90">
                    <tbody>
                      <tr>
                        <td className="w-[32px] px-1 py-2.5">
                          <div className="flex items-center justify-center text-fg-disabled">
                            <GripVertical size={14} />
                          </div>
                        </td>
                        {columns.map((column, columnIndex) => (
                          <td key={columnIndex} className={`px-3 py-2.5 ${column.width || ''}`}>
                            {column.render(activeItem)}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                ) : null}
              </DragOverlay>
            </DndContext>
            {selectedIds.size > 0 && (
              <BacklogBulkToolbar
                selectedCount={selectedIds.size}
                swimlanes={swimlanes}
                onMoveToBoard={handleBulkMove}
                onDelete={handleBulkDelete}
              />
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <BacklogContextMenu
          position={contextMenu.position}
          swimlanes={swimlanes}
          selectedCount={contextMenuIsMultiSelect ? selectedIds.size : 1}
          onMoveToBoard={(swimlaneId) => {
            if (contextMenuIsMultiSelect) {
              handleBulkMove(swimlaneId);
            } else {
              handleMoveSingle(contextMenu.item.id, swimlaneId);
            }
          }}
          onEdit={() => handleEdit(contextMenu.item.id)}
          onDelete={() => {
            if (contextMenuIsMultiSelect) {
              handleBulkDelete();
            } else {
              handleDelete(contextMenu.item.id);
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
