import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { GitHubIcon } from '../../icons/GitHubIcon';
import { formatRelativeTime } from '../../../lib/datetime';
import type { DataTableColumn } from '../../DataTable';
import { Pill } from '../../Pill';
import { PriorityBadge } from '../PriorityBadge';
import { stripMarkdown } from '../../../utils/strip-markdown';
import type { BacklogTask } from '../../../../shared/types';
import type { useBoardStore } from '../../../stores/board-store';
import { BacklogRowActions } from './BacklogRowActions';

export type SortKey = 'select' | 'priority' | 'title' | 'labels' | 'created' | 'actions';

type Swimlanes = ReturnType<typeof useBoardStore.getState>['swimlanes'];

/**
 * Build the DataTable column definitions for the BacklogView table.
 * Memoized against the closed-over state so re-renders don't churn
 * column identity (which would defeat the DataTable virtualizer).
 */
export function useBacklogColumns(input: {
  selectedIds: Set<string>;
  swimlanes: Swimlanes;
  labelColors: Record<string, string>;
  toggleSelected: (itemId: string) => void;
  selectAll: (ids: string[]) => void;
  handleMoveSingle: (itemId: string, swimlaneId: string) => Promise<void>;
  handleEdit: (itemId: string) => void;
  handleDelete: (itemId: string) => void;
}): DataTableColumn<BacklogTask, SortKey>[] {
  const {
    selectedIds,
    swimlanes,
    labelColors,
    toggleSelected,
    selectAll,
    handleMoveSingle,
    handleEdit,
    handleDelete,
  } = input;

  return useMemo(() => [
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
                {item.external_source?.startsWith('github') ? <GitHubIcon size={13} /> : <ExternalLink size={13} />}
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
          {formatRelativeTime(item.created_at)}
        </span>
      ),
    },
    {
      key: 'actions' as SortKey,
      label: '',
      width: 'w-[100px]',
      render: (item) => (
        <BacklogRowActions
          itemId={item.id}
          swimlanes={swimlanes}
          onMoveToBoard={handleMoveSingle}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      ),
    },
  ], [selectedIds, toggleSelected, selectAll, swimlanes, handleMoveSingle, handleEdit, handleDelete, labelColors]);
}
