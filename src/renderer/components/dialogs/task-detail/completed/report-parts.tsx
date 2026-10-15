import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import { ColumnGlyph } from '../../../../utils/swimlane-icons';
import { prefersDarkText, readableTextOn } from '../../../../utils/readable-text';
import { ToolBreakdownPopover } from '../../../terminal/ToolBreakdownPopover';
import { Tooltip } from '../../../Tooltip';
import type { PerToolStat, TaskReportColumn } from '../../../../../shared/types';

/** One card on a completed task's tab: lifted one step above the window, never recessed. */
export function ReportCard({
  title,
  aside,
  action,
  children,
  testId,
}: {
  title: string;
  /** Quiet text after the title: a count, or where the numbers came from. */
  aside?: ReactNode;
  /** A control at the right end of the title row. */
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="rounded-[10px] border border-edge bg-surface-hover/30 px-5 pb-4 pt-3.5" data-testid={testId}>
      <div className="mb-2.5 flex items-center gap-2.5">
        <h3 className="text-[13px] font-semibold text-fg-secondary">{title}</h3>
        {aside && <span className="text-xs text-fg-faint">{aside}</span>}
        {action && <span className="ml-auto flex items-center">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** A text button for "Show all" and its kin. */
export function LinkButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-accent-fg hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** A recorded value (model, effort, permission mode) in a table cell. */
export function ValuePill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] max-w-full items-center truncate rounded border border-edge bg-surface-raised px-2 text-xs font-medium text-fg-secondary">
      {children}
    </span>
  );
}

/** A column's glyph on a disc of the column's own color, the glyph in whichever of black or white reads on it. */
function ColumnDisc({ column }: { column: Pick<TaskReportColumn, 'color' | 'icon' | 'role'> }) {
  const textColor = readableTextOn(column.color);
  return (
    <span
      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: column.color, color: textColor }}
    >
      <ColumnGlyph column={column} size={12} color={textColor} />
    </span>
  );
}

/**
 * A column in a table cell: its disc and name. Inside a `@container` narrower
 * than 860px the name drops and the disc carries it as its hover tip and label,
 * so a run that spanned two columns still fits a default-size window.
 */
export function ColumnLabel({ column }: { column: TaskReportColumn }) {
  return (
    <Tooltip label={column.name}>
      <span
        className="inline-flex min-w-0 items-center gap-[7px] font-medium text-fg"
        role="img"
        aria-label={column.name}
        data-testid="report-column-label"
      >
        <ColumnDisc column={column} />
        <span className="hidden truncate @[860px]:inline" aria-hidden="true">{column.name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * A column's pill on the route: filled with the column's color, its glyph on a
 * lighter disc, the text black or white by contrast.
 */
export function ColumnPill({ column, label, tip }: { column: TaskReportColumn; label: string; tip: string }) {
  const darkText = prefersDarkText(column.color);
  const textColor = readableTextOn(column.color);
  return (
    <Tooltip label={tip}>
      <div
        className="flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-md pl-[5px] pr-2.5 text-xs tabular-nums"
        style={{ backgroundColor: column.color, color: textColor }}
        data-testid="route-column-pill"
        data-swimlane-name={column.name}
      >
        <span
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: darkText ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 255, 255, 0.2)' }}
        >
          <ColumnGlyph column={column} size={12} color={textColor} />
        </span>
        <span className="font-medium">{column.name}</span>
        <span className="ml-auto pl-3.5 font-semibold">{label}</span>
      </div>
    </Tooltip>
  );
}

/**
 * The context bar's tool-call pill: the count, opening the per-tool table
 * below it. A run with no per-tool rows on record shows its count alone.
 */
export function ToolCallsPill({ count, rows, testId }: { count: number; rows: PerToolStat[]; testId?: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return <span className="tabular-nums">{count}</span>;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={`${count} tool calls, by tool`}
        className={`inline-flex h-6 items-center gap-1 rounded border pl-[7px] pr-[5px] tabular-nums transition-colors ${
          open ? 'border-fg-faint bg-surface-hover' : 'border-edge hover:bg-surface-hover'
        }`}
        data-testid={testId}
      >
        <Wrench size={12} className="text-fg-faint" />
        {count}
        <ChevronDown size={12} className="text-fg-faint" />
      </button>
      {open && (
        <ToolBreakdownPopover
          triggerRef={triggerRef}
          rows={rows}
          placement="below"
          onClose={() => setOpen(false)}
          testId="completed-tool-breakdown-popover"
        />
      )}
    </>
  );
}
