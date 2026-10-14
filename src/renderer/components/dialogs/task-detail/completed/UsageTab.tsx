import { Fragment, useState } from 'react';
import type { ReactElement } from 'react';
import { ArrowRight, Check, Copy, FileText, Sparkles, SquareTerminal, Workflow, XCircle } from 'lucide-react';
import { AutomationIcon } from '../../board-manager/automation-icons';
import { formatCallDuration, formatCost, formatSpan } from '../../../../utils/format-session';
import { formatTokenCount } from '../../../../utils/format-tokens';
import { formatDateTime, formatMonthDayTime } from '../../../../lib/datetime';
import { useConfigStore } from '../../../../stores/config-store';
import { AUTOMATION_MANIFEST } from '../../../../../shared/automation-manifest';
import { DEFAULT_PERMISSIONS, getPermissionLabel } from '../../../../../shared/types';
import { ColumnLabel, LinkButton, ReportCard, ToolCallsPill, ValuePill } from './report-parts';
import type {
  BackgroundCallJob,
  PermissionMode,
  TaskReport,
  TaskReportBackgroundCall,
  TaskReportCallOutcome,
  TaskReportConversation,
  TaskReportModelFallback,
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
 * The grid every table on this tab shares: the label columns (Column, Call,
 * Model) hold the first 30% and each data column takes an equal part of the
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

export function UsageTab({ report }: { report: TaskReport }) {
  const runCount = report.conversations.reduce((sum, conversation) => sum + conversation.runs.length, 0);
  return (
    <div className="flex flex-col gap-5">
      {runCount > 0
        ? <RunsCard report={report} />
        : <div className="py-8 text-center text-sm text-fg-disabled" data-testid="completed-no-runs">No agent runs on record</div>}
      <ModelsCard models={report.models} fallback={report.modelFallback} />
      {report.backgroundCalls.length > 0 && <BackgroundCallsCard calls={report.backgroundCalls} />}
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

/** The sum of the values that were reported, or null when none was. */
function sumReported(values: ReadonlyArray<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

function conversationLabel(conversation: TaskReportConversation): string {
  return conversation.isolatedColumn ? `${conversation.isolatedColumn.name} conversation` : 'Main conversation';
}

function RunsCard({ report }: { report: TaskReport }) {
  const permissionLabel = usePermissionLabel();
  const runs = report.conversations.flatMap((conversation) => conversation.runs);
  const showColumn = runs.some((run) => run.columns.length > 0);
  const showCompactions = runs.some((run) => run.compactionCount > 0);
  // A field no run reported totals to a dash, never a measured zero.
  const totalRuntimeMs = sumReported(runs.map((run) => run.runtimeMs));
  const totalCostUsd = sumReported(runs.map((run) => run.costUsd));
  const totalToolCalls = runs.reduce((sum, run) => sum + run.toolCallCount, 0);
  // Started, Model, Effort, Permissions, Runtime, Cost and Tool calls always show.
  const columnCount = 7 + (showColumn ? 1 : 0) + (showCompactions ? 1 : 0);
  // The Total's label spans every column before the first number.
  const totalLabelSpan = 4 + (showColumn ? 1 : 0);

  return (
    <ReportCard title="Runs" testId="completed-runs">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          {/* With no Column column, Started is the label column. */}
          <ColumnGrid labelColumns={1} dataColumns={columnCount - 1} />
          <thead>
            <tr>
              {showColumn && <th className={cellClass('header', 'left', true)}>Column</th>}
              <th className={cellClass('header', 'left', !showColumn)}>Started</th>
              <th className={cellClass('header', 'left')}>Model</th>
              <th className={cellClass('header', 'left')}>Effort</th>
              <th className={cellClass('header', 'left')}>Permissions</th>
              {showCompactions && <th className={cellClass('header', 'right')}>Compactions</th>}
              <th className={cellClass('header', 'right')}>Runtime</th>
              <th className={cellClass('header', 'right')}>Cost</th>
              <th className={cellClass('header', 'right')}>Tool calls</th>
            </tr>
          </thead>
          <tbody>
            {report.conversations.map((conversation) => (
              <Fragment key={conversation.conversationId}>
                <tr data-testid="completed-conversation-header">
                  <td colSpan={columnCount} className="pb-1 pt-3.5 text-left">
                    <ConversationHeader label={conversationLabel(conversation)} conversationId={conversation.conversationId} />
                  </td>
                </tr>
                {conversation.runs.map((run) => (
                  <RunRow
                    key={run.recordId}
                    run={run}
                    showColumn={showColumn}
                    showCompactions={showCompactions}
                    permissionLabel={permissionLabel(run.agent, run.permissionMode)}
                  />
                ))}
              </Fragment>
            ))}
            <tr data-testid="completed-runs-total">
              <td colSpan={totalLabelSpan} className={cellClass('total', 'left', true)}>Total</td>
              {showCompactions && <td className={cellClass('total', 'right')}>{runs.reduce((sum, run) => sum + run.compactionCount, 0)}</td>}
              <td className={cellClass('total', 'right')}>{totalRuntimeMs === null ? <Dash /> : formatSpan(totalRuntimeMs)}</td>
              <td className={cellClass('total', 'right')}>{totalCostUsd === null ? <Dash /> : formatCost(totalCostUsd)}</td>
              <td className={cellClass('total', 'right')}>
                <ToolCallsPill count={totalToolCalls} rows={report.summary?.toolBreakdown ?? []} testId="completed-total-tool-calls" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}

/** A conversation's name, its short id, and a button copying the full id. */
function ConversationHeader({ label, conversationId }: { label: string; conversationId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs font-semibold text-fg-secondary">{label}</span>
      <span className="font-mono text-xs text-fg-faint" title={conversationId}>{conversationId.slice(0, 8)}</span>
      <button
        type="button"
        aria-label="Copy conversation ID"
        title="Copy conversation ID"
        onClick={() => {
          // The check shows only once the id is on the clipboard: a write the
          // window is refused (no focus, no permission) leaves the copy icon.
          navigator.clipboard.writeText(conversationId).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            (error: unknown) => console.warn('[completed-task] conversation id copy failed:', error),
          );
        }}
        className="-ml-1 inline-flex h-[22px] w-[22px] items-center justify-center rounded text-fg-muted hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        data-testid="completed-copy-conversation-id"
      >
        {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
      </button>
    </span>
  );
}

function RunRow({
  run,
  showColumn,
  showCompactions,
  permissionLabel,
}: {
  run: TaskReportRun;
  showColumn: boolean;
  showCompactions: boolean;
  permissionLabel: string | null;
}) {
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
      <td className={cellClass('body', 'left', !showColumn)} title={formatDateTime(run.startedAt)}>
        <span className="inline-flex items-center gap-1.5">
          {formatMonthDayTime(run.startedAt)}
          {/* A run whose process ended with an error. The task's status reads only
              its last run, so an earlier run's crash would otherwise go unseen. */}
          {run.exitCode !== null && run.exitCode !== 0 && (
            <span
              role="img"
              aria-label={`Exited (${run.exitCode})`}
              title={`Exited (${run.exitCode})`}
              className="inline-flex text-red-400"
              data-testid="completed-run-exited"
            >
              <XCircle size={13} />
            </span>
          )}
        </span>
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
function ModelsCard({ models, fallback }: { models: TaskReportModelUsage[] | null; fallback: TaskReportModelFallback[] }) {
  if (models && models.length > 0) return <LedgerModelsCard models={models} />;
  if (fallback.length > 0) return <FallbackModelsCard fallback={fallback} />;
  return null;
}

function LedgerModelsCard({ models }: { models: TaskReportModelUsage[] }) {
  const total = models.reduce(
    (sum, row) => ({
      turns: sum.turns + row.turns,
      freshInputTokens: sum.freshInputTokens + row.freshInputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
    }),
    { turns: 0, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  );
  return (
    <ReportCard title="Models and tokens" testId="completed-models">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={1} dataColumns={5} />
          <thead>
            <tr>
              <th className={cellClass('header', 'left', true)}>Model</th>
              <th className={cellClass('header', 'right')}>Turns</th>
              <th className={cellClass('header', 'right')}>Fresh input</th>
              <th className={cellClass('header', 'right')}>Cache write</th>
              <th className={cellClass('header', 'right')}>Cache read</th>
              <th className={cellClass('header', 'right')}>Output</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={`${row.model}\u0000${row.subagent ?? ''}`} data-testid="completed-model-row">
                <td className={cellClass('body', 'left', true)}>
                  <span className="inline-flex items-center gap-2.5">
                    <span className="font-medium text-fg">{row.model}</span>
                    {row.subagent !== null && <ValuePill>{`${row.subagent} subagent`}</ValuePill>}
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
                <td className={cellClass('total', 'left', true)}>Total</td>
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

function FallbackModelsCard({ fallback }: { fallback: TaskReportModelFallback[] }) {
  return (
    <ReportCard title="Models and tokens" aside="From session totals" testId="completed-models-fallback">
      <div className={AUTO_TABLE_WRAPPER}>
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <ColumnGrid labelColumns={1} dataColumns={2} />
          <thead>
            <tr>
              <th className={cellClass('header', 'left', true)}>Model</th>
              <th className={cellClass('header', 'right')}>Input with cache</th>
              <th className={cellClass('header', 'right')}>Output</th>
            </tr>
          </thead>
          <tbody>
            {fallback.map((row) => (
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
  return <td className={cellClass(kind, 'right')} title={value.toLocaleString()}>{formatTokenCount(value)}</td>;
}

/**
 * A call with no automation behind it, named for its job. Elements rather than
 * components, so a row renders them without creating a component during render.
 */
const JOB_CALLS: Record<BackgroundCallJob, { label: string; icon: ReactElement }> = {
  task_title: { label: 'Generate title', icon: <Sparkles size={14} className="flex-shrink-0 text-fg-muted" /> },
  task_summary: { label: 'Write summary', icon: <FileText size={14} className="flex-shrink-0 text-fg-muted" /> },
  terminal_name: { label: 'Name terminal', icon: <SquareTerminal size={14} className="flex-shrink-0 text-fg-muted" /> },
  workflow_step: { label: 'Workflow step', icon: <Workflow size={14} className="flex-shrink-0 text-fg-muted" /> },
  condition_check: { label: 'Condition check', icon: <Sparkles size={14} className="flex-shrink-0 text-fg-muted" /> },
};

/**
 * One row per automation a Condition check was asked about, with its Outcome
 * (ran, skipped or error), and each call with no automation behind it (a
 * title). One check answers every automation of its group, so the Total counts
 * a call once, however many rows it answered. A check no run names, such as a
 * failed check repeated later in the same visit, has no row.
 */
function BackgroundCallsCard({ calls }: { calls: TaskReportBackgroundCall[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? calls : calls.slice(0, BACKGROUND_CALLS_SHOWN);
  const hidden = calls.length - BACKGROUND_CALLS_SHOWN;

  // A run recorded before calls were (the `background_calls` ledger) carries no
  // figures, so a field no row has totals to a dash, never a measured zero.
  const counted = new Set<string>();
  let totalDurationMs: number | null = null;
  let totalCostUsd: number | null = null;
  let totalTokens: number | null = null;
  const add = (total: number | null, value: number | null): number | null => (value === null ? total : (total ?? 0) + value);
  for (const call of calls) {
    if (call.callId !== null) {
      if (counted.has(call.callId)) continue;
      counted.add(call.callId);
    }
    totalDurationMs = add(totalDurationMs, call.durationMs);
    totalCostUsd = add(totalCostUsd, call.costUsd);
    totalTokens = add(totalTokens, call.tokens);
  }

  return (
    <ReportCard
      title="Background calls"
      action={hidden > 0 && (
        <LinkButton onClick={() => setShowAll((previous) => !previous)} testId="completed-background-calls-toggle">
          {showAll ? 'Show less' : `Show all ${calls.length}`}
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
              <th className={cellClass('header', 'left', true)}>Column</th>
              <th className={cellClass('header', 'left')}>Call</th>
              <th className={cellClass('header', 'left')}>Started</th>
              <th className={cellClass('header', 'left')}>Model</th>
              <th className={cellClass('header', 'left')}>Effort</th>
              <th className={cellClass('header', 'left')}>Outcome</th>
              <th className={cellClass('header', 'right')}>Runtime</th>
              <th className={cellClass('header', 'right')}>Cost</th>
              <th className={cellClass('header', 'right')}>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((call, index) => (
              <tr key={`${call.callId ?? 'call'}-${call.automationName ?? call.job}-${index}`} data-testid="completed-background-call-row">
                <td className={`${cellClass('body', 'left', true)} overflow-hidden`}>{call.column ? <ColumnLabel column={call.column} /> : <Dash />}</td>
                <td className={`${cellClass('body', 'left')} overflow-hidden`}><CallLabel call={call} /></td>
                <td className={cellClass('body', 'left')} title={formatDateTime(call.startedAt)}>{formatMonthDayTime(call.startedAt)}</td>
                <td className={cellClass('body', 'left')}>{call.model ? <ValuePill>{call.model}</ValuePill> : <Dash />}</td>
                <td className={cellClass('body', 'left')}>{call.effort ? <ValuePill>{call.effort}</ValuePill> : <Dash />}</td>
                <td className={cellClass('body', 'left')}><OutcomePill call={call} /></td>
                <td className={cellClass('body', 'right')}>{call.durationMs === null ? <Dash /> : formatCallDuration(call.durationMs)}</td>
                <td className={cellClass('body', 'right')}>{call.costUsd === null ? <Dash /> : formatCost(call.costUsd)}</td>
                <td className={cellClass('body', 'right')}>{call.tokens === null ? <Dash /> : formatTokenCount(call.tokens)}</td>
              </tr>
            ))}
            <tr data-testid="completed-background-calls-total">
              <td colSpan={6} className={cellClass('total', 'left', true)}>Total</td>
              <td className={cellClass('total', 'right')}>{totalDurationMs === null ? <Dash /> : formatCallDuration(totalDurationMs)}</td>
              <td className={cellClass('total', 'right')}>{totalCostUsd === null ? <Dash /> : formatCost(totalCostUsd)}</td>
              <td className={cellClass('total', 'right')}>{totalTokens === null ? <Dash /> : formatTokenCount(totalTokens)}</td>
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
const OUTCOME_PILLS: Record<TaskReportCallOutcome, { label: string; className: string }> = {
  ran: { label: 'Ran', className: 'border-green-400/30 bg-green-400/10 text-green-400' },
  skipped: { label: 'Skipped', className: 'border-edge bg-surface-raised text-fg-muted' },
  error: { label: 'Error', className: 'border-red-400/40 bg-red-400/10 text-red-400' },
};

/** A call's outcome pill, the same size as the Model and Effort pills; a dash for a call with no automation. */
function OutcomePill({ call }: { call: TaskReportBackgroundCall }) {
  if (call.outcome === null) return <Dash />;
  const pill = OUTCOME_PILLS[call.outcome];
  return (
    <span
      title={call.reason ? `${pill.label}: ${call.reason}` : pill.label}
      className={`inline-flex h-[22px] items-center rounded border px-2 text-xs font-medium ${pill.className}`}
      data-testid="completed-call-outcome"
      data-outcome={call.outcome}
    >
      {pill.label}
    </span>
  );
}

/** The automation with its type's icon and its Condition as the title; else the call's job. */
function CallLabel({ call }: { call: TaskReportBackgroundCall }) {
  const automationIconName = call.automationType ? AUTOMATION_MANIFEST[call.automationType]?.icon ?? '' : '';
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 text-fg-secondary"
      title={call.condition ? `Condition: ${call.condition}` : undefined}
    >
      {call.automationName !== null
        ? <AutomationIcon name={automationIconName} size={14} className="flex-shrink-0 text-fg-muted" />
        : JOB_CALLS[call.job].icon}
      <span className="truncate">{call.automationName ?? JOB_CALLS[call.job].label}</span>
    </span>
  );
}
