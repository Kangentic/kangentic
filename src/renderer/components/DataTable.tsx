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
  /** Hover explanation for the column header (what the stat means). Sortable
   *  columns get the sort hint appended automatically. */
  headerTitle?: string;
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

export interface SortLevel<TKey extends string = string> {
  key: TKey;
  direction: 'asc' | 'desc';
}

/** Subset of DataTableColumn the sort algorithms need. */
interface SortableColumn<TRow, TKey extends string> {
  key: TKey;
  align?: 'left' | 'right';
  sortValue?: (row: TRow) => number | string;
}

/**
 * Computes the next ordered sort-level array for a header click. Pure and
 * exported so the direction-anchored asc/desc/clear cycle and Shift+Click
 * multi-sort transitions can be unit tested without mounting the table.
 *
 * - Numeric (right-aligned) columns start descending, text columns
 *   ascending; a repeat plain click flips, a third clears back to
 *   manual/position order.
 * - Shift+Click adds the column as a tie-break level (or flips its
 *   direction if it is already a level) and never clears.
 * - A plain click on a column other than the sole active sort collapses to
 *   a single sort on the clicked column.
 */
export function computeNextSorts<TRow, TKey extends string>(
  sorts: Array<SortLevel<TKey>>,
  column: SortableColumn<TRow, TKey>,
  shiftKey: boolean,
): Array<SortLevel<TKey>> {
  const initialDirection: 'asc' | 'desc' = column.align === 'right' ? 'desc' : 'asc';
  const existingIndex = sorts.findIndex((level) => level.key === column.key);

  if (shiftKey && sorts.length > 0) {
    return existingIndex >= 0
      ? sorts.map((level, index) => (index === existingIndex
          ? { ...level, direction: level.direction === 'asc' ? 'desc' : 'asc' }
          : level))
      : [...sorts, { key: column.key, direction: initialDirection }];
  }
  if (existingIndex === 0 && sorts.length === 1) {
    return sorts[0].direction === initialDirection
      ? [{ key: column.key, direction: initialDirection === 'asc' ? 'desc' : 'asc' }]
      : [];
  }
  return [{ key: column.key, direction: initialDirection }];
}

/**
 * Applies ordered sort levels to `data`. Index 0 is the primary sort; later
 * levels break ties left to right. Pure and exported for the same reason as
 * `computeNextSorts`.
 */
export function sortRows<TRow, TKey extends string>(
  data: TRow[],
  sorts: Array<SortLevel<TKey>>,
  columns: Array<SortableColumn<TRow, TKey>>,
): TRow[] {
  if (sorts.length === 0) return data;
  const levels = sorts
    .map((level) => ({ direction: level.direction, extractValue: columns.find((column) => column.key === level.key)?.sortValue }))
    .filter((level): level is { direction: 'asc' | 'desc'; extractValue: (row: TRow) => number | string } => !!level.extractValue);
  if (levels.length === 0) return data;

  return [...data].sort((rowA, rowB) => {
    for (const level of levels) {
      const valueA = level.extractValue(rowA);
      const valueB = level.extractValue(rowB);
      const comparison = typeof valueA === 'string' && typeof valueB === 'string'
        ? valueA.localeCompare(valueB)
        : (valueA as number) - (valueB as number);
      if (comparison !== 0) return level.direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  });
}

/** Sortable row wrapper - renders a drag handle and applies transform/transition styles. */
function SortableRow<TRow, TKey extends string>({
  row,
  rowId,
  columns,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  rowTestId,
}: {
  row: TRow;
  rowId: string;
  columns: DataTableColumn<TRow, TKey>[];
  onRowClick?: (row: TRow) => void;
  onRowDoubleClick?: (row: TRow) => void;
  onRowContextMenu?: (row: TRow, event: React.MouseEvent) => void;
  rowTestId?: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rowId });

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
      data-row-id={rowId}
    >
      {/* Drag handle cell */}
      <td className="w-[32px] px-1 py-2.5">
        <div
          {...attributes}
          {...listeners}
          className="flex items-center justify-center text-fg-disabled hover:text-fg-muted cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
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
  // Ordered sort levels: index 0 is the primary sort, later entries break
  // ties (added via Shift+Click).
  const [sorts, setSorts] = useState<Array<{ key: TKey; direction: 'asc' | 'desc' }>>(
    defaultSortKey ? [{ key: defaultSortKey, direction: defaultSortDirection }] : [],
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleHeaderClick = (column: DataTableColumn<TRow, TKey>, shiftKey: boolean) => {
    if (!column.sortValue) return;
    const newSorts = computeNextSorts(sorts, column, shiftKey);
    setSorts(newSorts);
    onSortChange?.(newSorts[0]?.key);
  };

  const sortedData = useMemo(() => sortRows(data, sorts, columns), [data, sorts, columns]);

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
        const sortIndex = sorts.findIndex((level) => level.key === column.key);
        const isActive = sortIndex >= 0;
        const headerTitle = [
          column.headerTitle,
          isSortable ? 'Click to sort - Shift+Click adds a secondary sort' : undefined,
        ].filter(Boolean).join('\n');
        return (
          <th
            key={`${column.key}-${columnIndex}`}
            className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint select-none transition-colors ${column.width || ''} ${column.align === 'right' ? 'text-right' : 'text-left'} ${isSortable ? 'cursor-pointer hover:text-fg-muted' : ''}`}
            onClick={isSortable ? (event) => handleHeaderClick(column, event.shiftKey) : undefined}
            title={headerTitle || undefined}
          >
            {column.headerRender ? (
              column.headerRender(sortedData)
            ) : (
              // For right-aligned columns the sort indicator must sit to the
              // LEFT of the label, otherwise the label's right edge is offset
              // by the indicator slot's width and visibly drifts left of the
              // numeric values below it.
              <span className={`inline-flex items-center gap-1 ${column.align === 'right' ? 'flex-row-reverse' : ''}`}>
                {column.label}
                {isSortable && (
                  <span className="w-3 h-3 flex items-center justify-center">
                    {isActive && (
                      sorts[sortIndex].direction === 'asc'
                        ? <ArrowUp size={12} className="text-accent-fg" />
                        : <ArrowDown size={12} className="text-accent-fg" />
                    )}
                  </span>
                )}
                {/* Tie-break priority, shown only when multiple levels are active. */}
                {isActive && sorts.length > 1 && (
                  <span className="text-[11px] text-accent-fg tabular-nums" data-testid="sort-priority">{sortIndex + 1}</span>
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
                      data-row-id={id}
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
                data-row-id={rowKey(row)}
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
