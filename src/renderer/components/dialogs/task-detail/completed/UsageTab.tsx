import { Fragment, useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ArrowRight, FileText, Sparkles, SquareTerminal, Workflow, XCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../../i18n/translate';
import type { LocalizedText } from '../../../../../shared/i18n/text';
import { AutomationIcon } from '../../board-manager/automation-icons';
import { formatCallDuration, formatCost, formatSpan } from '../../../../utils/format-session';
import { formatTokenCount } from '../../../../utils/format-tokens';
import { formatDateTime, formatMonthDayTime } from '../../../../lib/datetime';
import { useConfigStore } from '../../../../stores/config-store';
import { AUTOMATION_MANIFEST } from '../../../../../shared/automation-manifest';
import { DEFAULT_PERMISSIONS, getPermissionLabel } from '../../../../../shared/types';
import { ColumnLabel, LinkButton, ReportCard, SessionPill, ToolCallsPill, ValuePill } from './report-parts';
import { Tooltip } from '../../../Tooltip';
import { computeNextSorts, sortHint, SortIndicator, sortRows, sortStateOf, type SortableColumn, type SortLevel } from '../../../DataTable';
import type {
  BackgroundCallJob,
  PermissionMode,
  TaskReport,
  TaskReportBackgroundCall,
  TaskReportBackgroundCallsTotal,
  TaskReportCallOutcome,
  TaskReportModelFallback,
  TaskReportModelsTotal,
  TaskReportModelUsage,
  TaskReportRun,
} from '../../../../../shared/types';

/** Background call rows listed before "Show all". */
const BACKGROUND_CALLS_SHOWN = 10;

type CellKind = 'header' | 'body' | 'total';

const CELL_BASE: Record<CellKind, string> = {
  header: 'whitespace-nowrap border-b border-edge py-2 text-[11px] font-medium text-fg-muted',
  body: 'h-11 whitespace-nowrap border-b border-edge/50 align-middle text-fg-secondary',
  total: 'h-[46px] whitespace-nowrap border-t border-fg-disabled align-middle font-semibold text-fg',
};

/**
 * A table cell's classes. Alignment and the left gutter are chosen here, never
 * layered over a default, so no two classes on a cell fight over one property.
 * The first column sits flush with the card's edge.
 */
function cellClass(kind: CellKind, align: 'left' | 'right', first = false): string {
  return `${CELL_BASE[kind]} ${align === 'left' ? 'text-left' : 'text-right'} ${first ? 'pl-0' : 'pl-3'}`;
}

/**
 * The tables sit in a container, so a column cell drops to its disc below
 * 860px (`ColumnLabel`) and the table fits a default-size window; past what
 * that saves, the table scrolls sideways rather than clipping.
 */
const AUTO_TABLE_WRAPPER = '@container overflow-x-auto';

/** The share of every table's width that its label columns hold. */
const LABEL_SHARE_PERCENT = 30;

/**
 * The grid every table on this tab shares: the label columns (Column, Session,
 * Call, Model) hold the first 30% and each data column takes an equal part of the
 * rest. Every card's data columns then start on one line, and Runs and
 * Background calls, which both have seven data columns unless Runs adds
 * Compactions, line up column for column. A column never narrows below its
 * content, so a long name widens its column rather than clipping.
 */
function ColumnGrid({ labelColumns, dataColumns }: { labelColumns: number; dataColumns: number }) {
  const dataColumnWidth = `${(100 - LABEL_SHARE_PERCENT) / dataColumns}%`;
  return (
    <colgroup>
      {Array.from({ length: labelColumns }, (_, index) => <col key={`label-${index}`} />)}
      {Array.from({ length: dataColumns }, (_, index) => <col key={`data-${index}`} style={{ width: dataColumnWidth }} />)}
    </colgroup>
  );
}

/** One sortable column of a Usage table: its header and how its rows compare. */
interface SortColumn<TRow, TKey extends string> extends SortableColumn<TRow, TKey> {
  /** A descriptor, resolved with `translateText` where the header renders. */
  label: LocalizedText;
  align: 'left' | 'right';
}

/**
 * A Usage table's sort, cycled as the Completed Tasks table cycles its own
 * (`computeNextSorts`): a number column puts the highest first, a text column
 * runs A to Z, a second click flips it and a third returns the table's own
 * order. A row with no value sorts last either way (`sortRows`). The Total
 * row is never a row here, so it stays at the bottom.
 */
function useSortedRows<TRow, TKey extends string>(rows: TRow[], columns: Array<SortColumn<TRow, TKey>>) {
  const [sorts, setSorts] = useState<Array<SortLevel<TKey>>>([]);
  const sortedRows = useMemo(() => sortRows(rows, sorts, columns), [rows, sorts, columns]);
  const sortBy = useCallback((column: SortColumn<TRow, TKey>, shiftKey: boolean) => {
    setSorts((current) => computeNextSorts(current, column, shiftKey));
  }, []);
  return { sorts, sortedRows, sortBy };
}

/**
 * A sortable header: a button, so the keyboard reaches it, with the shared
 * Shift+Click hint (`sortHint()`) and indicator (`SortIndicator`). On a right-aligned
 * number column the arrow sits left of the label, so the label stays flush with
 * the numbers under it.
 */
function SortHeader<TRow, TKey extends string>({ column, sorts, onSort, first = false, testIdPrefix }: {
  column: SortColumn<TRow, TKey>;
  sorts: Array<SortLevel<TKey>>;
  onSort: (column: SortColumn<TRow, TKey>, shiftKey: boolean) => void;
  first?: boolean;
  testIdPrefix: string;
}) {
  const sortIndex = sorts.findIndex((level) => level.key === column.key);
  return (
    <th className={cellClass('header', column.align, first)} aria-sort={sortStateOf(sortIndex === 0 ? sorts[0].direction : null)}>
      <Tooltip label={sortHint()}>
        <button
          type="button"
          onClick={(event) => onSort(column, event.shiftKey)}
          className={`inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            column.align === 'right' ? 'flex-row-reverse' : ''
          } ${sortIndex >= 0 ? 'text-fg-secondary' : ''}`}
          data-testid={`${testIdPrefix}-sort-${column.key}`}
        >
          {translateText(column.label)}
          <SortIndicator sorts={sorts} sortIndex={sortIndex} />
        </button>
      </Tooltip>
    </th>
  );
}

/** Every total comes computed with the report (`assembleTaskReport`); the cards only format them. */
export function UsageTab({ report }: { report: TaskReport }) {
  return (
    <div className="flex flex-col gap-5">
      {report.totals.runs.runCount > 0
        ? <RunsCard report={report} />
        : <div className="py-8 text-center text-sm text-fg-disabled" data-testid="completed-no-runs"><Trans>No agent runs on record</Trans></div>}
      <ModelsCard models={report.models} total={report.totals.models} fallback={report.modelFallback} />
      {report.backgroundCalls.length > 0 && <BackgroundCallsCard calls={report.backgroundCalls} total={report.totals.backgroundCalls} />}
    </div>
  );
}

/** "Plan", "Auto": the run's agent's own label for its mode, its parenthetical dropped. */
function usePermissionLabel(): (agent: string, mode: string | null) => string | null {
  const agentList = useConfigStore((state) => state.agentList);
  return (agent, mode) => {
    if (!mode) return null;
    const permissions = agentList.find((entry) => entry.name === agent)?.permissions ?? DEFAULT_PERMISSIONS;
    return getPermissionLabel(permissions, mode as PermissionMode).replace(/\s*\(.*\)\s*$/, '');
  };
}

/** A run with the conversation it continues, which the Session pill names. */
interface RunsRow {
  run: TaskReportRun;
  conversationId: string;
  /** The conversation is an isolated column's own, so its pill leads with the Split icon. */
  isolated: boolean;
}

type RunsSortKey = 'column' | 'session' | 'started' | 'model' | 'effort' | 'permissions' | 'compactions' | 'runtime' | 'cost' | 'toolCalls';

const RUNS_COLUMNS: Record<RunsSortKey, SortColumn<RunsRow, RunsSortKey>> = {
  column: { key: 'column', label: msg({ message: 'Column', context: 'column header' }), align: 'left', sortValue: (row) => row.run.columns[0]?.name ?? null },
  session: { key: 'session', label: msg({ message: 'Session', context: 'column header' }), align: 'left', sortValue: (row) => row.conversationId },
  started: { key: 'started', label: msg({ message: 'Started', context: 'column header' }), align: 'left', sortValue: (row) => Date.parse(row.run.startedAt) },
  model: { key: 'model', label: msg({ message: 'Model', context: 'column header' }), align: 'left', sortValue: (row) => row.run.model },
  effort: { key: 'effort', label: msg({ message: 'Effort', context: 'column header' }), align: 'left', sortValue: (row) => row.run.effort },
  permissions: { key: 'permissions', label: msg({ message: 'Permissions', context: 'column header' }), align: 'left', sortValue: (row) => row.run.permissionMode },
  compactions: { key: 'compactions', label: msg({ message: 'Compactions', context: 'column header' }), align: 'right', sortValue: (row) => row.run.compactionCount },
  runtime: { key: 'runtime', label: msg({ message: 'Runtime', context: 'column header' }), align: 'right', sortValue: (row) => row.run.runtimeMs },
  cost: { key: 'cost', label: msg({ message: 'Cost', context: 'column header' }), align: 'right', sortValue: (row) => row.run.costUsd },
  toolCalls: { key: 'toolCalls', label: msg({ message: 'Tool calls', context: 'column header' }), align: 'right', sortValue: (row) => row.run.toolCallCount },
};

/**
 * Every run of the task, oldest first, each naming its conversation with a
 * Session pill: the same pill on two rows says they continue one conversation.
 * One flat list rather than a heading per conversation, so the table reads in
 * the order the task moved and sorts as one.
 */
function RunsCard({ report }: { report: TaskReport }) {
  const { t } = useLingui();
  const permissionLabel = usePermissionLabel();
  const rows = useMemo<RunsRow[]>(
    () => report.conversations
      .flatMap((conversation) => conversation.runs.map((run) => ({
        run,
        conversationId: conversation.conversationId,
        isolated: conversation.isolatedColumn !== null,
      })))
      .sort((first, second) => Date.parse(first.run.startedAt) - Date.parse(second.run.startedAt)),
    [report.conversations],
  );
  const showColumn = rows.some((row) => row.run.columns.length > 0);
  const showCompactions = rows.some((row) => row.run.compactionCount > 0);
  const columns = useMemo(() => [
    ...(showColumn ? [RUNS_COLUMNS.column] : []),
    RUNS_COLUMNS.session,
    RUNS_COLUMNS.started,
    RUNS_COLUMNS.model,
    RUNS_COLUMNS.effort,
    RUNS_COLUMNS.permissions,
    ...(showCompactions ? [RUNS_COLUMNS.compactions] : []),
    RUNS_COLUMNS.runtime,
    RUNS_COLUMNS.cost,
    RUNS_COLUMNS.toolCalls,
  ], [showColumn, showCompactions]);
  const { sorts, sortedRows, sortBy } = useSortedRows(rows, columns);
  // A field no run reported totals to null, shown as a dash, never a measured zero.
  const total = report.totals.runs;
  // Column and Session are the label columns, as Column and Call are on
  // Background calls, so the two cards' data columns line up.
  const labelColumns = showColumn ? 2 : 1;
  // The Total's label spans every column before the first number.
  const totalLabelSpan = labelColumns + 4;

  return (
    <ReportCard title={t({ message: 'Runs', context: 'completed task card' })} testId="completed-runs">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={labelColumns} dataColumns={columns.length - labelColumns} />
          <thead>
            <tr>
              {columns.map((column, index) => (
                <SortHeader key={column.key} column={column} sorts={sorts} onSort={sortBy} first={index === 0} testIdPrefix="completed-runs" />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <RunRow
                key={row.run.recordId}
                run={row.run}
                conversationId={row.conversationId}
                isolated={row.isolated}
                showColumn={showColumn}
                showCompactions={showCompactions}
                permissionLabel={permissionLabel(row.run.agent, row.run.permissionMode)}
              />
            ))}
            <tr data-testid="completed-runs-total">
              <td colSpan={totalLabelSpan} className={cellClass('total', 'left', true)}>{t({ message: 'Total', context: 'table total row' })}</td>
              {showCompactions && <td className={cellClass('total', 'right')}>{total.compactionCount}</td>}
              <td className={cellClass('total', 'right')}>{total.runtimeMs === null ? <Dash /> : formatSpan(total.runtimeMs)}</td>
              <td className={cellClass('total', 'right')}>{total.costUsd === null ? <Dash /> : formatCost(total.costUsd)}</td>
              <td className={cellClass('total', 'right')}>
                <ToolCallsPill count={total.toolCallCount} rows={report.summary?.toolBreakdown ?? []} testId="completed-total-tool-calls" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}

function RunRow({
  run,
  conversationId,
  isolated,
  showColumn,
  showCompactions,
  permissionLabel,
}: {
  run: TaskReportRun;
  conversationId: string;
  isolated: boolean;
  showColumn: boolean;
  showCompactions: boolean;
  permissionLabel: string | null;
}) {
  const { t } = useLingui();
  const exitCode = run.exitCode;
  return (
    <tr data-testid="completed-run-row">
      {showColumn && (
        <td className={`${cellClass('body', 'left', true)} overflow-hidden`}>
          <span className="inline-flex max-w-full items-center gap-2">
            {/* A run can come back to a column (A, B, A), so the id alone is not unique. */}
            {run.columns.map((column, index) => (
              <Fragment key={`${index}-${column.swimlaneId}`}>
                {index > 0 && <ArrowRight size={12} className="flex-shrink-0 text-fg-faint" />}
                <ColumnLabel column={column} />
              </Fragment>
            ))}
          </span>
        </td>
      )}
      <td className={cellClass('body', 'left', !showColumn)}>
        <SessionPill conversationId={conversationId} isolated={isolated} />
      </td>
      <td className={cellClass('body', 'left')}>
        <Tooltip label={formatDateTime(run.startedAt)}>
          <span className="inline-flex items-center gap-1.5">
            {formatMonthDayTime(run.startedAt)}
            {/* A run whose process ended with an error. The task's status reads only
                its last run, so an earlier run's crash would otherwise go unseen. */}
            {run.exitCode !== null && run.exitCode !== 0 && (
              <Tooltip label={t`Exited (${exitCode})`}>
                <span
                  role="img"
                  aria-label={t`Exited (${exitCode})`}
                  className="inline-flex text-red-400"
                  data-testid="completed-run-exited"
                >
                  <XCircle size={13} />
                </span>
              </Tooltip>
            )}
          </span>
        </Tooltip>
      </td>
      <td className={cellClass('body', 'left')}>{run.model ? <ValuePill>{run.model}</ValuePill> : <Dash />}</td>
      <td className={cellClass('body', 'left')}>{run.effort ? <ValuePill>{run.effort}</ValuePill> : <Dash />}</td>
      <td className={cellClass('body', 'left')}>{permissionLabel ? <ValuePill>{permissionLabel}</ValuePill> : <Dash />}</td>
      {showCompactions && <td className={cellClass('body', 'right')}>{run.compactionCount}</td>}
      <td className={cellClass('body', 'right')}>{run.runtimeMs === null ? <Dash /> : formatSpan(run.runtimeMs)}</td>
      <td className={cellClass('body', 'right')}>{run.costUsd === null ? <Dash /> : formatCost(run.costUsd)}</td>
      <td className={cellClass('body', 'right')}><ToolCallsPill count={run.toolCallCount} rows={run.toolBreakdown} testId="completed-run-tool-calls" /></td>
    </tr>
  );
}

function Dash() {
  return <span className="text-fg-faint">-</span>;
}

/**
 * Turns and the four token kinds per model, from the turn ledger, the main
 * thread apart from each subagent type. When the ledger cannot be read
 * (indexing off, or the index restarting) or holds nothing for the task, each
 * model's input and output from the session totals stand in.
 */
function ModelsCard({ models, total, fallback }: {
  models: TaskReportModelUsage[] | null;
  total: TaskReportModelsTotal | null;
  fallback: TaskReportModelFallback[];
}) {
  if (models && models.length > 0 && total) return <LedgerModelsCard models={models} total={total} />;
  if (fallback.length > 0) return <FallbackModelsCard fallback={fallback} />;
  return null;
}

type ModelsSortKey = 'model' | 'turns' | 'freshInput' | 'cacheWrite' | 'cacheRead' | 'output';

const MODELS_COLUMNS: Array<SortColumn<TaskReportModelUsage, ModelsSortKey>> = [
  // The model alone: the sort is stable, so a model's main thread and subagent
  // rows keep the ledger's own order. A combined string would not, since
  // `localeCompare` ignores a NUL separator and runs the two names together.
  { key: 'model', label: msg({ message: 'Model', context: 'column header' }), align: 'left', sortValue: (row) => row.model },
  { key: 'turns', label: msg({ message: 'Turns', context: 'column header' }), align: 'right', sortValue: (row) => row.turns },
  { key: 'freshInput', label: msg({ message: 'Fresh input', context: 'column header' }), align: 'right', sortValue: (row) => row.freshInputTokens },
  { key: 'cacheWrite', label: msg({ message: 'Cache write', context: 'column header' }), align: 'right', sortValue: (row) => row.cacheWriteTokens },
  { key: 'cacheRead', label: msg({ message: 'Cache read', context: 'column header' }), align: 'right', sortValue: (row) => row.cacheReadTokens },
  { key: 'output', label: msg({ message: 'Output', context: 'column header' }), align: 'right', sortValue: (row) => row.outputTokens },
];

function LedgerModelsCard({ models, total }: { models: TaskReportModelUsage[]; total: TaskReportModelsTotal }) {
  const { t } = useLingui();
  const { sorts, sortedRows, sortBy } = useSortedRows(models, MODELS_COLUMNS);
  return (
    <ReportCard title={t`Models and tokens`} testId="completed-models">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={1} dataColumns={5} />
          <thead>
            <tr>
              {MODELS_COLUMNS.map((column, index) => (
                <SortHeader key={column.key} column={column} sorts={sorts} onSort={sortBy} first={index === 0} testIdPrefix="completed-models" />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={`${row.model}\u0000${row.subagent ?? ''}`} data-testid="completed-model-row">
                <td className={cellClass('body', 'left', true)}>
                  <span className="inline-flex items-center gap-2.5">
                    <span className="font-medium text-fg">{row.model}</span>
                    {row.subagent !== null && <ValuePill>{t`${{ subagentName: row.subagent }} subagent`}</ValuePill>}
                  </span>
                </td>
                <td className={cellClass('body', 'right')}>{row.turns.toLocaleString()}</td>
                <TokenCell value={row.freshInputTokens} kind="body" />
                <TokenCell value={row.cacheWriteTokens} kind="body" />
                <TokenCell value={row.cacheReadTokens} kind="body" />
                <TokenCell value={row.outputTokens} kind="body" />
              </tr>
            ))}
            {models.length >= 2 && (
              <tr data-testid="completed-models-total">
                <td className={cellClass('total', 'left', true)}>{t({ message: 'Total', context: 'table total row' })}</td>
                <td className={cellClass('total', 'right')}>{total.turns.toLocaleString()}</td>
                <TokenCell value={total.freshInputTokens} kind="total" />
                <TokenCell value={total.cacheWriteTokens} kind="total" />
                <TokenCell value={total.cacheReadTokens} kind="total" />
                <TokenCell value={total.outputTokens} kind="total" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}

type FallbackSortKey = 'model' | 'inputWithCache' | 'output';

const FALLBACK_COLUMNS: Array<SortColumn<TaskReportModelFallback, FallbackSortKey>> = [
  { key: 'model', label: msg({ message: 'Model', context: 'column header' }), align: 'left', sortValue: (row) => row.model },
  { key: 'inputWithCache', label: msg({ message: 'Input with cache', context: 'column header' }), align: 'right', sortValue: (row) => row.inputWithCacheTokens },
  { key: 'output', label: msg({ message: 'Output', context: 'column header' }), align: 'right', sortValue: (row) => row.outputTokens },
];

function FallbackModelsCard({ fallback }: { fallback: TaskReportModelFallback[] }) {
  const { t } = useLingui();
  const { sorts, sortedRows, sortBy } = useSortedRows(fallback, FALLBACK_COLUMNS);
  return (
    <ReportCard title={t`Models and tokens`} aside={t`From session totals`} testId="completed-models-fallback">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={1} dataColumns={2} />
          <thead>
            <tr>
              {FALLBACK_COLUMNS.map((column, index) => (
                <SortHeader key={column.key} column={column} sorts={sorts} onSort={sortBy} first={index === 0} testIdPrefix="completed-models-fallback" />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.model} data-testid="completed-model-row">
                <td className={`${cellClass('body', 'left', true)} font-medium text-fg`}>{row.model}</td>
                <TokenCell value={row.inputWithCacheTokens} kind="body" />
                <TokenCell value={row.outputTokens} kind="body" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}

function TokenCell({ value, kind }: { value: number; kind: CellKind }) {
  return (
    <td className={cellClass(kind, 'right')}>
      <Tooltip label={value.toLocaleString()}>
        <span>{formatTokenCount(value)}</span>
      </Tooltip>
    </td>
  );
}

/**
 * A call with no automation behind it, named for its job. Elements rather than
 * components, so a row renders them without creating a component during render.
 */
const JOB_CALLS: Record<BackgroundCallJob, { label: LocalizedText; icon: ReactElement }> = {
  task_title: { label: msg`Generate title`, icon: <Sparkles size={14} className="flex-shrink-0 text-fg-muted" /> },
  task_summary: { label: msg`Write summary`, icon: <FileText size={14} className="flex-shrink-0 text-fg-muted" /> },
  terminal_name: { label: msg`Name terminal`, icon: <SquareTerminal size={14} className="flex-shrink-0 text-fg-muted" /> },
  workflow_step: { label: msg`Workflow step`, icon: <Workflow size={14} className="flex-shrink-0 text-fg-muted" /> },
  condition_check: { label: msg`Condition check`, icon: <Sparkles size={14} className="flex-shrink-0 text-fg-muted" /> },
};

type CallsSortKey = 'column' | 'call' | 'started' | 'model' | 'effort' | 'outcome' | 'runtime' | 'cost' | 'tokens';

const CALLS_COLUMNS: Array<SortColumn<TaskReportBackgroundCall, CallsSortKey>> = [
  { key: 'column', label: msg({ message: 'Column', context: 'column header' }), align: 'left', sortValue: (call) => call.column?.name ?? null },
  // Sorted by what the cell shows: the automation's name, else the job's label in the session's language.
  { key: 'call', label: msg({ message: 'Call', context: 'column header' }), align: 'left', sortValue: (call) => call.automationName ?? translateText(JOB_CALLS[call.job].label) },
  { key: 'started', label: msg({ message: 'Started', context: 'column header' }), align: 'left', sortValue: (call) => Date.parse(call.startedAt) },
  { key: 'model', label: msg({ message: 'Model', context: 'column header' }), align: 'left', sortValue: (call) => call.model },
  { key: 'effort', label: msg({ message: 'Effort', context: 'column header' }), align: 'left', sortValue: (call) => call.effort },
  { key: 'outcome', label: msg({ message: 'Outcome', context: 'column header' }), align: 'left', sortValue: (call) => call.outcome },
  { key: 'runtime', label: msg({ message: 'Runtime', context: 'column header' }), align: 'right', sortValue: (call) => call.durationMs },
  { key: 'cost', label: msg({ message: 'Cost', context: 'column header' }), align: 'right', sortValue: (call) => call.costUsd },
  { key: 'tokens', label: msg({ message: 'Tokens', context: 'column header' }), align: 'right', sortValue: (call) => call.tokens },
];

/**
 * One row per automation a Condition check was asked about, with its Outcome
 * (ran, skipped or error), and each call with no automation behind it (a
 * title). One check answers every automation of its group, so the Total
 * (`TaskReport.totals`) counts a call once, however many rows it answered, and
 * a field no call reported totals to a dash. A check no run names, such as a
 * failed check repeated later in the same visit, has no row.
 */
function BackgroundCallsCard({ calls, total }: { calls: TaskReportBackgroundCall[]; total: TaskReportBackgroundCallsTotal }) {
  const { t } = useLingui();
  const [showAll, setShowAll] = useState(false);
  // Sorted before the "Show all" cut, so the highest cost is the highest of every call.
  const { sorts, sortedRows, sortBy } = useSortedRows(calls, CALLS_COLUMNS);
  const shown = showAll ? sortedRows : sortedRows.slice(0, BACKGROUND_CALLS_SHOWN);
  const hidden = calls.length - BACKGROUND_CALLS_SHOWN;
  const callCount = calls.length;

  return (
    <ReportCard
      title={t`Background calls`}
      action={hidden > 0 && (
        <LinkButton onClick={() => setShowAll((previous) => !previous)} testId="completed-background-calls-toggle">
          {showAll ? t`Show less` : t`Show all ${callCount}`}
        </LinkButton>
      )}
      testId="completed-background-calls"
    >
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={2} dataColumns={7} />
          <thead>
            <tr>
              {/* The data columns follow Runs' order, Outcome where Runs has
                  Permissions, so the two cards line up column for column. */}
              {CALLS_COLUMNS.map((column, index) => (
                <SortHeader key={column.key} column={column} sorts={sorts} onSort={sortBy} first={index === 0} testIdPrefix="completed-background-calls" />
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((call, index) => (
              <tr key={`${call.callId ?? 'call'}-${call.automationName ?? call.job}-${index}`} data-testid="completed-background-call-row">
                <td className={`${cellClass('body', 'left', true)} overflow-hidden`}>{call.column ? <ColumnLabel column={call.column} /> : <Dash />}</td>
                <td className={`${cellClass('body', 'left')} overflow-hidden`}><CallLabel call={call} /></td>
                <td className={cellClass('body', 'left')}>
                  <Tooltip label={formatDateTime(call.startedAt)}>
                    <span>{formatMonthDayTime(call.startedAt)}</span>
                  </Tooltip>
                </td>
                <td className={cellClass('body', 'left')}>{call.model ? <ValuePill>{call.model}</ValuePill> : <Dash />}</td>
                <td className={cellClass('body', 'left')}>{call.effort ? <ValuePill>{call.effort}</ValuePill> : <Dash />}</td>
                <td className={cellClass('body', 'left')}><OutcomePill call={call} /></td>
                <td className={cellClass('body', 'right')}>{call.durationMs === null ? <Dash /> : formatCallDuration(call.durationMs)}</td>
                <td className={cellClass('body', 'right')}>{call.costUsd === null ? <Dash /> : formatCost(call.costUsd)}</td>
                <td className={cellClass('body', 'right')}>{call.tokens === null ? <Dash /> : formatTokenCount(call.tokens)}</td>
              </tr>
            ))}
            <tr data-testid="completed-background-calls-total">
              <td colSpan={6} className={cellClass('total', 'left', true)}>{t({ message: 'Total', context: 'table total row' })}</td>
              <td className={cellClass('total', 'right')}>{total.durationMs === null ? <Dash /> : formatCallDuration(total.durationMs)}</td>
              <td className={cellClass('total', 'right')}>{total.costUsd === null ? <Dash /> : formatCost(total.costUsd)}</td>
              <td className={cellClass('total', 'right')}>{total.tokens === null ? <Dash /> : formatTokenCount(total.tokens)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}

/**
 * What became of the automation, as a word: ran, skipped (the Condition was not
 * met, or a later gate stopped it), or error (it failed, or the check never
 * answered). The reason shows on hover.
 */
const OUTCOME_PILLS: Record<TaskReportCallOutcome, { label: LocalizedText; className: string }> = {
  ran: { label: msg({ message: 'Ran', context: 'call outcome' }), className: 'border-green-400/30 bg-green-400/10 text-green-400' },
  skipped: { label: msg({ message: 'Skipped', context: 'call outcome' }), className: 'border-edge bg-surface-raised text-fg-muted' },
  error: { label: msg({ message: 'Error', context: 'call outcome' }), className: 'border-red-400/40 bg-red-400/10 text-red-400' },
};

/** A call's outcome pill, the same size as the Model and Effort pills; a dash for a call with no automation. */
function OutcomePill({ call }: { call: TaskReportBackgroundCall }) {
  const { t } = useLingui();
  if (call.outcome === null) return <Dash />;
  const pill = OUTCOME_PILLS[call.outcome];
  const pillLabel = translateText(pill.label);
  // call.reason is the stored automation-run reason, shown as written.
  const reason = call.reason;
  return (
    <Tooltip label={reason ? t`${pillLabel}: ${reason}` : pillLabel}>
      <span
        className={`inline-flex h-[22px] items-center rounded border px-2 text-xs font-medium ${pill.className}`}
        data-testid="completed-call-outcome"
        data-outcome={call.outcome}
      >
        {pillLabel}
      </span>
    </Tooltip>
  );
}

/** The automation with its type's icon and its Condition as the tooltip; else the call's job. */
function CallLabel({ call }: { call: TaskReportBackgroundCall }) {
  const { t } = useLingui();
  const condition = call.condition;
  const automationIconName = call.automationType ? AUTOMATION_MANIFEST[call.automationType]?.icon ?? '' : '';
  return (
    <Tooltip label={condition ? t`Condition: ${condition}` : ''}>
      <span
        className="inline-flex max-w-full items-center gap-1.5 text-fg-secondary"
        data-testid="completed-call-label"
      >
        {call.automationName !== null
          ? <AutomationIcon name={automationIconName} size={14} className="flex-shrink-0 text-fg-muted" />
          : JOB_CALLS[call.job].icon}
        <span className="truncate">{call.automationName ?? translateText(JOB_CALLS[call.job].label)}</span>
      </span>
    </Tooltip>
  );
}
