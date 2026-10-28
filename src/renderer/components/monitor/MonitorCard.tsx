import React, { useCallback } from 'react';
import { CirclePause, Check, GitBranch } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ActivityMark } from '../ActivityMark';
import { IconSlot } from '../IconSlot';
import type { AppConfig, MonitorSessionRow } from '../../../shared/types';
import { LabelPills } from '../Pill';
import { Tooltip } from '../Tooltip';
import { PrLink } from '../PrLink';
import { ElapsedTime } from '../terminal/ElapsedTime';
import { ContextUsageFooter } from '../board/ContextUsageFooter';
import { CardStrip, cardStripBleedClass } from '../board/CardStrip';
import {
  AutomationsDisabledCardStrip,
  AutomationsDisabledGlyph,
  useAutomationsPausedText,
} from '../board/AutomationsDisabledStrip';
import {
  BrowserAliveGlobe,
  NoModelFooter,
  PendingFooter,
  TicketNumber,
  taskCardFrameClass,
  useLiveTelemetryUnsupported,
} from '../board/task-card-view';
import { ProjectStripLabel, WorkflowGlyph, WorkflowStepTrack, WorkflowStripLabel } from '../workflows/WorkflowStrip';
import {
  CardMessageTrail,
  EXCERPT_CLAMP_CLASS,
  excerptLinesFor,
  TRAIL_HEIGHT_CLASS,
  TRAIL_WELL_CLASS,
  trailModeFor,
  type ExcerptLines,
} from '../board/CardMessageTrail';
import { activityReasonIcon } from '../board/ActivityReasonTooltip';
import { formatActivityReasonText } from '../board/activity-reason-text';
import { stripMarkdown } from '../../utils/strip-markdown';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { bucketOf, formatMonitorStatus, monitorActivityMark, monitorSlotKind, needsUser } from './monitor-view-model';

/**
 * One agent session, rendered as the board's task card.
 *
 * The board card's anatomy, piece for piece: the same title row (state mark with
 * its reason as the tip, bold title, monospace ticket number, the browser globe),
 * the same PrLink, the same slot, the same LabelPills, the same frame (the dimmed,
 * pulsing border while the agent waits on you) and the same footer components
 * (`ContextUsageFooter`, `PendingFooter`), so a user arriving here recognises the
 * object rather than learning a second card. The board card and this one are one
 * design: do not change one without the other.
 *
 * What the board card never needs, because the lane it sits in answers it, rides
 * in the strip across the top, the way the Workflows canvas card carries it: the
 * project on the left (with the workflow, or a Command Terminal's branch), and the
 * step track on the right, whose current step is the column's own marker. A held
 * task stacks the board's "Automations paused" strip above it. Nothing new gets
 * a row of its own; that is what the eyebrow and its activity pill used to be.
 *
 * One departure remains, earning its place: a live OUTPUT PEEK as a third slot
 * source, which the board has no data for. `monitorSlotKind` owns the choice
 * between the three; see it for the ordering and why a live row never falls back
 * to its description.
 */

interface MonitorCardProps {
  row: MonitorSessionRow;
  labelColors: Record<string, string>;
  /** Compact layout: one scannable line per session. */
  dense?: boolean;
  onOpen: (row: MonitorSessionRow) => void;
  /** Right-click: the explicit "put it on the board" override and row utilities. */
  onContextMenu?: (row: MonitorSessionRow, position: { x: number; y: number }) => void;
  /** Drop the project from the list row when the SECTION already names it, so the
   *  row does not repeat its own header. Mirrors MonitorTable's
   *  `hideProjectColumn`. The full card keeps it in its strip regardless, as the
   *  Workflows canvas card does, so every card has one shape. */
  hideProject?: boolean;
}

/**
 * The state glyph's content, matching TaskCard's vocabulary exactly.
 *
 * Switch on the BUCKET, not a second derivation. `bucketOf` already decides
 * which section and summary count this row lands in, and re-deriving the glyph
 * from `isWorking` disagreed with it: a running session that has not reported
 * activity yet buckets as `working` but fails `isActive`, so it was counted
 * under Active while its own card drew the paused glyph.
 *
 * The two ACTIVITY states use the shared branding marks, the same vocabulary a
 * board card shows. A paused or queued session draws nothing on the card, as on
 * the board, whose footer says so instead; the list row, which has no footer,
 * keeps the lucide pause glyph. A finished session keeps its check, a state only
 * the monitor shows.
 */
function stateGlyphContent(
  row: MonitorSessionRow,
  variant: 'card' | 'row',
  reasonText: string,
): { glyph: React.ReactNode; name: string } | null {
  const bucket = bucketOf(row);
  if (bucket === 'needs-you' || bucket === 'working') {
    const needsYou = bucket === 'needs-you';
    const mark = monitorActivityMark(row, needsYou);
    const name = reasonText !== '' ? reasonText : (needsYou ? i18n._(msg`Needs you`) : i18n._(msg`Working`));
    // ONE render site with a computed `mark`, never a conditional pair of
    // siblings: React reconciles siblings positionally, so an idle/working flip
    // would unmount one and mount the other, restarting the march from zero
    // (the lesson pinned for TaskCard in tests/unit/activity-mark.test.ts).
    // Labelled with aria-label: inside an IconSlot the mark's own <svg> root is
    // not hit-testable, so its tip goes on the slot (see IconSlot).
    return {
      glyph: <ActivityMark mark={mark} size={16} className={needsYou ? 'text-attention' : 'text-active'} aria-label={name} />,
      name,
    };
  }
  if (bucket === 'finished') {
    const finishedName = i18n._(msg`Finished`);
    return { glyph: <Check size={14} className="text-fg-disabled" aria-label={finishedName} />, name: finishedName };
  }
  if (variant === 'card') return null;
  const name = row.status === 'queued'
    ? i18n._(msg`Waiting to start`)
    : i18n._(msg({ message: 'Paused', context: 'Agent status' }));
  return { glyph: <CirclePause size={14} className="text-fg-faint" aria-label={name} />, name };
}

/**
 * The state glyph in one `IconSlot`, wrapped once around whatever the branching
 * produced. The card is a `role="button"` carrying other interactive children, so
 * the glyph cannot be protected by neutralizing the card's children wholesale - the
 * slot scopes that to the glyph itself, which is exactly the case it exists for.
 * The slot is 16 in every state, matching the board card's mark exactly.
 *
 * On the card the slot carries the board's tip: the engine's reason, led by the
 * reason's own glyph, or for a finished session when it finished. The list row
 * prints that line beside the glyph, so it needs no tip.
 */
function StateGlyph({ row, variant }: { row: MonitorSessionRow; variant: 'card' | 'row' }) {
  const reasonText = row.activityReason ? formatActivityReasonText(row.activityReason) : '';
  const content = stateGlyphContent(row, variant, reasonText);
  if (!content) return null;
  const slot = <IconSlot size={16} className="shrink-0">{content.glyph}</IconSlot>;
  if (variant === 'row') return slot;
  const tip = row.activityReason ? reasonText : formatMonitorStatus(row);
  return (
    <Tooltip
      label={tip}
      icon={row.activityReason ? activityReasonIcon(row.activityReason) : undefined}
      describe={tip !== content.name}
    >
      {slot}
    </Tooltip>
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
 * happens to be saying.
 *
 * HOW MANY rows is no longer this component's decision. It used to be two when
 * the card had label pills and four when it did not, a local trade that made a
 * labelled card show half as much as its neighbour on the same grid. It is now
 * the card density the board card already uses, so one setting sizes this slot
 * on both surfaces.
 *
 * The well itself is `TRAIL_WELL_CLASS`, imported rather than repeated, because
 * the agent's message trail renders in the same box and this is the one screen
 * that can show both on adjacent cards. That the trail took this treatment
 * overrules an earlier note here saying it deliberately should not: the reason
 * given was that the trail is prose and the peek is bytes, but both are the
 * agent talking, and a reader scanning the grid is better served by one
 * container meaning "machine output" than by two. Prose wraps and terminal
 * lines do not, which is the difference that still earns its keep.
 *
 * Lines are TRIMMED to what fits before rendering rather than overflowed into a
 * clip. That is what allows top alignment: clipping a top-aligned box would drop
 * the NEWEST lines, which are the only ones worth showing. `slice(-rows)` drops
 * the oldest instead, and `overflow-hidden` then only guards against a font or
 * zoom change, never against normal content.
 */
function OutputPeek({ lines, rows }: { lines: string[]; rows: ExcerptLines }) {
  if (lines.length === 0) return null;
  return (
    // The slot's own `mt-1` lives here rather than on a wrapper at the call
    // site, because this component returns null on an empty peek and a wrapper
    // would still draw its margin for a live row whose agent has said nothing.
    <div
      className={`mt-1 ${TRAIL_WELL_CLASS} text-fg-muted select-text`}
      data-testid="monitor-card-peek"
      data-rows={rows}
    >
      <div className={`overflow-hidden ${TRAIL_HEIGHT_CLASS[rows]}`}>
        {lines.slice(-rows).map((line, index) => (
          <div key={index} className="whitespace-pre overflow-hidden text-ellipsis">{line}</div>
        ))}
      </div>
    </div>
  );
}

/** The card's right-click, scoped with `currentTarget.contains()`: the card is
 *  itself a role="button", and a nested interactive element's own menu must win
 *  over this one. */
function useCardContextMenu(row: MonitorSessionRow, onContextMenu: MonitorCardProps['onContextMenu']) {
  return (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(row, { x: event.clientX, y: event.clientY });
  };
}

/** A workflow's icon in the workflow's own color and its name, as the board card's strip draws it. No pause glyph, paused or not. */
function WorkflowLabel({ row, testId, className }: { row: MonitorSessionRow; testId: string; className: string }) {
  if (!row.workflow) return null;
  return (
    <WorkflowStripLabel
      icon={<WorkflowGlyph colorSlot={row.workflow.colorSlot} />}
      label={row.workflow.title}
      className={className}
      testId={testId}
    />
  );
}

/**
 * The card's strips: the board's "Automations paused" strip on a held task,
 * then the strip every card wears. One bleed wrapper around both, so they stack
 * flush and the pair still meets the card's rounded top corners.
 *
 * The strip's left side says where the session works, as the Workflows canvas
 * card does: the project, then the workflow for a workflow task, or the branch for
 * a Command Terminal (which has no column). Its right side is the step track,
 * whose current step is the column's own marker, so no column name is needed.
 */
function MonitorCardStrips({ row, density }: { row: MonitorSessionRow; density: AppConfig['cardDensity'] }) {
  return (
    <div className={cardStripBleedClass(density)}>
      {row.automationsDisabled && <AutomationsDisabledCardStrip testId="monitor-card-automations-disabled" inWorkflow={row.workflow !== null} />}
      <CardStrip data-testid="monitor-card-strip">
        <span className="flex items-center gap-2.5 min-w-0">
          {row.isCommandTerminal ? (
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <ProjectStripLabel name={row.projectName} testId="monitor-card-project" />
              {row.commandTerminalBranch && (
                <>
                  <span className="text-xs text-fg-disabled shrink-0">/</span>
                  <WorkflowStripLabel
                    icon={<GitBranch size={11} aria-hidden />}
                    label={row.commandTerminalBranch}
                    className="gap-1 text-fg-muted"
                    testId="monitor-card-branch"
                  />
                </>
              )}
            </span>
          ) : (
            <>
              <ProjectStripLabel name={row.projectName} testId="monitor-card-project" />
              <WorkflowLabel row={row} testId="monitor-card-workflow" className="gap-[5px] text-fg-muted" />
            </>
          )}
        </span>
        {row.track && <WorkflowStepTrack {...row.track} currentStep="marker" />}
      </CardStrip>
    </div>
  );
}

/**
 * The list row's slices: what the full card's strips carry, turned on their
 * side and closing the row at its right edge. The strip's shell, so each reads
 * as the same object: a held task's "Automations paused", then a workflow
 * task's name and track, both on a held workflow task as its card stacks both
 * strips. Nothing for any other row, which keeps the row as it is today.
 */
function MonitorRowSlice({ row }: { row: MonitorSessionRow }) {
  const shell = 'shrink-0 flex items-center px-2.5 border-l border-edge bg-surface/30 text-xs text-fg-muted whitespace-nowrap';
  if (!row.automationsDisabled && !row.workflow) return null;
  return (
    <>
      {row.automationsDisabled && <AutomationsPausedSlice className={`${shell} gap-[5px]`} inWorkflow={row.workflow !== null} />}
      {row.workflow && (
        <span className={`${shell} gap-2.5`} data-testid="monitor-row-workflow">
          <WorkflowLabel row={row} testId="monitor-row-workflow-name" className="gap-[5px] text-fg-muted max-w-[22ch]" />
          {row.track && <WorkflowStepTrack {...row.track} currentStep="marker" />}
        </span>
      )}
    </>
  );
}

function AutomationsPausedSlice({ className, inWorkflow }: { className: string; inWorkflow: boolean }) {
  const { label, tip } = useAutomationsPausedText(inWorkflow);
  return (
    <Tooltip label={tip}>
      <span className={className} data-testid="monitor-row-automations-disabled">
        <AutomationsDisabledGlyph />
        <span>{label}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The compact list layout: one scannable line per session, no slot. Its own
 * component so a list of a hundred rows subscribes to nothing the slot needs;
 * the full card below is the only reader of the Card Preview setting and the
 * session's message trail.
 *
 * Every item is centered on the row, as the card's title row is. The one pair
 * that sits on a shared baseline is the activity line and the elapsed time: an
 * 11px time centered beside 12px text rode visibly above it.
 */
function MonitorDenseCard({ row, onOpen, onContextMenu, hideProject = false }: MonitorCardProps) {
  const { t } = useLingui();
  const activityLine = formatMonitorStatus(row);
  const showTaskNumbers = useConfigStore((state) => state.config.showTaskNumbers);
  const handleContextMenu = useCardContextMenu(row, onContextMenu);
  const taskTitle = row.taskTitle;
  return (
    <Tooltip label={t`Open ${taskTitle}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(row)}
        onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row); }}
        onContextMenu={handleContextMenu}
        className="border border-edge rounded-md bg-surface-raised min-w-0 flex items-stretch overflow-hidden hover:border-edge-input transition-colors cursor-pointer select-none text-left"
        data-testid="monitor-card"
        data-dense="true"
        data-session-id={row.sessionId}
        data-project-id={row.projectId}
      >
        <div className="flex-1 min-w-0 px-2.5 py-1.5 flex items-center gap-2">
          <StateGlyph row={row} variant="row" />
          {!hideProject && (
            <span className="text-[11px] text-fg-muted truncate shrink-0 max-w-[18ch]">{row.projectName}</span>
          )}
          {/* The ticket sits right after the title, as on the card's title row. */}
          <span className="text-sm text-fg font-medium truncate min-w-0">{row.taskTitle}</span>
          {showTaskNumbers && row.displayId !== null && (
            <TicketNumber displayId={row.displayId} testId="monitor-row-display-id" className="select-text" />
          )}
          <span className="flex-1" />
          <span className="inline-flex items-baseline gap-2 min-w-0" data-testid="monitor-row-activity">
            <span className={`text-xs truncate min-w-0 max-w-[30ch] select-text ${needsUser(row) ? 'text-attention' : 'text-fg-faint'}`}>
              {activityLine}
            </span>
            {row.status !== 'exited' && (
              <ElapsedTime startedAt={row.startedAt} className="shrink-0 tabular-nums text-[11px] text-fg-faint" />
            )}
          </span>
        </div>
        <MonitorRowSlice row={row} />
      </div>
    </Tooltip>
  );
}

/**
 * The board card's footer states. `modelReported` is compared strictly with
 * `false` so a row from a source that predates the field keeps the model footer
 * rather than reading as a session still starting. An agent with no telemetry
 * channel never reports a model, so it gets its adapter's label instead of a
 * spinner that would never end, as on the board card.
 */
function MonitorCardFooter({ row, divider }: { row: MonitorSessionRow; divider: boolean }) {
  const liveTelemetryUnsupported = useLiveTelemetryUnsupported(row.agentName);
  if (row.status === 'queued') return <PendingFooter state="queued" divider={divider} testId="monitor-card-status" />;
  if (row.status === 'suspended') return <PendingFooter state="paused" divider={divider} testId="monitor-card-status" />;
  if (row.status === 'running' && row.modelReported === false) {
    return (
      <NoModelFooter liveTelemetryUnsupported={liveTelemetryUnsupported} resuming={false} divider={divider} testId="monitor-card-usage" />
    );
  }
  // `'-'` on an unresolved model, matching MonitorTable's Model column for the
  // same null. This slot names the MODEL; the table surfaces the agent in a
  // separate Agent column, which the card has no room for.
  return (
    <ContextUsageFooter
      modelName={row.modelDisplayName ?? '-'}
      percent={row.contextPercent ?? 0}
      windowKnown={row.contextPercent !== null}
      unknownLabel="-"
      testId="monitor-card-usage"
      divider={divider}
    />
  );
}

function MonitorFullCard({
  row,
  labelColors,
  onOpen,
  onContextMenu,
}: MonitorCardProps) {
  const { t } = useLingui();
  const handleContextMenu = useCardContextMenu(row, onContextMenu);
  const taskTitle = row.taskTitle;

  // The slot's content follows the Task tab's Card Preview, exactly as the board
  // card's does. The trail lives in the session store (main pushes it on change;
  // this window's `syncSessions` seeds it), keyed by session so another row's
  // line does not re-render this card.
  const cardPreview = useConfigStore((state) => state.config.cardPreview);
  const cardDensity = useConfigStore((state) => state.config.cardDensity);
  const showTaskNumbers = useConfigStore((state) => state.config.showTaskNumbers);
  const messageTrail = useSessionStore(
    useCallback(
      (state: ReturnType<typeof useSessionStore.getState>) => state.sessionMessageTrails[row.sessionId],
      [row.sessionId],
    ),
  );
  // The board card's clamp, off the same setting and through the same helper,
  // rather than a row count this card decided for itself.
  const isCompact = cardDensity === 'compact';
  const slotRows = excerptLinesFor(cardDensity);
  const trailMode = trailModeFor(cardPreview);
  const hasTrail = Boolean(messageTrail && messageTrail.length > 0);
  const slotKind = monitorSlotKind(row, trailMode, hasTrail);
  // The board card's rule: the agent's well closes its own edge, so the footer's
  // rule goes when the trail sits right above it with no labels between.
  const footerDivider = !(slotKind === 'trail' && row.labels.length === 0);

  return (
    <Tooltip label={t`Open ${taskTitle}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(row)}
        onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row); }}
        onContextMenu={handleContextMenu}
        // The board card's frame: its padding by density, and while the agent
        // waits on you, its dimmed border and slow pulse.
        className={`${taskCardFrameClass({ isHighlighted: false, isIdle: needsUser(row) }, cardDensity)} min-w-0 flex flex-col cursor-pointer select-none transition-colors text-left`}
        data-testid="monitor-card"
        data-session-id={row.sessionId}
        data-project-id={row.projectId}
      >
        <MonitorCardStrips row={row} density={cardDensity} />

        {/* Title row - identical to TaskCard's. A Command Terminal has no task, so
            its numbered name stands in for a title + ticket, and its terminal-shaped
            state glyph is what marks it as not-a-task. */}
        <div className="flex items-center gap-1.5">
          <StateGlyph row={row} variant="card" />
          <div className="text-sm text-fg font-medium truncate flex-1 min-w-0" data-testid="monitor-card-title">
            {row.taskTitle}
          </div>
          {showTaskNumbers && row.displayId !== null && (
            <TicketNumber displayId={row.displayId} testId="monitor-card-display-id" className="select-text" />
          )}
          {row.browserRunning && <BrowserAliveGlobe testId="monitor-card-browser-alive" />}
        </div>

        {!isCompact && row.prUrl && (
          <div className="flex items-center gap-2 mt-1.5">
            <PrLink
              prUrl={row.prUrl}
              prNumber={row.prNumber}
              prState={row.prState}
              prMergeReadiness={row.prMergeReadiness}
              testId="monitor-card-pr-link"
            />
          </div>
        )}

        {/* The board card's slot, exactly: `mt-1`, the agent's output in the well,
            a content-sized description otherwise. `monitorSlotKind` decides which,
            and `MonitorBody` asks it the same question to name the rows main
            should keep sampling a peek for. */}
        {slotKind === 'trail' && trailMode && messageTrail ? (
          // `select-text` here rather than inside CardMessageTrail: the board card
          // renders the same component on a drag source, where selectable text is
          // the thing the card's own `select-none` exists to stop.
          <div className="mt-1 select-text">
            <CardMessageTrail
              entries={messageTrail}
              lines={slotRows}
              mode={trailMode}
              lineClass="text-fg-muted"
              terminal
              testId="monitor-card-trail"
            />
          </div>
        ) : slotKind === 'description' ? (
          <div
            className={`text-xs text-fg-faint mt-1 ${EXCERPT_CLAMP_CLASS[slotRows]}`}
            data-testid="monitor-card-description"
            data-lines={slotRows}
          >
            {stripMarkdown(row.description ?? '')}
          </div>
        ) : (
          <OutputPeek lines={row.outputPeek} rows={slotRows} />
        )}

        {row.labels.length > 0 && (
          <div className="mt-1.5">
            <LabelPills labels={row.labels} labelColors={labelColors} />
          </div>
        )}

        {/* Every element above is a fixed height (titles truncate rather than wrap,
            and the peek does not grow), so this absorbs only the residual between a
            labelled card and an unlabelled one, or a held card's extra strip, and
            keeps the footers on one line across the row. */}
        <div className="flex-1" />

        {/* The board card's footer states, through the board's own components.
            Compact density drops the footer, as the board card does. */}
        {!isCompact && <MonitorCardFooter row={row} divider={footerDivider} />}
      </div>
    </Tooltip>
  );
}

function MonitorCardInner(props: MonitorCardProps) {
  return props.dense ? <MonitorDenseCard {...props} /> : <MonitorFullCard {...props} />;
}

// Memoized: the virtualizer re-renders the whole visible window on every scroll
// tick, and an activity push re-renders the list on every state change.
export const MonitorCard = React.memo(MonitorCardInner);
