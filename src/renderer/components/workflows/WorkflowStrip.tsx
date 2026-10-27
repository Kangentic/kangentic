import React from 'react';
import { useLingui } from '@lingui/react/macro';
import { AlertTriangle, Folder, Workflow as WorkflowIcon } from 'lucide-react';
import type { WorkflowBoardEnds, WorkflowRouteStep, WorkflowTaskPlace } from '../../../shared/types';
import { ColumnGlyph } from '../../utils/swimlane-icons';
import { trackStops, type TrackStop } from './workflow-track';
import { workflowColor } from './workflow-graph';
import { Tooltip } from '../Tooltip';
import { CardStrip } from '../board/CardStrip';

/**
 * The strip on top of a workflow task's card: on the left whatever the card
 * belongs to (its workflow on the board; its project on the Workflows
 * canvas), on the right the step track. On the canvas the column is named by the track itself:
 * its current step is the column's own marker, and the name is the marker's
 * tooltip and accessible name. On the board the lane names the column, so the
 * current step stays a bar. The title row under the strip is the board's,
 * unchanged: new information goes in this strip, never into an existing row.
 * The phone app draws the canvas strip at the same sizes.
 */

const UNCOLORED = 'var(--color-fg-faint)';

/**
 * The column a task is in, drawn as one 18px rounded square: the column's
 * glyph at 12px (its icon, its To Do or Done default, or a dot in its color)
 * on its color at 18%, the strength the old current bar's ring had.
 */
function StepMarker({ stop, color }: { stop: TrackStop; color: string }) {
  const { t } = useLingui();
  const stopName = stop.name;
  const label = t`${stopName}: now`;
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid="workflow-step-marker"
        data-step-state="current"
        data-step-end={stop.end ?? undefined}
        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] shrink-0"
        style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      >
        <ColumnGlyph column={{ icon: stop.icon, role: stop.end }} size={12} color={color} />
      </span>
    </Tooltip>
  );
}

/**
 * How the track draws the stop the task is at. `marker` is the column's own
 * marker, for a surface where nothing else names the column (the Workflows
 * canvas, the phone). `bar` is a wider, brighter bar, for the board, where the
 * lane the card sits in already names it.
 */
export type CurrentStepStyle = 'marker' | 'bar';

/**
 * One mark per stop (`trackStops`). A stop the task has left is a grey bar: it
 * no longer matters. The stop it is at is its column's marker, or the board's
 * bar. A stop still ahead is a bar in its column's color, so a card says which
 * columns it will visit, before it starts and on the way.
 */
export const WorkflowStepTrack = React.memo(function WorkflowStepTrack({ steps, ends, place, currentStep = 'marker' }: {
  steps: readonly WorkflowRouteStep[];
  ends: WorkflowBoardEnds | null;
  place: WorkflowTaskPlace;
  currentStep?: CurrentStepStyle;
}) {
  const { t } = useLingui();
  const stops = trackStops(steps, ends, place);
  if (stops.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" data-testid="workflow-step-track">
      {stops.map((stop) => {
        const color = stop.color ?? UNCOLORED;
        if (stop.state === 'current' && currentStep === 'marker') return <StepMarker key={stop.swimlaneId} stop={stop} color={color} />;
        // Each bar is named by its text, as the marker is, and the same text is its tip.
        // Named, so the translator reads {stopName}, not a member expression.
        const stopName = stop.name;
        if (stop.state === 'current') {
          const currentLabel = t`${stopName}: now`;
          return (
            <Tooltip key={stop.swimlaneId} label={currentLabel}>
              <i
                role="img"
                aria-label={currentLabel}
                data-step-state="current"
                data-step-end={stop.end ?? undefined}
                className="block w-[15px] h-[6px] rounded-[3px]"
                style={{ background: color, boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 18%, transparent)` }}
              />
            </Tooltip>
          );
        }
        const stopLabel = stop.state === 'done' ? t`${stopName}: done` : t`${stopName}: next`;
        return (
          <Tooltip key={stop.swimlaneId} label={stopLabel}>
            <i
              role="img"
              aria-label={stopLabel}
              data-step-state={stop.state}
              data-step-end={stop.end ?? undefined}
              className="block w-[11px] h-[4px] rounded-[2px]"
              style={stop.state === 'done'
                ? { background: UNCOLORED, opacity: 0.55 }
                : { background: `color-mix(in srgb, ${color} 45%, transparent)` }}
            />
          </Tooltip>
        );
      })}
    </span>
  );
});

/**
 * A workflow's glyph in the workflow's own color, which leads its name on the
 * board card's strip, the Agent Monitor's card and list row, and the monitor
 * table. Decorative: the name beside it names the workflow.
 */
export function WorkflowGlyph({ colorSlot }: { colorSlot: number }) {
  return <WorkflowIcon size={12} strokeWidth={2} className="shrink-0" style={{ color: workflowColor(colorSlot) }} aria-hidden />;
}

/** The strip's left side as an icon and a name that truncates. */
export function WorkflowStripLabel({ icon, label, className, testId }: {
  icon: React.ReactNode;
  label: string;
  /** The gap and text color: the workflow's name and a project's name read differently. */
  className: string;
  testId?: string;
}) {
  return (
    <span className={`inline-flex items-center text-xs min-w-0 ${className}`} data-testid={testId}>
      <span className="inline-flex shrink-0">{icon}</span>
      <Tooltip label={label}>
        <span className="truncate">{label}</span>
      </Tooltip>
    </span>
  );
}

/**
 * A card's project, on the strip's left side: the Workflows canvas card shows it
 * on every card (board 17, folded into the strip as the phone draws it), and the
 * Agent Monitor's card does the same, since both show tasks from more than one
 * board. It costs no height: the strip's left side is otherwise empty.
 */
export function ProjectStripLabel({ name, testId }: { name: string; testId: string }) {
  return (
    <WorkflowStripLabel
      icon={<Folder size={12} className="text-fg-muted" />}
      label={name}
      className="gap-1.5 text-fg-tertiary"
      testId={testId}
    />
  );
}

interface WorkflowCardStripProps {
  /** The left side: the workflow on a board card, the project on a canvas card of a workflow across boards. */
  leading?: React.ReactNode;
  steps: readonly WorkflowRouteStep[];
  /** The task's board's To Do and Done columns, the track's two ends. */
  ends: WorkflowBoardEnds | null;
  /** Where the task is, which places it at To Do, on its route, or at Done. */
  place: WorkflowTaskPlace;
  /** How the stop the task is at is drawn: the column's marker, or the board's bar. */
  currentStep?: CurrentStepStyle;
  /** Why its running workflow stalled on this task, while it is: a mark before the track. */
  stallReason?: string | null;
}

/**
 * A running workflow stalled on this task: a warning glyph before the track,
 * with why on hover. In the strip, not the footer, because a stalled task's
 * footer is still its live session's.
 */
function StallMark({ reason }: { reason: string }) {
  const { t } = useLingui();
  return (
    <Tooltip label={t`Stalled: ${reason}`}>
      <span className="inline-flex shrink-0 text-warning" role="img" aria-label={t`Stalled`} data-testid="workflow-card-stalled">
        <AlertTriangle size={12} />
      </span>
    </Tooltip>
  );
}

export const WorkflowCardStrip = React.memo(function WorkflowCardStrip({ leading = null, steps, ends, place, currentStep = 'marker', stallReason = null }: WorkflowCardStripProps) {
  const track = <WorkflowStepTrack steps={steps} ends={ends} place={place} currentStep={currentStep} />;
  return (
    <CardStrip data-testid="workflow-card-strip">
      {leading ?? <span aria-hidden="true" />}
      {stallReason ? (
        <span className="inline-flex items-center gap-1.5 shrink-0">
          <StallMark reason={stallReason} />
          {track}
        </span>
      ) : track}
    </CardStrip>
  );
});
