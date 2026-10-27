import React, { useContext } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowBoardEnds, WorkflowViewTask } from '../../../shared/types';
import { PORT_OFFSET_Y } from './workflow-layout';
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
 * from them. A link starts only at an outgoing port, so it always runs from
 * the blocker to the task that waits.
 *
 * While a link is being drawn, the whole card is the drop target (React
 * Flow's Easy Connect pattern), and the card under the pointer says what a
 * release would do: "Release to make #417 wait for #419" over a ring, a halo
 * and its filled port, or the refusal main would give. Which incoming ports
 * stay during the drag is one rule the canvas writes (index.css), so the
 * ports change without a card re-rendering.
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
  waiting: WorkflowWaiting | null;
  canWait: boolean;
  canBlock: boolean;
  /** Ports are drawn only while the canvas is editable. */
  editable: boolean;
  /** The task's board, named in its strip on every card (board 17, then sign-off 4b). */
  projectName: string;
  /** A task on another board than the home: that board's Done color, which its Done card wears. Null on the home board. */
  doneColor: string | null;
  /** The task's board's To Do and Done columns, the two ends of its card's track. */
  ends: WorkflowBoardEnds | null;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowTask'>;

// A port is a 10px dot ringed in the accent on the canvas's fill (boards 1, 10).
// `workflow-port-in` / `workflow-port-out` are what index.css hides during a link drag.
const PORT_CLASS = '!w-2.5 !h-2.5 !rounded-full !border-2 !border-accent-fg !bg-surface';
const HIDDEN_PORT_CLASS = '!w-2.5 !h-2.5 !opacity-0 !pointer-events-none !border-0';
const CARD_TARGET_CLASS = 'workflow-card-target !absolute !inset-0 !w-full !h-full !min-w-0 !min-h-0 !rounded-md !border-0 !bg-transparent !opacity-0 !transform-none';

/**
 * The box that says what a release does, over a card or beside the pointer:
 * the app's menu surface, never the accent, so a refusal and an offer read
 * alike (board 10b).
 */
export const LINK_HINT_CLASS = 'workflow-link-hint pointer-events-none whitespace-nowrap px-2.5 py-2 rounded-md border border-edge-input bg-surface-raised shadow-xl text-xs text-fg-tertiary';

/** What releasing the link being drawn over this card would do. */
function LinkDropHint({ nodeId, portTop }: { nodeId: string; portTop: number }) {
  const { t } = useLingui();
  const detail = useContext(WorkflowDetailContext);
  // Only this card's hover, so the hint re-renders when the hover changes, not on every pointer move.
  const hover = useConnection((connection) => (
    connection.inProgress && connection.toNode?.id === nodeId && connection.fromNode.id !== nodeId
      ? { blockerKey: connection.fromNode.id, valid: connection.isValid === true }
      : null
  ));
  if (!hover || !detail) return null;
  const blocker = findTask(detail, hover.blockerKey);
  const blocked = findTask(detail, nodeId);
  if (!blocker || !blocked) return null;
  const refusal = hover.valid ? null : linkRefusal(detail, hover.blockerKey, nodeId);
  const blockedLabel = taskLabel(blocked);
  const blockerLabel = taskLabel(blocker);
  // Refused by the port under the pointer, not by the workflow (an outgoing
  // port is no drop target): the hint beside the pointer speaks instead.
  if (!hover.valid && refusal === null) return null;
  return (
    <>
      {refusal === null && (
        <>
          <div className="workflow-link-target absolute inset-0 rounded-md pointer-events-none" aria-hidden="true" data-testid="workflow-link-target" />
          <span
            className="absolute left-0 w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-4 ring-accent/30 pointer-events-none"
            style={{ top: portTop }}
            aria-hidden="true"
            data-testid="workflow-link-target-port"
          />
        </>
      )}
      {/* Left-aligned with the card, 44px above it (board 10b). */}
      <div
        className={`${LINK_HINT_CLASS} absolute left-0 -top-11`}
        data-testid="workflow-link-hint"
        data-link-verdict={refusal === null ? 'valid' : 'refused'}
      >
        {refusal ?? t`Release to make ${blockedLabel} wait for ${blockerLabel}`}
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
  // The middle of the title row, the same on every card: a card's project sits in its strip.
  const portTop = PORT_OFFSET_Y;
  return (
    // `workflow-node` carries the lift while React Flow drags the card (index.css).
    <div className="workflow-node relative rounded-md" style={{ width: 256 }}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={showTarget}
        isConnectableStart={false}
        className={`workflow-port-in ${showTarget ? PORT_CLASS : HIDDEN_PORT_CLASS}`}
        style={{ top: portTop }}
      />
      <WorkflowCanvasCard
        viewTask={data.viewTask}
        selected={selected ?? false}
        waiting={data.waiting}
        projectName={data.projectName}
        doneColor={data.doneColor}
        ends={data.ends}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={showSource}
        className={`workflow-port-out ${showSource ? PORT_CLASS : HIDDEN_PORT_CLASS}`}
        style={{ top: portTop }}
      />
      {data.editable && (
        <Handle id="card" type="target" position={Position.Left} isConnectable isConnectableStart={false} className={CARD_TARGET_CLASS} />
      )}
      <LinkDropHint nodeId={id} portTop={portTop} />
    </div>
  );
}, sameCard);
