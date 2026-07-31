import React from 'react';
import { CirclePause, Check, SquareTerminal } from 'lucide-react';
import { ActivityMark } from '../ActivityMark';
import type { MonitorSessionRow } from '../../../shared/types';
import { LabelPills, Pill } from '../Pill';
import { PrLink } from '../PrLink';
import { ElapsedTime } from '../terminal/ElapsedTime';
import { ContextUsageFooter } from '../board/ContextUsageFooter';
import { formatActivityReasonText } from '../board/ActivityReasonTooltip';
import { agentDisplayName } from '../../utils/agent-display-name';
import { stripMarkdown } from '../../utils/strip-markdown';
import { bucketOf, formatMonitorStatus, needsUser } from './monitor-view-model';

/**
 * One agent session, rendered as the board's task card.
 *
 * This is deliberately a near-copy of TaskCard's anatomy - same title row (state
 * glyph, bold title, monospace ticket number), same PrLink, same
 * stripMarkdown + line-clamp description, same LabelPills, and the SAME footer
 * component (ContextUsageFooter, shared with TaskCard so they cannot drift). A
 * user arriving here should recognise the object immediately rather than learn a
 * second card.
 *
 * Two additions the board card has no need for, both kept at the edges so the
 * familiar middle is untouched:
 *   - an eyebrow line naming the owning project and column (the cross-project bit)
 *   - the live activity line ("Idle for 5m - Claude is waiting for your input")
 *     directly above the footer, which is what this view exists to surface.
 */

interface MonitorCardProps {
  row: MonitorSessionRow;
  labelColors: Record<string, string>;
  /** Compact layout: one scannable line per session. */
  dense?: boolean;
  onOpen: (row: MonitorSessionRow) => void;
  /** Right-click: the explicit "put it on the board" override and row utilities. */
  onContextMenu?: (row: MonitorSessionRow, position: { x: number; y: number }) => void;
  /** Drop the project from the eyebrow when the SECTION already names it, so the
   *  card does not repeat its own header. Mirrors MonitorTable's
   *  `hideProjectColumn`, so both layouts make the same call. */
  hideProject?: boolean;
}

/** The state glyph, matching TaskCard's vocabulary exactly. */
function StateGlyph({ row }: { row: MonitorSessionRow }) {
  const title = row.activityReason ? formatActivityReasonText(row.activityReason) : undefined;
  const bucket = bucketOf(row);

  // Switch on the BUCKET, not a second derivation. `bucketOf` already decides
  // which section and summary count this row lands in, and re-deriving the glyph
  // from `isWorking` disagreed with it: a running session that has not reported
  // activity yet (a freshly spawned agent, or a Command Terminal, which has no
  // activity engine at all) buckets as `working` but fails `isActive`, so it was
  // counted under Active while its own card drew the paused glyph.
  // The two ACTIVITY states use the shared branding marks, the same vocabulary a
  // board card shows; only the non-activity states (finished, paused) stay lucide.
  if (bucket === 'needs-you') {
    return <ActivityMark mark="agent-idle" size={15} className="text-attention shrink-0" aria-label={title ?? 'Needs you'} />;
  }
  if (bucket === 'working') {
    return <ActivityMark mark="agent-working" size={15} className="text-active shrink-0" aria-label={title ?? 'Working'} />;
  }
  if (bucket === 'finished') {
    return <Check size={14} className="text-fg-disabled shrink-0" aria-label="Finished" />;
  }
  return (
    <CirclePause
      size={14}
      className="text-fg-faint shrink-0"
      aria-label={row.status === 'queued' ? 'Waiting to start' : 'Paused'}
    />
  );
}

function MonitorCardInner({
  row,
  labelColors,
  dense = false,
  onOpen,
  onContextMenu,
  hideProject = false,
}: MonitorCardProps) {
  const activityLine = formatMonitorStatus(row);

  // Scoped with `currentTarget.contains()`: the card is itself a role="button",
  // and a nested interactive element's own menu must win over this one.
  const handleContextMenu = (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(row, { x: event.clientX, y: event.clientY });
  };

  if (dense) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(row)}
        onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row); }}
        onContextMenu={handleContextMenu}
        className="border border-edge rounded-md bg-surface-raised px-2.5 py-1.5 min-w-0 flex items-center gap-2 hover:border-edge-input transition-colors cursor-pointer text-left"
        data-testid="monitor-card"
        data-dense="true"
        data-session-id={row.sessionId}
        data-project-id={row.projectId}
        title={`Open ${row.taskTitle}`}
      >
        <StateGlyph row={row} />
        {!hideProject && (
          <span className="text-[11px] text-fg-muted truncate shrink-0 max-w-[18ch]">{row.projectName}</span>
        )}
        <span className="text-sm text-fg font-medium truncate min-w-0 flex-1">{row.taskTitle}</span>
        <span className="shrink-0 font-mono text-xs text-fg-muted">
          {row.displayId === null ? '' : `#${row.displayId}`}
        </span>
        <span className={`text-xs truncate min-w-0 max-w-[30ch] ${needsUser(row) ? 'text-attention' : 'text-fg-faint'}`}>
          {activityLine}
        </span>
        {row.status !== 'exited' && (
          <ElapsedTime startedAt={row.startedAt} className="shrink-0 tabular-nums text-[11px] text-fg-faint" />
        )}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row); }}
      onContextMenu={handleContextMenu}
      className="border border-edge rounded-md bg-surface-raised p-2.5 min-w-0 flex flex-col cursor-pointer transition-colors hover:border-edge-input text-left"
      data-testid="monitor-card"
      data-session-id={row.sessionId}
      data-project-id={row.projectId}
      title={`Open ${row.taskTitle}`}
    >
      {/* Eyebrow: the cross-project identity the board card never needs, plus the
          live status as a right-aligned pill. The status sits up here rather than
          at the card's foot so it lands on a consistent line across a grid of
          cards with different description lengths - you scan one column of pills
          instead of hunting the bottom edge of each card. */}
      <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-fg-muted mb-1" data-testid="monitor-card-origin">
        {!hideProject && <span className="truncate min-w-0">{row.projectName}</span>}
        {row.columnName && (
          <>
            {!hideProject && <span className="text-fg-disabled shrink-0">/</span>}
            <span className="truncate min-w-0">{row.columnName}</span>
          </>
        )}
        {activityLine && (
          <Pill
            size="xs"
            className={`ml-auto shrink-0 max-w-[22ch] ${needsUser(row)
              ? 'bg-attention/10 text-attention'
              : 'bg-surface-hover/60 text-fg-muted'}`}
            title={activityLine}
            data-testid="monitor-card-activity"
          >
            <span className="truncate">{activityLine}</span>
          </Pill>
        )}
      </div>

      {/* Title row - identical to TaskCard's. A Command Terminal has no task, so
          it gets the terminal glyph and its name in place of a title + ticket. */}
      <div className="flex items-center gap-1.5">
        <StateGlyph row={row} />
        {row.isCommandTerminal && (
          <SquareTerminal size={14} className="text-fg-muted shrink-0" aria-hidden />
        )}
        <div className="text-sm text-fg font-medium truncate flex-1 min-w-0" data-testid="monitor-card-title">
          {row.taskTitle}
        </div>
        {row.displayId !== null && (
          <span className="shrink-0 font-mono text-xs text-fg-muted" data-testid="monitor-card-display-id">
            #{row.displayId}
          </span>
        )}
      </div>

      {row.prUrl && (
        <div className="flex items-center gap-2 mt-1.5">
          <PrLink prUrl={row.prUrl} prNumber={row.prNumber} prState={row.prState} testId="monitor-card-pr-link" />
        </div>
      )}

      {row.taskDescription && (
        <div className="text-xs text-fg-faint mt-1 line-clamp-3">{stripMarkdown(row.taskDescription)}</div>
      )}

      <div className="mt-1.5">
        <LabelPills labels={row.labels} labelColors={labelColors} />
      </div>

      {/* Pins the footer to the card's bottom edge so a grid of cards with
          different description lengths still has its context bars aligned. */}
      <div className="flex-1" />

      {/* The board card's own footer component, not a copy of it. */}
      <ContextUsageFooter
        modelName={row.modelDisplayName ?? agentDisplayName(row.agentName)}
        percent={row.contextPercent ?? 0}
        windowKnown={row.contextPercent !== null}
        testId="monitor-card-usage"
      />
    </div>
  );
}

// Memoized: the virtualizer re-renders the whole visible window on every scroll
// tick, and an activity push re-renders the list on every state change.
export const MonitorCard = React.memo(MonitorCardInner);
