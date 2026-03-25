import React, { useState, useMemo, useRef } from 'react';
import { ArrowUp, ArrowDown, GripVertical } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export interface DataTableColumn<TRow, TKey extends string = string> {
  key: TKey;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  sortValue?: (row: TRow) => number | string;
  render: (row: TRow) => React.ReactNode;
  headerRender?: (data: TRow[]) => React.ReactNode;
}

interface DataTableProps<TRow, TKey extends string = string> {
  columns: DataTableColumn<TRow, TKey>[];
  data: TRow[];
  rowKey: (row: TRow) => string;
  onRowClick?: (row: TRow) => void;
  onRowDoubleClick?: (row: TRow) => void;
  onRowContextMenu?: (row: TRow, event: React.MouseEvent) => void;
  defaultSortKey?: TKey;
  defaultSortDirection?: 'asc' | 'desc';
  emptyMessage?: string;
  rowTestId?: string;
  virtualized?: boolean;
  /** Enable drag-to-reorder rows. Requires wrapping with DndContext + SortableContext. */
  sortableEnabled?: boolean;
  /** Called when sort state changes so parent can detect column-sort vs manual order. */
  onSortChange?: (sortKey: TKey | undefined) => void;
}

const ESTIMATED_ROW_HEIGHT = 45;

/** Sortable row wrapper - renders a drag handle and applies transform/transition styles. */
function SortableRow<TRow, TKey extends string>({
  row,
  rowId,
  columns,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  rowTestId,
  isDragDisabled,
}: {
  row: TRow;
  rowId: string;
  columns: DataTableColumn<TRow, TKey>[];
  onRowClick?: (row: TRow) => void;
  onRowDoubleClick?: (row: TRow) => void;
  onRowContextMenu?: (row: TRow, event: React.MouseEvent) => void;
  rowTestId?: string;
  isDragDisabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rowId, disabled: isDragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: 'relative',
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick || onRowDoubleClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
      onContextMenu={onRowContextMenu ? (event) => { event.preventDefault(); onRowContextMenu(row, event); } : undefined}
      data-testid={rowTestId}
    >
      {/* Drag handle cell */}
      <td className="w-[32px] px-1 py-2.5">
        <div
          {...attributes}
          {...listeners}
          className={`flex items-center justify-center ${
            isDragDisabled
              ? 'text-fg-disabled/30 cursor-not-allowed'
              : 'text-fg-disabled hover:text-fg-muted cursor-grab active:cursor-grabbing'
          }`}
          title={isDragDisabled ? 'Clear column sort to drag' : 'Drag to reorder'}
        >
          <GripVertical size={14} />
        </div>
      </td>
      {columns.map((column, columnIndex) => (
        <td
          key={`${column.key}-${columnIndex}`}
          className={`px-3 py-2.5 ${column.width || ''} ${column.align === 'right' ? 'text-right' : ''}`}
        >
          {column.render(row)}
        </td>
      ))}
    </tr>
  );
}

export function DataTable<TRow, TKey extends string = string>({
  columns,
  data,
  rowKey,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  defaultSortKey,
  defaultSortDirection = 'desc',
  emptyMessage = 'No data',
  rowTestId,
  virtualized = false,
  sortableEnabled = false,
  onSortChange,
}: DataTableProps<TRow, TKey>) {
  const [sortKey, setSortKey] = useState<TKey | undefined>(defaultSortKey);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(defaultSortDirection);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleHeaderClick = (column: DataTableColumn<TRow, TKey>) => {
    if (!column.sortValue) return;
    let newSortKey: TKey | undefined;
    if (sortKey === column.key) {
      // Clicking the same column cycles: asc -> desc -> clear
      if (sortDirection === 'asc') {
        setSortDirection('desc');
        newSortKey = column.key;
      } else {
        // Clear sort (return to manual/position order)
        setSortKey(undefined);
        newSortKey = undefined;
      }
    } else {
      setSortKey(column.key);
      setSortDirection(column.align === 'left' || !column.align ? 'asc' : 'desc');
      newSortKey = column.key;
    }
    if (newSortKey === undefined) setSortKey(undefined);
    onSortChange?.(newSortKey);
  };

  const isColumnSorted = sortKey !== undefined;
  const isDragDisabled = isColumnSorted;

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    const activeColumn = columns.find((column) => column.key === sortKey);
    if (!activeColumn?.sortValue) return data;
    const extractValue = activeColumn.sortValue;

    return [...data].sort((rowA, rowB) => {
      const valueA = extractValue(rowA);
      const valueB = extractValue(rowB);

      let comparison: number;
      if (typeof valueA === 'string' && typeof valueB === 'string') {
        comparison = valueA.localeCompare(valueB);
      } else {
        comparison = (valueA as number) - (valueB as number);
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortKey, sortDirection, columns]);

  const virtualizer = useVirtualizer({
    count: sortedData.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 10,
    enabled: virtualized,
  });

  const headerRow = (
    <tr className="border-b-2 border-edge bg-surface-raised">
      {/* Drag handle header cell (empty) */}
      {sortableEnabled && <th className="w-[32px]" />}
      {columns.map((column, columnIndex) => {
        const isSortable = !!column.sortValue;
        const isActive = sortKey === column.key;
        return (
          <th
            key={`${column.key}-${columnIndex}`}
            className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint select-none transition-colors ${column.width || ''} ${column.align === 'right' ? 'text-right' : 'text-left'} ${isSortable ? 'cursor-pointer hover:text-fg-muted' : ''}`}
            onClick={isSortable ? () => handleHeaderClick(column) : undefined}
          >
            {column.headerRender ? (
              column.headerRender(sortedData)
            ) : (
              <span className="inline-flex items-center gap-1">
                {column.label}
                {isSortable && (
                  <span className="w-3 h-3 flex items-center justify-center">
                    {isActive && (
                      sortDirection === 'asc'
                        ? <ArrowUp size={12} className="text-accent-fg" />
                        : <ArrowDown size={12} className="text-accent-fg" />
                    )}
                  </span>
                )}
              </span>
            )}
          </th>
        );
      })}
    </tr>
  );

  if (virtualized) {
    const virtualItems = virtualizer.getVirtualItems();

    return (
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 z-10">
            {headerRow}
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (sortableEnabled ? 1 : 0)} className="px-3 py-8 text-center text-fg-disabled text-sm">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              <>
                {virtualItems.length > 0 && virtualItems[0].start > 0 && (
                  <tr>
                    <td colSpan={columns.length + (sortableEnabled ? 1 : 0)} style={{ height: virtualItems[0].start, padding: 0 }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const row = sortedData[virtualRow.index];
                  const id = rowKey(row);

                  if (sortableEnabled) {
                    return (
                      <SortableRow
                        key={id}
                        row={row}
                        rowId={id}
                        columns={columns}
                        onRowClick={onRowClick}
                        onRowDoubleClick={onRowDoubleClick}
                        onRowContextMenu={onRowContextMenu}
                        rowTestId={rowTestId}
                        isDragDisabled={isDragDisabled}
                      />
                    );
                  }

                  return (
                    <tr
                      key={id}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick || onRowDoubleClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
                      onContextMenu={onRowContextMenu ? (event) => { event.preventDefault(); onRowContextMenu(row, event); } : undefined}
                      data-testid={rowTestId}
                    >
                      {columns.map((column, columnIndex) => (
                        <td
                          key={`${column.key}-${columnIndex}`}
                          className={`px-3 py-2.5 overflow-hidden ${column.width || ''} ${column.align === 'right' ? 'text-right' : ''}`}
                        >
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={columns.length + (sortableEnabled ? 1 : 0)}
                      style={{
                        height: virtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1].end),
                        padding: 0,
                      }}
                    />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  // Non-virtualized (default) path
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 z-10">
          {headerRow}
        </thead>
        <tbody>
          {sortedData.map((row) => {
            if (sortableEnabled) {
              const id = rowKey(row);
              return (
                <SortableRow
                  key={id}
                  row={row}
                  rowId={id}
                  columns={columns}
                  onRowClick={onRowClick}
                  onRowDoubleClick={onRowDoubleClick}
                  onRowContextMenu={onRowContextMenu}
                  rowTestId={rowTestId}
                  isDragDisabled={isDragDisabled}
                />
              );
            }
            return (
              <tr
                key={rowKey(row)}
                className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick || onRowDoubleClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row) : undefined}
                onContextMenu={onRowContextMenu ? (event) => { event.preventDefault(); onRowContextMenu(row, event); } : undefined}
                data-testid={rowTestId}
              >
                {columns.map((column, columnIndex) => (
                  <td
                    key={`${column.key}-${columnIndex}`}
                    className={`px-3 py-2.5 overflow-hidden ${column.width || ''} ${column.align === 'right' ? 'text-right' : ''}`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {sortedData.length === 0 && (
            <tr>
              <td colSpan={columns.length + (sortableEnabled ? 1 : 0)} className="px-3 py-8 text-center text-fg-disabled text-sm">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
