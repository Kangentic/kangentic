import React from 'react';
import type { WorkflowBoardEnds, WorkflowRouteStep, WorkflowTaskPlace } from '../../../shared/types';
import { ColumnGlyph } from '../../utils/swimlane-icons';
import { trackStops, type TrackStop } from './workflow-track';
import { HoverTip } from '../HoverTip';

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
  const label = `${stop.name}: now`;
  return (
    <HoverTip label={label}>
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
    </HoverTip>
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
  const stops = trackStops(steps, ends, place);
  if (stops.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" data-testid="workflow-step-track">
      {stops.map((stop) => {
        const color = stop.color ?? UNCOLORED;
        if (stop.state === 'current' && currentStep === 'marker') return <StepMarker key={stop.swimlaneId} stop={stop} color={color} />;
        // Each bar is named by its text, as the marker is, and the same text is its tip.
        if (stop.state === 'current') {
          const currentLabel = `${stop.name}: now`;
          return (
            <HoverTip key={stop.swimlaneId} label={currentLabel}>
              <i
                role="img"
                aria-label={currentLabel}
                data-step-state="current"
                data-step-end={stop.end ?? undefined}
                className="block w-[15px] h-[6px] rounded-[3px]"
                style={{ background: color, boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 18%, transparent)` }}
              />
            </HoverTip>
          );
        }
        const stopLabel = `${stop.name}: ${stop.state === 'done' ? 'done' : 'next'}`;
        return (
          <HoverTip key={stop.swimlaneId} label={stopLabel}>
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
          </HoverTip>
        );
      })}
    </span>
  );
});

/** The strip's left side as an icon and a name that truncates, with an optional mark after it that never does. */
export function WorkflowStripLabel({ icon, label, labelTrailing, className, testId }: {
  icon: React.ReactNode;
  label: string;
  /** Drawn right after the label and never truncated with it (a paused workflow's pause glyph). */
  labelTrailing?: React.ReactNode;
  /** The gap and text color: the workflow's name and a project's name read differently. */
  className: string;
  testId?: string;
}) {
  return (
    <span className={`inline-flex items-center text-xs min-w-0 ${className}`} data-testid={testId}>
      <span className="inline-flex shrink-0">{icon}</span>
      <HoverTip label={label}>
        <span className="truncate">{label}</span>
      </HoverTip>
      {labelTrailing && <span className="inline-flex shrink-0">{labelTrailing}</span>}
    </span>
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
}

export const WorkflowCardStrip = React.memo(function WorkflowCardStrip({ leading = null, steps, ends, place, currentStep = 'marker' }: WorkflowCardStripProps) {
  return (
    <div
      className="h-[29px] px-2.5 flex items-center justify-between gap-2 border-b border-edge bg-surface/30 shrink-0"
      data-testid="workflow-card-strip"
    >
      {leading ?? <span aria-hidden="true" />}
      <WorkflowStepTrack steps={steps} ends={ends} place={place} currentStep={currentStep} />
    </div>
  );
});
