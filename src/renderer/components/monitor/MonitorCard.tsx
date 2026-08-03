import React from 'react';
import { CirclePause, Check, GitBranch } from 'lucide-react';
import { ActivityMark } from '../ActivityMark';
import type { MonitorSessionRow } from '../../../shared/types';
import { LabelPills, Pill } from '../Pill';
import { PrLink } from '../PrLink';
import { ElapsedTime } from '../terminal/ElapsedTime';
import { ContextUsageFooter } from '../board/ContextUsageFooter';
import { formatActivityReasonText } from '../board/ActivityReasonTooltip';
import { bucketOf, formatMonitorStatus, needsUser } from './monitor-view-model';

/**
 * One agent session, rendered as the board's task card.
 *
 * Deliberately close to TaskCard's anatomy - same title row (state glyph, bold
 * title, monospace ticket number), same PrLink, same LabelPills, and the SAME
 * footer component (ContextUsageFooter, shared with TaskCard so they cannot
 * drift). A user arriving here should recognise the object immediately rather
 * than learn a second card.
 *
 * Three departures from the board card, each earning its place:
 *   - an eyebrow line naming the owning project and column (the cross-project bit)
 *   - the live activity line ("Idle for 5m - Claude is waiting for your input")
 *     as a right-aligned eyebrow pill, which is what this view exists to surface
 *   - a live OUTPUT PEEK where the board card shows its task description. This is
 *     the deliberate divergence: a description reads the same every time you look
 *     at it, and a Command Terminal has none at all, so the slot was static for
 *     task rows and empty for terminal rows. See `OutputPeek` below.
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
  // activity yet buckets as `working` but fails `isActive`, so it was counted
  // under Active while its own card drew the paused glyph.
  // The two ACTIVITY states use the shared branding marks, the same vocabulary a
  // board card shows; only the non-activity states (finished, paused) stay lucide.
  if (bucket === 'needs-you' || bucket === 'working') {
    const needsYou = bucket === 'needs-you';
    // A Command Terminal speaks the terminal marks, the identity it already wears
    // in the title bar and the sidebar. That is now the ONLY thing separating it
    // from a task agent in this card's body, since both show live terminal text;
    // it replaces (rather than joins) the lucide SquareTerminal that used to sit
    // beside the title, because one glyph carrying state AND identity beats two.
    // Safe to swap: the terminal marks share the agent marks' 18-wide indicator
    // keyline and 12px floor, so the title's x position does not move.
    const mark = row.isCommandTerminal
      ? (needsYou ? 'terminal-idle' : 'terminal-working')
      : (needsYou ? 'agent-idle' : 'agent-working');
    // ONE render site with a computed `mark`, never a conditional pair of
    // siblings: React reconciles siblings positionally, so an idle/working flip
    // would unmount one and mount the other, restarting the march from zero
    // (the lesson pinned for TaskCard in tests/unit/activity-mark.test.ts).
    return (
      <ActivityMark
        mark={mark}
        size={15}
        className={`${needsYou ? 'text-attention' : 'text-active'} shrink-0`}
        aria-label={title ?? (needsYou ? 'Needs you' : 'Working')}
      />
    );
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

/**
 * The live tail of this session's terminal, in the slot the task description used
 * to occupy.
 *
 * A description is the same text every time you look at it and says nothing about
 * what the agent is doing NOW, which is the question this screen exists to answer.
 * It also left a Command Terminal's card empty, since a terminal has no task. The
 * peek is live, differs per session, and is the same idea for both row kinds.
 *
 * `whitespace-pre` rather than `truncate`: terminal output is column-aligned, and
 * HTML would otherwise collapse the leading indentation that carries its shape.
 *
 * Toned `text-fg-muted`, not the `text-fg-faint` the task description used. That
 * dimmer tone was right for secondary text; this is the card's PRIMARY content
 * (the reason to look at the card at all) and read as a footnote beneath its own
 * title at monospace sizes.
 *
 * The shaded well is deliberate, and it replaced an unstyled first attempt. Left
 * bare, monospace machine output butted straight into the 14px semibold title
 * with nothing marking the transition, so the two typefaces clashed and the peek
 * read as a subtitle rather than as a different KIND of thing. A recessed panel
 * says "this region is the terminal, not the card" without a frame or a rule, and
 * the tone comes from `surface-hover` so it tracks all eleven themes rather than
 * pinning a hue that only works on dark.
 *
 * The well is a FIXED height, not a content-sized or growing one. Both of the
 * alternatives were tried and are worse:
 *
 *   - Sized to content, the card grew and shrank every time a message landed. A
 *     grid of them visibly jittered as sessions streamed, which is far more
 *     distracting than any amount of dead space.
 *   - Grown to fill the card (`flex-1`), one card's long output made its whole
 *     row taller, so quiet neighbours inherited a big empty well.
 *
 * Fixed removes both: the card's height no longer depends on what the terminal
 * happens to be saying. Three rows normally, two when label pills also need
 * space, so the card lands on roughly the same total height either way.
 *
 * Lines are TRIMMED to what fits before rendering rather than overflowed into a
 * clip. That is what allows top alignment: clipping a top-aligned box would drop
 * the NEWEST lines, which are the only ones worth showing. `slice(-rows)` drops
 * the oldest instead, and `overflow-hidden` then only guards against a font or
 * zoom change, never against normal content.
 */
const PEEK_ROWS_WITH_LABELS = 2;
/**
 * Four, not three, because the row a peek line replaces is not the same height as
 * the one it gives up. A label block costs about 28px (pills plus their margin)
 * while a peek row costs 16, so trading labels for a SINGLE extra row left an
 * unlabelled card roughly 12px short of its labelled neighbours and banked the
 * difference as a gap above the footer. Two extra rows overshoots by about 4px
 * instead, which is the closer fit and small enough to disappear.
 */
const PEEK_ROWS_WITHOUT_LABELS = 4;

/** `leading-4` (16px per row) is what makes these exact. Keep them in step. */
const PEEK_HEIGHT_CLASS: Record<number, string> = { 2: 'h-8', 3: 'h-12', 4: 'h-16' };

function OutputPeek({ lines, rows }: { lines: string[]; rows: number }) {
  if (lines.length === 0) return null;
  return (
    <div
      className="mt-2 rounded bg-surface-hover/50 px-2 py-1.5 font-mono text-xs leading-4 text-fg-muted"
      data-testid="monitor-card-peek"
      data-rows={rows}
    >
      <div className={`overflow-hidden ${PEEK_HEIGHT_CLASS[rows] ?? 'h-12'}`}>
        {lines.slice(-rows).map((line, index) => (
          <div key={index} className="whitespace-pre overflow-hidden text-ellipsis">{line}</div>
        ))}
      </div>
    </div>
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
        {/* One slot, one question: where is this session working? A task answers
            with its column; a Command Terminal has none, so it answers with its
            branch. Leaving it blank put the terminal's title under an empty row,
            which read as a rendering fault next to its neighbours. The glyph is
            what keeps a branch called "main" from being mistaken for a column
            called "main". */}
        {row.isCommandTerminal ? row.commandTerminalBranch && (
          <>
            {!hideProject && <span className="text-fg-disabled shrink-0">/</span>}
            <GitBranch size={11} className="shrink-0" aria-hidden />
            <span className="truncate min-w-0" data-testid="monitor-card-branch">{row.commandTerminalBranch}</span>
          </>
        ) : row.columnName && (
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
          its numbered name stands in for a title + ticket, and its terminal-shaped
          state glyph is what marks it as not-a-task. */}
      <div className="flex items-center gap-1.5">
        <StateGlyph row={row} />
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

      <OutputPeek
        lines={row.outputPeek}
        rows={row.labels.length > 0 ? PEEK_ROWS_WITH_LABELS : PEEK_ROWS_WITHOUT_LABELS}
      />

      {row.labels.length > 0 && (
        <div className="mt-1.5">
          <LabelPills labels={row.labels} labelColors={labelColors} />
        </div>
      )}

      {/* Every element above is a fixed height (titles and the eyebrow truncate
          rather than wrap, and the peek no longer grows), so this absorbs only the
          small residual between a labelled card and an unlabelled one and keeps
          the footers on one line across the row. */}
      <div className="flex-1" />

      {/* The board card's own footer component, not a copy of it. Its rule is off
          here: the peek's shaded well already closes the content region, and on a
          card with no label pills the well's bottom edge and the rule land within
          a few pixels of each other. The board card keeps the rule, having no
          well of its own to do that job. */}
      {/* `'-'` on an unresolved model, matching MonitorTable's Model column for the
          same null. This slot names the MODEL; the table surfaces the agent in a
          separate Agent column, which the card has no room for. If agent identity
          is ever wanted here, the helper documented for a model-slot fallback is
          `agentShortName` ("Claude"), not `agentDisplayName` ("Claude Code"). */}
      <ContextUsageFooter
        modelName={row.modelDisplayName ?? '-'}
        percent={row.contextPercent ?? 0}
        windowKnown={row.contextPercent !== null}
        unknownLabel="-"
        divider={false}
        testId="monitor-card-usage"
      />
    </div>
  );
}

// Memoized: the virtualizer re-renders the whole visible window on every scroll
// tick, and an activity push re-renders the list on every state change.
export const MonitorCard = React.memo(MonitorCardInner);
