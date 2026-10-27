import { useState, useMemo, useCallback, useEffect } from 'react';
import { Plus, Inbox, GripVertical } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { DataTable } from '../DataTable';
import { BacklogContextMenu } from './BacklogContextMenu';
import { BacklogBulkToolbar } from './BacklogBulkToolbar';
import { ImportPopover } from './ImportPopover';
import { useBacklogDragDrop } from '../../hooks/useBacklogDragDrop';
import { useBacklogStore } from '../../stores/backlog-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useHmrGeneration } from '../../utils/hmr-generation';
import type { BacklogTask } from '../../../shared/types';
import { useBacklogColumns, type SortKey } from './view/useBacklogColumns';

export function BacklogView() {
  const { t } = useLingui();
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
  // Narrow config subscriptions: previously subscribed to the whole `config`
  // object, so any unrelated config change (notification toggle, theme,
  // statusBarPeriod) re-rendered the whole backlog view. Split into the
  // fields actually used here.
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const labelColors = useConfigStore((state) => state.config.backlog.labelColors);

  // Search + filter state lives in the backlog store so the shared ViewToggle
  // toolbar (the controls) and this list (the consumer) read one instance. The
  // filter popover UI and the search input render in ViewToggle.
  const backlogSearchQuery = useBacklogStore((state) => state.backlogSearchQuery);
  const setBacklogSearchQuery = useBacklogStore((state) => state.setBacklogSearchQuery);
  const priorityFilters = useBacklogStore((state) => state.backlogPriorityFilters);
  const labelFilters = useBacklogStore((state) => state.backlogLabelFilters);
  const hasActiveFilters = priorityFilters.size > 0 || labelFilters.size > 0;

  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; item: BacklogTask } | null>(null);

  // --- Sort state (column sort disables drag-to-reorder) ---
  const [isColumnSorted, setIsColumnSorted] = useState(false);

  // --- Scroll-to-id from global search palette ---
  // The store field arms a one-shot request; we drop the active search query
  // if it would hide the row, scroll the row into view, and open the edit
  // dialog for the matched item (mirrors how task hits open the task detail
  // dialog on the board). No row pulse here - the modal would cover it
  // immediately, so the highlight would be invisible.
  const scrollToBacklogId = useBacklogStore((state) => state.scrollToBacklogId);
  const setScrollToBacklogId = useBacklogStore((state) => state.setScrollToBacklogId);
  useEffect(() => {
    if (!scrollToBacklogId) return;
    if (!hydrated) return;
    const matched = items.find((item) => item.id === scrollToBacklogId);
    if (matched && backlogSearchQuery) {
      setBacklogSearchQuery('');
    }
    const targetId = scrollToBacklogId;
    setScrollToBacklogId(null);
    if (matched) setEditingItem(matched);
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-row-id="${targetId}"]`) as HTMLElement | null;
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [scrollToBacklogId, hydrated, items, backlogSearchQuery, setBacklogSearchQuery, setScrollToBacklogId, setEditingItem]);

  // --- Filtered data ---

  const filteredItems = useMemo(() => {
    let filtered = items;
    if (backlogSearchQuery.trim()) {
      const query = backlogSearchQuery.trim().toLowerCase();
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
  }, [items, backlogSearchQuery, priorityFilters, labelFilters]);

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

  // Re-key DndContext on HMR; see src/renderer/utils/hmr-generation.ts.
  const hmrGeneration = useHmrGeneration();

  const emptyMessage = backlogSearchQuery || hasActiveFilters
    ? t`No items match your filters`
    : undefined;

  if (!hydrated) return null;

  return (
    <div className="h-full flex flex-col" data-testid="backlog-view">
      {/* Table (the search + filter + actions toolbar lives in ViewToggle) */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-faint gap-4">
            <Inbox size={48} strokeWidth={1} />
            <div className="text-center">
              <div className="text-lg font-medium text-fg-muted"><Trans>Backlog is empty</Trans></div>
              <div className="text-sm mt-1"><Trans>Create or import items to stage work before promoting to the board</Trans></div>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button
                type="button"
                onClick={openNewDialog}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
              >
                <Plus size={14} />
                <Trans>Create your first task</Trans>
              </button>
              <ImportPopover onOpenImportDialog={setImportSource} />
            </div>
          </div>
        ) : (
          <>
            <DndContext
              key={hmrGeneration}
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
