import React, { useState, useMemo, useRef } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

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
  defaultSortKey?: TKey;
  defaultSortDirection?: 'asc' | 'desc';
  emptyMessage?: string;
  rowTestId?: string;
  virtualized?: boolean;
}

const ESTIMATED_ROW_HEIGHT = 45;

export function DataTable<TRow, TKey extends string = string>({
  columns,
  data,
  rowKey,
  onRowClick,
  defaultSortKey,
  defaultSortDirection = 'desc',
  emptyMessage = 'No data',
  rowTestId,
  virtualized = false,
}: DataTableProps<TRow, TKey>) {
  const [sortKey, setSortKey] = useState<TKey | undefined>(defaultSortKey);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(defaultSortDirection);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleHeaderClick = (column: DataTableColumn<TRow, TKey>) => {
    if (!column.sortValue) return;
    if (sortKey === column.key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(column.key);
      setSortDirection(column.align === 'left' || !column.align ? 'asc' : 'desc');
    }
  };

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
    <tr className="border-b-2 border-edge bg-surface-inset/40">
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
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            {headerRow}
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-fg-disabled text-sm">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              <>
                {virtualItems.length > 0 && virtualItems[0].start > 0 && (
                  <tr>
                    <td colSpan={columns.length} style={{ height: virtualItems[0].start, padding: 0 }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const row = sortedData[virtualRow.index];
                  return (
                    <tr
                      key={rowKey(row)}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      data-testid={rowTestId}
                    >
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
                })}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={columns.length}
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
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          {headerRow}
        </thead>
        <tbody>
          {sortedData.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              data-testid={rowTestId}
            >
              {columns.map((column, columnIndex) => (
                <td
                  key={`${column.key}-${columnIndex}`}
                  className={`px-3 py-2.5 ${column.width || ''} ${column.align === 'right' ? 'text-right' : ''}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {sortedData.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-fg-disabled text-sm">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
