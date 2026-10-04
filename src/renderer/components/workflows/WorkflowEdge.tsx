import React from 'react';
import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import { smoothPath, type Point } from './workflow-layout';

/**
 * A link on the canvas: from the blocker's title row to the waiting task's,
 * through the lanes of any column it crosses, leaving and arriving
 * horizontally. Green once the blocker is done (the link no longer holds
 * anything up), grey while it still does. A link of the selected task is
 * drawn heavier, so its blockers and dependents stand out.
 */
export interface WorkflowEdgeData extends Record<string, unknown> {
  waypoints: Point[];
  sourceOffset: number;
  targetOffset: number;
  satisfied: boolean;
  emphasized: boolean;
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
  return (
    <BaseEdge
      id={id}
      path={smoothPath(points)}
      markerEnd={satisfied ? 'url(#workflow-link-satisfied)' : 'url(#workflow-link-pending)'}
      style={{
        stroke: satisfied ? 'var(--color-active)' : 'var(--color-fg-faint)',
        strokeWidth: emphasized ? 2 : 1.5,
        strokeLinecap: 'round',
        opacity: emphasized ? 0.95 : satisfied ? 0.45 : 0.7,
      }}
    />
  );
});
