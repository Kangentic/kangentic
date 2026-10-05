import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatDuration, formatCost } from '../../utils/format-session';
import type { PerToolStat } from '../../../shared/types';

// Tool durations are often sub-second (Read, Edit, Grep). The shared
// `formatDuration` helper rounds to seconds, so it would render every
// fast tool as "0s". Use a finer-grained format here.
function formatToolDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return formatDuration(milliseconds);
}

function formatOptionalDuration(milliseconds: number | undefined) {
  return milliseconds === undefined
    ? <span className="text-fg-disabled">-</span>
    : formatToolDuration(milliseconds);
}

type SortKey = 'tool' | 'calls' | 'time' | 'avg' | 'tokens' | 'cost' | 'inputTokens' | 'outputTokens';
type NumericSortKey = Exclude<SortKey, 'tool'>;

interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const DEFAULT_SORT: SortState = { key: 'calls', direction: 'desc' };

const TOKENS_COLUMN_TITLE = 'Estimated tokens this tool\'s output added to the main conversation. Not billed tokens; subagent calls are not counted.';

const AVG_COLUMN_TITLE = 'Average run time of the calls Time counts.';

/** Header tooltip for Time, naming how many calls it leaves out. */
function timeColumnTitle(waitedCalls: number): string {
  if (waitedCalls === 0) return 'How long each tool ran.';
  const leftOut = waitedCalls === 1 ? 'the 1 call that' : `the ${waitedCalls} calls that`;
  return `How long each tool ran. Leaves out ${leftOut} waited for your answer or approval.`;
}

/** Calls whose run time `totalDurationMs` holds: every call except the ones that waited on the user. */
function timedCallCount(row: PerToolStat): number {
  return row.callCount + row.interruptedCount - (row.waitedCount ?? 0);
}

/** Undefined when every call waited on the user, so there is no run time to show. */
function runTimeMs(row: PerToolStat): number | undefined {
  return timedCallCount(row) > 0 ? row.totalDurationMs : undefined;
}

function averageDurationMs(row: PerToolStat): number | undefined {
  const timedCalls = timedCallCount(row);
  return timedCalls > 0 ? Math.round(row.totalDurationMs / timedCalls) : undefined;
}

/** The value a numeric column sorts by; undefined when the row has none. */
const SORT_VALUE: Record<NumericSortKey, (row: PerToolStat) => number | undefined> = {
  calls: (row) => row.callCount,
  time: runTimeMs,
  avg: averageDurationMs,
  tokens: (row) => row.resultTokens,
  cost: (row) => row.costUsd,
  inputTokens: (row) => row.inputTokens,
  outputTokens: (row) => row.outputTokens,
};

/**
 * Compare two rows under `sort`. A row with no value for the column sorts last
 * in both directions, and ties fall back to the tool name, so equal rows keep
 * one order across the live popover's refetches.
 */
function compareRows(left: PerToolStat, right: PerToolStat, sort: SortState): number {
  const byName = left.toolName.localeCompare(right.toolName);
  if (sort.key === 'tool') return sort.direction === 'asc' ? byName : -byName;
  const readValue = SORT_VALUE[sort.key];
  const leftValue = readValue(left);
  const rightValue = readValue(right);
  if (leftValue === undefined || rightValue === undefined) {
    if (leftValue === rightValue) return byName;
    return leftValue === undefined ? 1 : -1;
  }
  const difference = sort.direction === 'asc' ? leftValue - rightValue : rightValue - leftValue;
  return difference || byName;
}

const VALUE_CELL_CLASS = 'py-1 pr-3 last:pr-0 text-right text-fg-secondary';

function formatOptionalValue(value: number | undefined, format: (value: number) => string): string {
  return typeof value === 'number' ? format(value) : '-';
}

/** A sortable column after Tool and Calls, shown only when some row has a value for it. */
interface ValueColumn {
  key: Exclude<NumericSortKey, 'calls'>;
  label: string;
  /** Header tooltip, given the table's count of calls that waited on the user. */
  title?: (waitedCalls: number) => string;
  cell: (row: PerToolStat) => ReactNode;
}

const VALUE_COLUMNS: ValueColumn[] = [
  { key: 'time', label: 'Time', title: timeColumnTitle, cell: (row) => formatOptionalDuration(runTimeMs(row)) },
  { key: 'avg', label: 'Avg', title: () => AVG_COLUMN_TITLE, cell: (row) => formatOptionalDuration(averageDurationMs(row)) },
  { key: 'tokens', label: 'Tokens', title: () => TOKENS_COLUMN_TITLE, cell: (row) => formatOptionalValue(row.resultTokens, formatTokenCount) },
  { key: 'cost', label: 'Cost', cell: (row) => formatOptionalValue(row.costUsd, formatCost) },
  { key: 'inputTokens', label: 'In', cell: (row) => formatOptionalValue(row.inputTokens, formatTokenCount) },
  { key: 'outputTokens', label: 'Out', cell: (row) => formatOptionalValue(row.outputTokens, formatTokenCount) },
];

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  title?: string;
}) {
  const active = sort.key === sortKey;
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th
      className={`${align === 'left' ? 'text-left' : 'text-right'} font-normal pt-2 pb-1 pr-3 last:pr-0`}
      aria-sort={ariaSort}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title}
        className={`inline-flex items-center gap-0.5 cursor-pointer rounded-sm hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${active ? 'text-fg-secondary' : ''}`}
        data-testid={`by-tool-sort-${sortKey}`}
      >
        {label}
        {active && (sort.direction === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    </th>
  );
}

interface ByToolTableProps {
  rows: PerToolStat[];
}

/**
 * Per-tool breakdown table (Tool / Calls / Time / Avg, plus optional
 * Tokens / Cost / In / Out / Failed columns when the data is present). Tokens
 * is the `resultTokens` estimate, named by its unit; its header tooltip says
 * it is an estimate rather than marking every cell. Shared by
 * the archived-task Session Summary (DB-fed) and the live ContextBar tool-call
 * popover (telemetry-fed), so the two surfaces render and sort identically.
 *
 * Every numeric header sorts on click: the active column shows a chevron, a
 * second click reverses it. The default is Calls, most first. Time and Avg
 * hide when no row carries a duration (the count-only rows the transcript
 * backfill writes), since a 0 there means "not measured", not "instant".
 *
 * Time is run time only: calls that waited on the user are left out of Time
 * and Avg (`PerToolStat.waitedCount`), and the Time header says how many. A
 * tool whose every call waited (AskUserQuestion, ExitPlanMode) shows "-" in
 * both and sorts last on either.
 */
export function ByToolTable({ rows }: ByToolTableProps) {
  const [requestedSort, setRequestedSort] = useState<SortState>(DEFAULT_SORT);

  const hasDurations = rows.some((row) => row.totalDurationMs > 0);
  const anyResultTokens = rows.some((row) => typeof row.resultTokens === 'number');
  const anyCost = rows.some((row) => typeof row.costUsd === 'number');
  const anyInputTokens = rows.some((row) => typeof row.inputTokens === 'number');
  const anyOutputTokens = rows.some((row) => typeof row.outputTokens === 'number');
  const anyInterrupted = rows.some((row) => row.interruptedCount > 0);
  const waitedCalls = rows.reduce((sum, row) => sum + (row.waitedCount ?? 0), 0);

  // A column that disappears (a refetch with no durations yet) takes its sort
  // with it, back to the default rather than an order nothing on screen explains.
  const columnShown: Record<SortKey, boolean> = {
    tool: true,
    calls: true,
    time: hasDurations,
    avg: hasDurations,
    tokens: anyResultTokens,
    cost: anyCost,
    inputTokens: anyInputTokens,
    outputTokens: anyOutputTokens,
  };
  const sort = columnShown[requestedSort.key] ? requestedSort : DEFAULT_SORT;

  const sortedRows = useMemo(
    () => rows.slice().sort((left, right) => compareRows(left, right, sort)),
    [rows, sort],
  );

  const handleSort = (key: SortKey): void => {
    setRequestedSort(sort.key === key
      ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'tool' ? 'asc' : 'desc' });
  };

  const valueColumns = VALUE_COLUMNS.filter((column) => columnShown[column.key]);

  return (
    <div
      data-testid="session-summary-by-tool"
      className="px-4 pb-3 overflow-x-auto border-t border-edge/40"
    >
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-fg-faint">
            <SortableHeader label="Tool" sortKey="tool" sort={sort} onSort={handleSort} align="left" />
            <SortableHeader label="Calls" sortKey="calls" sort={sort} onSort={handleSort} />
            {valueColumns.map((column) => (
              <SortableHeader
                key={column.key}
                label={column.label}
                sortKey={column.key}
                sort={sort}
                onSort={handleSort}
                title={column.title?.(waitedCalls)}
              />
            ))}
            {anyInterrupted && <th className="text-right font-normal pt-2 pb-1">Failed</th>}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.toolName} className="border-t border-edge/40">
              <td className="py-1 pr-3 last:pr-0 text-fg-secondary font-mono max-w-[180px] truncate" title={row.toolName}>
                {row.toolName}
              </td>
              <td className={VALUE_CELL_CLASS}>{row.callCount}</td>
              {valueColumns.map((column) => (
                <td key={column.key} className={VALUE_CELL_CLASS}>{column.cell(row)}</td>
              ))}
              {anyInterrupted && (
                <td className="py-1 text-right">
                  {row.interruptedCount > 0
                    ? <span className="inline-flex items-center gap-0.5 text-amber-400/80"><AlertTriangle size={10} />{row.interruptedCount}</span>
                    : <span className="text-fg-disabled">-</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
