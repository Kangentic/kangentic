import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { GitHubIcon } from '../../icons/GitHubIcon';
import { formatRelativeTime, relativeTimeSamples } from '../../../lib/datetime';
import { DATA_TABLE_GRIP_WIDTH_PX, type DataTableColumn } from '../../DataTable';
import { Tooltip } from '../../Tooltip';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from '../../Pill';
import { PriorityBadge } from '../PriorityBadge';
import { stripMarkdown } from '../../../utils/strip-markdown';
import { measureTextWidth } from '../../../utils/text-measure';
import { CELL_PADDING_PX, priorityColumnWidthPx, updatedColumnWidthPx } from './column-widths';
import type { BacklogTask } from '../../../../shared/types';
import { getProviderLabel } from '../import-providers';
import { isLocalNoteLink, openExternalIssueLink } from '../../../utils/external-issue-link';
import { BacklogRowActions, ROW_MENU_BUTTON_SIZE_PX } from './BacklogRowActions';

export type SortKey = 'select' | 'priority' | 'title' | 'labels' | 'updated' | 'actions';

/** The narrowest Title the table keeps before it scrolls sideways. */
const TITLE_MIN_WIDTH_PX = 240;

const SELECT_WIDTH_PX = 40;
const LABELS_WIDTH_PX = 200;
/** The menu button inside the cell's padding. */
const ACTIONS_WIDTH_PX = ROW_MENU_BUTTON_SIZE_PX + CELL_PADDING_PX;

/**
 * Every column but Title, plus Title's own floor: the width under which the backlog table
 * scrolls sideways rather than squeezing Title to nothing (a 400px sidebar at the 900px window).
 */
export function backlogMinTableWidth(columns: ReadonlyArray<DataTableColumn<BacklogTask, SortKey>>, hasGrip: boolean): number {
  const fixed = columns
    .filter((column) => column.key !== 'title')
    .reduce((total, column) => total + (column.widthPx ?? 0), 0);
  return Math.ceil(fixed + TITLE_MIN_WIDTH_PX + (hasGrip ? DATA_TABLE_GRIP_WIDTH_PX : 0));
}

/**
 * Build the DataTable column definitions for the BacklogView table.
 * Memoized against the closed-over state so re-renders don't churn
 * column identity (which would defeat the DataTable virtualizer).
 */
export function useBacklogColumns(input: {
  selectedIds: Set<string>;
  labelColors: Record<string, string>;
  /** How many levels the project's priority scale has, None included. */
  priorityLevelCount: number;
  /** The row whose menu is open from its button, or null. */
  menuItemId: string | null;
  toggleSelected: (itemId: string) => void;
  selectAll: (ids: string[]) => void;
  openRowMenu: (itemId: string, button: HTMLElement) => void;
}): DataTableColumn<BacklogTask, SortKey>[] {
  const {
    selectedIds,
    labelColors,
    priorityLevelCount,
    menuItemId,
    toggleSelected,
    selectAll,
    openRowMenu,
  } = input;

  const { t, i18n } = useLingui();

  // Sized from what the columns can show in the session's language, so a translated header or
  // a longer date never paints into the next column. Recomputed when the language or the
  // priority scale changes.
  const priorityHeader = t({ message: 'Priority', context: 'column header' });
  const updatedHeader = t({ message: 'Updated', context: 'column header' });
  const priorityWidthPx = useMemo(
    () => priorityColumnWidthPx(priorityHeader, priorityLevelCount, measureTextWidth),
    [priorityHeader, priorityLevelCount],
  );
  const updatedWidthPx = useMemo(() => {
    return updatedColumnWidthPx(updatedHeader, relativeTimeSamples(), measureTextWidth);
    // i18n.locale: the samples are formatted in the session's language.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18n.locale is the trigger; relativeTimeSamples reads the locale itself
  }, [updatedHeader, i18n.locale]);

  // `t` is in the memo's deps so the headers and tips follow the session's catalog.
  return useMemo(() => {
    const openInSourceLabel = (externalSource: string | null | undefined, externalUrl: string): string => {
      if (isLocalNoteLink(externalUrl)) return t`Open file`;
      // A provider's own name, so it is not translated; any other source shows its raw id.
      const sourceName = externalSource ? getProviderLabel(externalSource) : externalSource;
      return t`Open in ${sourceName}`;
    };
    return [
    {
      key: 'select' as SortKey,
      label: '',
      widthPx: SELECT_WIDTH_PX,
      render: (item) => (
        // select-none-ok: the label wraps a bare checkbox and renders no text.
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
      label: priorityHeader,
      widthPx: priorityWidthPx,
      sortValue: (item) => item.priority,
      render: (item) => <PriorityBadge priority={item.priority} showNone />,
    },
    {
      key: 'title' as SortKey,
      label: t({ message: 'Title', context: 'column header' }),
      width: 'min-w-[300px]',
      sortValue: (item) => item.title.toLowerCase(),
      render: (item) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {item.external_source && item.external_url && (
              <Tooltip label={openInSourceLabel(item.external_source, item.external_url)}>
                <button
                  type="button"
                  className="shrink-0 text-fg-faint hover:text-fg transition-colors"
                  onClick={(event) => {
                    event.stopPropagation();
                    openExternalIssueLink(item.external_url!);
                  }}
                  aria-label={openInSourceLabel(item.external_source, item.external_url)}
                >
                  {item.external_source?.startsWith('github') ? <GitHubIcon size={13} /> : <ExternalLink size={13} />}
                </button>
              </Tooltip>
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
      label: t({ message: 'Labels', context: 'column header' }),
      widthPx: LABELS_WIDTH_PX,
      render: (item) =>
        item.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.labels.map((label) => {
              const color = labelColors[label];
              return (
                <Pill
                  key={label}
                  size="sm"
                  className={color ? 'font-medium border' : 'bg-surface-hover/60 text-fg-muted'}
                  style={color ? { color, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE } : undefined}
                >
                  {label}
                </Pill>
              );
            })}
          </div>
        ) : null,
    },
    {
      key: 'updated' as SortKey,
      label: updatedHeader,
      widthPx: updatedWidthPx,
      // Most recent activity first on the first click.
      initialSortDirection: 'desc',
      sortValue: (item) => item.updated_at,
      render: (item) => {
        const created = formatRelativeTime(item.created_at);
        return (
          <Tooltip label={t`Created ${created}`}>
            <span className="text-fg-faint text-xs whitespace-nowrap" data-testid="backlog-updated">
              {formatRelativeTime(item.updated_at)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'actions' as SortKey,
      label: '',
      widthPx: ACTIONS_WIDTH_PX,
      render: (item) => (
        <BacklogRowActions itemId={item.id} menuOpen={menuItemId === item.id} onOpenMenu={openRowMenu} />
      ),
    },
    ];
  }, [selectedIds, toggleSelected, selectAll, openRowMenu, menuItemId, labelColors, priorityHeader, priorityWidthPx, updatedHeader, updatedWidthPx, t]);
}
