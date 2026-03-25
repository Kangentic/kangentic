import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Plus, Search, SquareArrowRight, Trash2, Inbox, Filter, Pencil, X, Github, ExternalLink, GripVertical } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { Pill } from '../Pill';
import { PriorityBadge } from './PriorityBadge';
import { PromotePopover } from './PromotePopover';
import { stripMarkdown } from '../../utils/strip-markdown';
import { BacklogContextMenu } from './BacklogContextMenu';
import { BacklogBulkToolbar } from './BacklogBulkToolbar';
import { NewBacklogTaskDialog } from './NewBacklogTaskDialog';
import { ImportPopover } from './ImportPopover';
import { ImportDialog } from './ImportDialog';
import type { ImportSource } from '../../../shared/types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { CountBadge } from '../CountBadge';
import { FilterPopover } from '../FilterPopover';
import { useBacklogDragDrop } from '../../hooks/useBacklogDragDrop';
import { useFilterPopover } from '../../hooks/useFilterPopover';
import { useBacklogStore } from '../../stores/backlog-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { BacklogTask } from '../../../shared/types';

type SortKey = 'select' | 'priority' | 'title' | 'labels' | 'created' | 'actions';

// --- Row actions ---

function RowActions({
  itemId,
  swimlanes,
  onMoveToBoard,
  onEdit,
  onDelete,
}: {
  itemId: string;
  swimlanes: ReturnType<typeof useBoardStore.getState>['swimlanes'];
  onMoveToBoard: (itemId: string, swimlaneId: string) => void;
  onEdit: (itemId: string) => void;
  onDelete: (itemId: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex items-center justify-end gap-1 relative" onClick={(event) => event.stopPropagation()}>
      <div className="relative">
        <button
          ref={moveButtonRef}
          type="button"
          onClick={() => setShowPicker(!showPicker)}
          className="p-1.5 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
          title="Move to board"
          data-testid="move-to-board-btn"
        >
          <SquareArrowRight size={15} />
        </button>
        {showPicker && (
          <PromotePopover
            triggerRef={moveButtonRef}
            swimlanes={swimlanes}
            onSelect={(swimlaneId) => {
              setShowPicker(false);
              onMoveToBoard(itemId, swimlaneId);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => onEdit(itemId)}
        className="p-1.5 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
        title="Edit item"
        data-testid="edit-item-btn"
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        onClick={() => onDelete(itemId)}
        className="p-1.5 text-fg-disabled hover:text-red-400 hover:bg-surface-hover/40 rounded transition-colors"
        title="Delete item"
        data-testid="delete-item-btn"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// --- Main component ---

export function BacklogView() {
  const items = useBacklogStore((state) => state.items);
  const selectedIds = useBacklogStore((state) => state.selectedIds);
  const toggleSelected = useBacklogStore((state) => state.toggleSelected);
  const selectAll = useBacklogStore((state) => state.selectAll);
  const clearSelection = useBacklogStore((state) => state.clearSelection);
  const createItem = useBacklogStore((state) => state.createItem);
  const updateItem = useBacklogStore((state) => state.updateItem);
  const deleteItem = useBacklogStore((state) => state.deleteItem);
  const bulkDelete = useBacklogStore((state) => state.bulkDelete);
  const promoteItems = useBacklogStore((state) => state.promoteItems);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const boardTasks = useBoardStore((state) => state.tasks);
  const config = useConfigStore((state) => state.config);
  const skipDeleteConfirm = config.skipDeleteConfirm;
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const labelColors = config.backlog?.labelColors ?? {};

  const [searchQuery, setSearchQuery] = useState('');
  const {
    priorityFilters, labelFilters, hasActiveFilters,
    showFilterPopover, setShowFilterPopover,
    togglePriorityFilter, toggleLabelFilter, clearAllFilters,
    filterButtonRef, filterPopoverRef,
  } = useFilterPopover();
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [editingTask, setEditingItem] = useState<BacklogTask | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; item: BacklogTask } | null>(null);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);

  // Config-driven priorities
  const priorities = config.backlog?.priorities ?? [
    { label: 'None', color: '#6b7280' },
    { label: 'Low', color: '#6b7280' },
    { label: 'Medium', color: '#eab308' },
    { label: 'High', color: '#f97316' },
    { label: 'Urgent', color: '#ef4444' },
  ];

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
  }, [items]);

  const handleDelete = useCallback((itemId: string) => {
    if (skipDeleteConfirm) {
      deleteItem(itemId);
    } else {
      setPendingDeleteId(itemId);
    }
  }, [skipDeleteConfirm, deleteItem]);

  const handleConfirmDelete = useCallback((dontAskAgain: boolean) => {
    if (pendingDeleteId) {
      deleteItem(pendingDeleteId);
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, deleteItem, updateConfig]);

  const handleBulkDelete = useCallback(() => {
    if (skipDeleteConfirm) {
      bulkDelete([...selectedIds]);
    } else {
      setPendingBulkDelete(true);
    }
  }, [selectedIds, skipDeleteConfirm, bulkDelete]);

  const handleConfirmBulkDelete = useCallback((dontAskAgain: boolean) => {
    bulkDelete([...selectedIds]);
    if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    setPendingBulkDelete(false);
  }, [selectedIds, bulkDelete, updateConfig]);

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

  const columns: DataTableColumn<BacklogTask, SortKey>[] = useMemo(() => [
    {
      key: 'select' as SortKey,
      label: '',
      width: 'w-[40px]',
      render: (item) => (
        <label className="flex items-center justify-center p-1 cursor-pointer" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selectedIds.has(item.id)}
            onChange={() => toggleSelected(item.id)}
            className="w-3 h-3 accent-accent-fg cursor-pointer"
            data-testid="backlog-task-checkbox"
          />
        </label>
      ),
      headerRender: (data: BacklogTask[]) => (
        <label className="flex items-center justify-center p-1 cursor-pointer">
          <input
            type="checkbox"
            checked={data.length > 0 && data.every((item) => selectedIds.has(item.id))}
            onChange={() => selectAll(data.map((item) => item.id))}
            className="w-3 h-3 accent-accent-fg cursor-pointer"
            data-testid="backlog-select-all"
          />
        </label>
      ),
    },
    {
      key: 'priority' as SortKey,
      label: 'Priority',
      width: 'w-[80px]',
      sortValue: (item) => item.priority,
      render: (item) => <PriorityBadge priority={item.priority} showLabel />,
    },
    {
      key: 'title' as SortKey,
      label: 'Title',
      width: 'min-w-[300px]',
      sortValue: (item) => item.title.toLowerCase(),
      render: (item) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {item.external_source && item.external_url && (
              <button
                type="button"
                className="shrink-0 text-fg-faint hover:text-fg transition-colors"
                onClick={(event) => {
                  event.stopPropagation();
                  window.electronAPI.shell.openExternal(item.external_url!);
                }}
                title={`Open in ${item.external_source?.startsWith('github') ? 'GitHub' : item.external_source}`}
              >
                {item.external_source?.startsWith('github') ? <Github size={13} /> : <ExternalLink size={13} />}
              </button>
            )}
            <span className="text-fg font-medium truncate">{item.title}</span>
          </div>
          {item.description && (
            <div className="text-xs text-fg-faint truncate mt-0.5">{stripMarkdown(item.description)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'labels' as SortKey,
      label: 'Labels',
      width: 'w-[200px]',
      render: (item) =>
        item.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.labels.map((label) => {
              const color = labelColors[label];
              return (
                <Pill
                  key={label}
                  size="sm"
                  className={color ? 'bg-surface-hover/60 font-medium' : 'bg-surface-hover/60 text-fg-muted'}
                  style={color ? { color } : undefined}
                >
                  {label}
                </Pill>
              );
            })}
          </div>
        ) : null,
    },
    {
      key: 'created' as SortKey,
      label: 'Created',
      align: 'right',
      width: 'w-[160px]',
      sortValue: (item) => item.created_at,
      render: (item) => (
        <span className="text-fg-faint text-xs whitespace-nowrap">
          {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
        </span>
      ),
    },
    {
      key: 'actions' as SortKey,
      label: '',
      width: 'w-[100px]',
      render: (item) => (
        <RowActions
          itemId={item.id}
          swimlanes={swimlanes}
          onMoveToBoard={handleMoveSingle}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      ),
    },
  ], [selectedIds, toggleSelected, selectAll, swimlanes, handleMoveSingle, handleEdit, handleDelete, labelColors]);

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

  return (
    <div className="h-full flex flex-col" data-testid="backlog-view">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-edge">
        <button
          type="button"
          onClick={() => setShowNewDialog(true)}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
          data-testid="new-backlog-task-btn"
        >
          <Plus size={14} />
          New Task
        </button>

        <ImportPopover onOpenImportDialog={(source) => setImportSource(source)} />

        <div className="flex-1" />

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search backlog..."
            className="w-56 bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-disabled pl-8 pr-8 py-1.5 outline-none focus:border-edge-input"
            data-testid="backlog-search"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
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
              <div className="text-sm mt-1">Create items to stage work before promoting to the board</div>
            </div>
            <button
              type="button"
              onClick={() => setShowNewDialog(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors mt-2"
            >
              <Plus size={14} />
              Create your first task
            </button>
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

      {/* Dialogs */}
      {showNewDialog && (
        <NewBacklogTaskDialog
          onClose={() => setShowNewDialog(false)}
          onCreate={createItem}
        />
      )}

      {editingTask && (
        <NewBacklogTaskDialog
          onClose={() => setEditingItem(null)}
          onCreate={createItem}
          editTask={editingTask}
          onUpdate={updateItem}
        />
      )}

      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete backlog task"
          message={<>
            <p>This will permanently delete the backlog task.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {pendingBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} backlog tasks`}
          message={<>
            <p>This will permanently delete {selectedIds.size} backlog tasks.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel={`Delete ${selectedIds.size} items`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}

      {importSource && (
        <ImportDialog
          source={importSource}
          onClose={() => setImportSource(null)}
        />
      )}
    </div>
  );
}
