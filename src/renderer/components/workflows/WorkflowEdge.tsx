import React from 'react';
import { BaseEdge, Position, getBezierPath, type ConnectionLineComponentProps, type Edge, type EdgeProps } from '@xyflow/react';
import { PORT_OFFSET_Y, smoothPath, type Point } from './workflow-layout';
import type { WorkflowFlowNode } from './WorkflowTaskNode';

/**
 * A link on the canvas: from the blocker's port to the waiting task's,
 * through the lanes of any column it crosses, leaving and arriving
 * horizontally. Every link of a card leaves and arrives at its port's center,
 * and its arrow's tip lands on the port circle's edge.
 *
 * How it reads follows the selection (sign-off, 2026-10-07), in the board
 * links overlay's colors (`WorkflowLinksOverlay.tsx`):
 * - Nothing selected: green once its blocker is done (it no longer holds
 *   anything up), grey while it still does.
 * - The selected task's own links, drawn whole and flowing from blocker to
 *   dependent (index.css), so the direction reads at a glance: a link from a
 *   blocker is green once that blocker is done and a brighter grey while it
 *   is not; a link to a task that waits on it is the accent.
 * - Every other link fades back to 20%.
 * The link a drag just made is the accent until the selection moves on
 * (board 10b).
 *
 * Its SVG is a drawing computed from the layout, not an icon, as the commit
 * graph's is (`CommitGraphSvg.tsx`), so the Lucide-only icon rule
 * (`ui-conventions.md`) does not cover it.
 */

/** A link's relation to the selected task: from one of its blockers, to a task that waits on it, neither, or nothing is selected. */
export type WorkflowLinkRelation = 'blocker' | 'dependent' | 'muted' | null;

export interface WorkflowEdgeData extends Record<string, unknown> {
  waypoints: Point[];
  satisfied: boolean;
  relation: WorkflowLinkRelation;
  /** Made by the drag that just ended. */
  fresh: boolean;
}

export type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflowLink'>;

/** One arrowhead per color a link is drawn in; its tip (x 9) is the path's end. */
const MARKER_COLORS = {
  active: 'var(--color-active)',
  faint: 'var(--color-fg-faint)',
  muted: 'var(--color-fg-muted)',
  accent: 'var(--color-accent-fg)',
} as const;
type MarkerColor = keyof typeof MARKER_COLORS;

export const WORKFLOW_EDGE_MARKERS = (
  <svg width="0" height="0" className="absolute" aria-hidden="true">
    <defs>
      {(Object.keys(MARKER_COLORS) as MarkerColor[]).map((name) => (
        <marker key={name} id={`workflow-link-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 1 L9 5 L0 9 z" fill={MARKER_COLORS[name]} />
        </marker>
      ))}
    </defs>
  </svg>
);

interface LinkLook {
  color: MarkerColor;
  width: number;
  opacity: number;
  flowing: boolean;
}

function lookOf(satisfied: boolean, relation: WorkflowLinkRelation, fresh: boolean): LinkLook {
  if (fresh) return { color: 'accent', width: 2, opacity: 1, flowing: false };
  if (relation === 'blocker') return { color: satisfied ? 'active' : 'muted', width: 2, opacity: 1, flowing: true };
  if (relation === 'dependent') return { color: 'accent', width: 2, opacity: 1, flowing: true };
  const color: MarkerColor = satisfied ? 'active' : 'faint';
  if (relation === 'muted') return { color, width: 1.5, opacity: 0.2, flowing: false };
  return { color, width: 1.5, opacity: satisfied ? 0.45 : 0.7, flowing: false };
}

export const WorkflowEdge = React.memo(function WorkflowEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<WorkflowFlowEdge>) {
  const points: Point[] = [
    { x: sourceX, y: sourceY },
    ...(data?.waypoints ?? []),
    { x: targetX, y: targetY },
  ];
  const satisfied = data?.satisfied ?? false;
  const relation = data?.relation ?? null;
  const fresh = data?.fresh ?? false;
  const look = lookOf(satisfied, relation, fresh);
  return (
    <BaseEdge
      id={id}
      path={smoothPath(points)}
      className={look.flowing ? 'workflow-link-flow' : undefined}
      markerEnd={`url(#workflow-link-${look.color})`}
      data-link-state={fresh ? 'fresh' : satisfied ? 'satisfied' : 'pending'}
      data-link-relation={relation ?? 'none'}
      style={{
        stroke: MARKER_COLORS[look.color],
        strokeWidth: look.width,
        strokeLinecap: 'round',
        opacity: look.opacity,
      }}
    />
  );
});

/** Half a port's 10px dot. */
const PORT_RADIUS = 5;

const CONNECTION_LINE_STYLE: React.CSSProperties = {
  stroke: 'var(--color-accent-fg)',
  strokeWidth: 2,
  strokeDasharray: '6 5',
  strokeLinecap: 'round',
};

/**
 * The link being drawn: a dashed accent line from a filled dot where the
 * blocker's port was (ports hide during the drag) to the pointer, or to the
 * incoming port of the task under the pointer when that task can take it
 * (boards 10, 10b). React Flow's own line is 1px grey and ends at the card's
 * middle, the anchor of the whole-card drop target.
 */
export function WorkflowConnectionLine({ fromX, fromY, fromPosition, toX, toY, toPosition, toNode, connectionStatus }: ConnectionLineComponentProps<WorkflowFlowNode>) {
  const target = connectionStatus === 'valid' && toNode
    ? { x: toNode.internals.positionAbsolute.x, y: toNode.internals.positionAbsolute.y + PORT_OFFSET_Y }
    : { x: toX, y: toY };
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: target.x,
    targetY: target.y,
    targetPosition: toPosition,
  });
  // React Flow starts the line at the port's outer edge; the dot sits where the port's center was.
  const originX = fromPosition === Position.Right ? fromX - PORT_RADIUS : fromPosition === Position.Left ? fromX + PORT_RADIUS : fromX;
  return (
    <g data-testid="workflow-connection-line">
      <path d={path} fill="none" className="react-flow__connection-path" style={CONNECTION_LINE_STYLE} />
      <circle cx={originX} cy={fromY} r={PORT_RADIUS} fill="var(--color-accent-fg)" />
    </g>
  );
}
