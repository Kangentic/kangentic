import React, { useContext } from 'react';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowViewTask } from '../../../shared/types';
import { PORT_OFFSET_Y, PROJECT_ROW_HEIGHT } from './workflow-layout';
import { WorkflowCanvasCard, type WorkflowWaiting } from './WorkflowCanvasCard';
import { WorkflowDetailContext } from './workflow-canvas-context';
import { findTask, linkRefusal, taskLabel } from './workflow-graph';

/**
 * A card on the Workflows canvas. Its `data` is the task's view row, which
 * changes only when the workflow reloads; live session state (activity, the
 * agent's trail, the context bar) is read by the card itself from the session
 * store, as a board card does. The memo ignores the position props React Flow
 * passes on every drag frame, so a drag moves the card's wrapper and never
 * re-renders the card (React Flow's own performance guidance).
 *
 * A port is drawn only where it can take a link: the outgoing port on a task
 * that is not done, the incoming one on a task that can still wait (planned,
 * or in To Do). The ports stay mounted either way, because a link is drawn
 * from them.
 *
 * While a link is being drawn, the whole card is the drop target (React
 * Flow's Easy Connect pattern), and the card under the pointer says what a
 * release would do: "Release to make #417 wait for #419" with an accent ring,
 * or the refusal main would give.
 *
 * The card-sized target is mounted with the card and measured once, and takes
 * the pointer only while the canvas root carries `data-linking` (index.css), so
 * it never takes a card drag. Starting or ending a link therefore re-renders
 * no card: at 100 cards, mounting the target on every card at the start and
 * re-measuring each made a 48 to 62ms frame at both ends of the gesture
 * (`scripts/drag-perf-rig.mjs`, W100 link drag).
 */
export interface WorkflowNodeData extends Record<string, unknown> {
  viewTask: WorkflowViewTask;
  locked: boolean;
  waiting: WorkflowWaiting | null;
  canWait: boolean;
  canBlock: boolean;
  /** Ports are drawn only while the canvas is editable. */
  editable: boolean;
  /** The task's board, named while the workflow spans boards (board 17); null while it is on one. */
  projectName: string | null;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowTask'>;

const PORT_CLASS = '!w-2.5 !h-2.5 !rounded-full !border-2 !border-edge-input !bg-surface-raised';
const HIDDEN_PORT_CLASS = '!w-2.5 !h-2.5 !opacity-0 !pointer-events-none !border-0';
const CARD_TARGET_CLASS = 'workflow-card-target !absolute !inset-0 !w-full !h-full !min-w-0 !min-h-0 !rounded-md !border-0 !bg-transparent !opacity-0 !transform-none';

/** What releasing the link being drawn over this card would do. */
function LinkDropHint({ nodeId }: { nodeId: string }) {
  const detail = useContext(WorkflowDetailContext);
  // A primitive, so the hint re-renders only when the hover changes, not on every pointer move.
  const hover = useConnection((connection) => (
    connection.inProgress && connection.toNode?.id === nodeId && connection.fromNode && connection.fromNode.id !== nodeId
      ? `${connection.fromNode.id}|${connection.isValid ? 'valid' : 'refused'}`
      : null
  ));
  if (!hover || !detail) return null;
  const [blockerKey, verdict] = hover.split('|');
  const blocker = findTask(detail, blockerKey);
  const blocked = findTask(detail, nodeId);
  if (!blocker || !blocked) return null;
  const refusal = verdict === 'valid' ? null : linkRefusal(detail, blockerKey, nodeId);
  return (
    <>
      {refusal === null && <div className="absolute inset-0 rounded-md ring-2 ring-accent pointer-events-none" aria-hidden="true" />}
      <div className="absolute left-1/2 -top-9 -translate-x-1/2 pointer-events-none whitespace-nowrap" data-testid="workflow-link-hint">
        <span className={`inline-block px-2.5 py-1 rounded-md border text-xs shadow-lg bg-surface-raised ${refusal === null ? 'border-accent/50 text-fg' : 'border-edge-input text-fg-muted'}`}>
          {refusal ?? `Release to make ${taskLabel(blocked)} wait for ${taskLabel(blocker)}`}
        </span>
      </div>
    </>
  );
}

function sameCard(previous: NodeProps<WorkflowFlowNode>, next: NodeProps<WorkflowFlowNode>): boolean {
  return previous.data === next.data && previous.selected === next.selected;
}

export const WorkflowTaskNode = React.memo(function WorkflowTaskNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const showTarget = data.editable && data.canWait;
  const showSource = data.editable && data.canBlock;
  // The ports stay on the title row, which the project row moves down.
  const portTop = PORT_OFFSET_Y + (data.projectName !== null ? PROJECT_ROW_HEIGHT : 0);
  return (
    <div className="relative" style={{ width: 256 }}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={showTarget}
        className={showTarget ? PORT_CLASS : HIDDEN_PORT_CLASS}
        style={{ top: portTop }}
      />
      <WorkflowCanvasCard
        viewTask={data.viewTask}
        selected={selected ?? false}
        locked={data.locked}
        waiting={data.waiting}
        projectName={data.projectName}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={showSource}
        className={showSource ? PORT_CLASS : HIDDEN_PORT_CLASS}
        style={{ top: portTop }}
      />
      {data.editable && (
        <Handle id="card" type="target" position={Position.Left} isConnectable isConnectableStart={false} className={CARD_TARGET_CLASS} />
      )}
      <LinkDropHint nodeId={id} />
    </div>
  );
}, sameCard);
