import React, { useState, useMemo } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

export interface DataTableColumn<TRow, TKey extends string = string> {
  key: TKey;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  sortValue?: (row: TRow) => number | string;
  render: (row: TRow) => React.ReactNode;
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
}

export function DataTable<TRow, TKey extends string = string>({
  columns,
  data,
  rowKey,
  onRowClick,
  defaultSortKey,
  defaultSortDirection = 'desc',
  emptyMessage = 'No data',
  rowTestId,
}: DataTableProps<TRow, TKey>) {
  const [sortKey, setSortKey] = useState<TKey | undefined>(defaultSortKey);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(defaultSortDirection);

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

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="border-b-2 border-edge bg-surface-inset/40">
            {columns.map((column) => {
              const isSortable = !!column.sortValue;
              const isActive = sortKey === column.key;
              return (
                <th
                  key={column.key}
                  className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint select-none transition-colors ${column.width || ''} ${column.align === 'right' ? 'text-right' : 'text-left'} ${isSortable ? 'cursor-pointer hover:text-fg-muted' : ''}`}
                  onClick={isSortable ? () => handleHeaderClick(column) : undefined}
                >
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
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-edge/30 transition-colors even:bg-surface/20 ${onRowClick ? 'hover:bg-surface-hover/30 cursor-pointer' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              data-testid={rowTestId}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
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
