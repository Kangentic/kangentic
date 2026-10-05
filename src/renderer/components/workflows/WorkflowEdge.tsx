import React from 'react';
import { BaseEdge, Position, getBezierPath, type ConnectionLineComponentProps, type Edge, type EdgeProps } from '@xyflow/react';
import { PORT_OFFSET_Y, smoothPath, type Point } from './workflow-layout';
import type { WorkflowFlowNode } from './WorkflowTaskNode';

/**
 * A link on the canvas: from the blocker's title row to the waiting task's,
 * through the lanes of any column it crosses, leaving and arriving
 * horizontally. Green once the blocker is done (the link no longer holds
 * anything up), grey while it still does. A link of the selected task is
 * drawn heavier, so its blockers and dependents stand out. The link a drag
 * just made is drawn in the accent until the selection moves on (board 10b).
 *
 * Its SVG is a drawing computed from the layout, not an icon, as the commit
 * graph's is (`CommitGraphSvg.tsx`), so the Lucide-only icon rule
 * (`ui-conventions.md`) does not cover it.
 */
export interface WorkflowEdgeData extends Record<string, unknown> {
  waypoints: Point[];
  sourceOffset: number;
  targetOffset: number;
  satisfied: boolean;
  emphasized: boolean;
  /** Made by the drag that just ended. */
  fresh: boolean;
}

export type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflowLink'>;

export const WORKFLOW_EDGE_MARKERS = (
  <svg width="0" height="0" className="absolute" aria-hidden="true">
    <defs>
      <marker id="workflow-link-satisfied" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0 1 L9 5 L0 9 z" fill="var(--color-active)" />
      </marker>
      <marker id="workflow-link-pending" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0 1 L9 5 L0 9 z" fill="var(--color-fg-faint)" />
      </marker>
      <marker id="workflow-link-fresh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M0 1 L9 5 L0 9 z" fill="var(--color-accent-fg)" />
      </marker>
    </defs>
  </svg>
);

export const WorkflowEdge = React.memo(function WorkflowEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<WorkflowFlowEdge>) {
  const points: Point[] = [
    { x: sourceX, y: sourceY + (data?.sourceOffset ?? 0) },
    ...(data?.waypoints ?? []),
    { x: targetX, y: targetY + (data?.targetOffset ?? 0) },
  ];
  const satisfied = data?.satisfied ?? false;
  const emphasized = data?.emphasized ?? false;
  const fresh = data?.fresh ?? false;
  const state = fresh ? 'fresh' : satisfied ? 'satisfied' : 'pending';
  return (
    <BaseEdge
      id={id}
      path={smoothPath(points)}
      markerEnd={`url(#workflow-link-${state})`}
      data-link-state={state}
      style={{
        stroke: fresh ? 'var(--color-accent-fg)' : satisfied ? 'var(--color-active)' : 'var(--color-fg-faint)',
        strokeWidth: fresh || emphasized ? 2 : 1.5,
        strokeLinecap: 'round',
        opacity: fresh ? 1 : emphasized ? 0.95 : satisfied ? 0.45 : 0.7,
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
