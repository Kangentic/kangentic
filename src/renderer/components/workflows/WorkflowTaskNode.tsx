import React from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { WorkflowViewTask } from '../../../shared/types';
import { PORT_OFFSET_Y } from './workflow-layout';
import { WorkflowCanvasCard, type WorkflowWaiting } from './WorkflowCanvasCard';

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
 */
export interface WorkflowNodeData extends Record<string, unknown> {
  viewTask: WorkflowViewTask;
  locked: boolean;
  waiting: WorkflowWaiting | null;
  canWait: boolean;
  canBlock: boolean;
  /** Ports are drawn only while the canvas is editable. */
  editable: boolean;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowTask'>;

const PORT_CLASS = '!w-2.5 !h-2.5 !rounded-full !border-2 !border-edge-input !bg-surface-raised';
const HIDDEN_PORT_CLASS = '!w-2.5 !h-2.5 !opacity-0 !pointer-events-none !border-0';

function sameCard(previous: NodeProps<WorkflowFlowNode>, next: NodeProps<WorkflowFlowNode>): boolean {
  return previous.data === next.data && previous.selected === next.selected;
}

export const WorkflowTaskNode = React.memo(function WorkflowTaskNode({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const showTarget = data.editable && data.canWait;
  const showSource = data.editable && data.canBlock;
  return (
    <div className="relative" style={{ width: 256 }}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={showTarget}
        className={showTarget ? PORT_CLASS : HIDDEN_PORT_CLASS}
        style={{ top: PORT_OFFSET_Y }}
      />
      <WorkflowCanvasCard
        viewTask={data.viewTask}
        selected={selected ?? false}
        locked={data.locked}
        waiting={data.waiting}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={showSource}
        className={showSource ? PORT_CLASS : HIDDEN_PORT_CLASS}
        style={{ top: PORT_OFFSET_Y }}
      />
    </div>
  );
}, sameCard);
