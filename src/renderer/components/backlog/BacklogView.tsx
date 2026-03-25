import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Plus, Search, SquareArrowOutUpRight, Trash2, Inbox, Tags, Flag, Filter, Pencil, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { Pill } from '../Pill';
import { PriorityBadge } from './PriorityBadge';
import { PromotePopover } from './PromotePopover';
import { BacklogContextMenu } from './BacklogContextMenu';
import { BacklogBulkToolbar } from './BacklogBulkToolbar';
import { NewBacklogItemDialog } from './NewBacklogItemDialog';
import { LabelsPopover, PrioritiesPopover } from './ManageLabelsDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { CountBadge } from '../CountBadge';
import { useBacklogDragDrop } from '../../hooks/useBacklogDragDrop';
import { useBacklogStore } from '../../stores/backlog-store';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import type { BacklogItem } from '../../../shared/types';

type SortKey = 'select' | 'priority' | 'title' | 'labels' | 'created' | 'actions';

// --- Row actions ---

function RowActions({
  itemId,
  swimlanes,
  onPromote,
  onEdit,
  onDelete,
}: {
  itemId: string;
  swimlanes: ReturnType<typeof useBoardStore.getState>['swimlanes'];
  onPromote: (itemId: string, swimlaneId: string) => void;
  onEdit: (itemId: string) => void;
  onDelete: (itemId: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const promoteButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex items-center justify-end gap-1 relative" onClick={(event) => event.stopPropagation()}>
      <div className="relative">
        <button
          ref={promoteButtonRef}
          type="button"
          onClick={() => setShowPicker(!showPicker)}
          className="p-1.5 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
          title="Move to board"
          data-testid="promote-item-btn"
        >
          <SquareArrowOutUpRight size={15} />
        </button>
        {showPicker && (
          <PromotePopover
            triggerRef={promoteButtonRef}
            swimlanes={swimlanes}
            onSelect={(swimlaneId) => {
              setShowPicker(false);
              onPromote(itemId, swimlaneId);
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
  const config = useConfigStore((state) => state.config);
  const skipDeleteConfirm = config.skipDeleteConfirm;
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const labelColors = config.backlog?.labelColors ?? {};

  const [searchQuery, setSearchQuery] = useState('');
  const [priorityFilters, setPriorityFilters] = useState<Set<number>>(new Set());
  const [labelFilters, setLabelFilters] = useState<Set<string>>(new Set());
  const [showFilterPopover, setShowFilterPopover] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<BacklogItem | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; item: BacklogItem } | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);

  // Config-driven priorities
  const priorities = config.backlog?.priorities ?? [
    { label: 'None', color: '#6b7280' },
    { label: 'Low', color: '#6b7280' },
    { label: 'Medium', color: '#eab308' },
    { label: 'High', color: '#f97316' },
    { label: 'Urgent', color: '#ef4444' },
  ];

  // All unique labels across backlog items
  const allLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const item of items) {
      for (const label of item.labels) labelSet.add(label);
    }
    return [...labelSet].sort();
  }, [items]);

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

  // --- Sort state (for disabling drag when column-sorted) ---
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

  // --- Drag-to-reorder ---
  const canDrag = !isColumnSorted && !hasActiveFilters && !searchQuery.trim();
  const {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useBacklogDragDrop(filteredItems);

  // --- Action handlers ---

  const handlePromoteSingle = useCallback(async (itemId: string, swimlaneId: string) => {
    await promoteItems([itemId], swimlaneId);
  }, [promoteItems]);

  const handleBulkPromote = useCallback(async (swimlaneId: string) => {
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

  const handleRowContextMenu = useCallback((item: BacklogItem, event: React.MouseEvent) => {
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, item });
  }, []);

  // --- Columns ---

  const columns: DataTableColumn<BacklogItem, SortKey>[] = useMemo(() => [
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
            data-testid="backlog-item-checkbox"
          />
        </label>
      ),
      headerRender: (data: BacklogItem[]) => (
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
          <div className="text-fg font-medium truncate">{item.title}</div>
          {item.description && (
            <div className="text-xs text-fg-faint truncate mt-0.5">{item.description}</div>
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
                  className={color ? 'font-medium' : 'bg-surface-hover/60 text-fg-muted'}
                  style={color ? { backgroundColor: `${color}20`, color, border: `1px solid ${color}30` } : undefined}
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
          onPromote={handlePromoteSingle}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      ),
    },
  ], [selectedIds, toggleSelected, selectAll, swimlanes, handlePromoteSingle, handleEdit, handleDelete, labelColors]);

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
          data-testid="new-backlog-item-btn"
        >
          <Plus size={14} />
          New Task
        </button>

        <LabelsPopover />
        <PrioritiesPopover />

        <div className="flex-1" />

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search backlog..."
            className="w-56 bg-surface/50 border border-edge/50 rounded-md text-sm text-fg placeholder-fg-disabled pl-8 pr-3 py-1.5 outline-none focus:border-edge-input"
            data-testid="backlog-search"
          />
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
                      onClick={() => togglePriorityFilter(index)}
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
                          className={`font-medium ${isActive ? 'ring-1 ring-fg-muted' : ''}`}
                          style={{
                            backgroundColor: `${priority.color}20`,
                            color: priority.color,
                            border: `1px solid ${priority.color}30`,
                          }}
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
                          onClick={() => toggleLabelFilter(label)}
                          className="flex items-center justify-center"
                        >
                          <Pill
                            size="sm"
                            className={color
                              ? `font-medium w-full ${isActive ? 'ring-1 ring-fg-muted' : ''}`
                              : `w-full ${isActive ? 'bg-surface-hover text-fg ring-1 ring-fg-muted' : 'bg-surface-hover/60 text-fg-muted'}`
                            }
                            style={color ? {
                              backgroundColor: `${color}20`,
                              color,
                              border: `1px solid ${color}30`,
                            } : undefined}
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
                    onClick={() => { setPriorityFilters(new Set()); setLabelFilters(new Set()); }}
                    className="w-full px-3 py-1.5 text-xs text-fg-secondary hover:text-fg text-left hover:bg-surface-hover/30 flex items-center gap-1.5"
                  >
                    <X size={12} />
                    Clear all filters
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 relative">
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
                <DataTable<BacklogItem, SortKey>
                  columns={columns}
                  data={filteredItems}
                  rowKey={(item) => item.id}
                  onRowClick={(item) => toggleSelected(item.id)}
                  onRowDoubleClick={(item) => handleEdit(item.id)}
                  onRowContextMenu={handleRowContextMenu}
                  emptyMessage={emptyMessage}
                  rowTestId="backlog-item-row"
                  virtualized
                  sortableEnabled={canDrag}
                  onSortChange={(key) => setIsColumnSorted(key !== undefined)}
                />
              </SortableContext>
            </DndContext>
            {selectedIds.size > 0 && (
              <BacklogBulkToolbar
                selectedCount={selectedIds.size}
                swimlanes={swimlanes}
                onPromote={handleBulkPromote}
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
          onPromote={(swimlaneId) => handlePromoteSingle(contextMenu.item.id, swimlaneId)}
          onEdit={() => handleEdit(contextMenu.item.id)}
          onDelete={() => handleDelete(contextMenu.item.id)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Dialogs */}
      {showNewDialog && (
        <NewBacklogItemDialog
          onClose={() => setShowNewDialog(false)}
          onCreate={createItem}
        />
      )}

      {editingItem && (
        <NewBacklogItemDialog
          onClose={() => setEditingItem(null)}
          onCreate={createItem}
          editItem={editingItem}
          onUpdate={updateItem}
        />
      )}

      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete backlog item"
          message={<>
            <p>This will permanently delete the backlog item.</p>
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
          title={`Delete ${selectedIds.size} backlog items`}
          message={<>
            <p>This will permanently delete {selectedIds.size} backlog items.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel={`Delete ${selectedIds.size} items`}
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}
    </div>
  );
}
