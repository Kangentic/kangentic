import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import type { WorkflowDetail } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { layoutWorkflow } from './workflow-layout';
import { canBlock, canWait, linkRefusal, waitingOf } from './workflow-graph';
import { canvasCardHeight } from './WorkflowCanvasCard';
import { WorkflowTaskNode, type WorkflowFlowNode, type WorkflowNodeData } from './WorkflowTaskNode';
import { WorkflowEdge, WORKFLOW_EDGE_MARKERS, type WorkflowFlowEdge } from './WorkflowEdge';

/**
 * The Workflows canvas: React Flow for the interaction layer (pan, zoom, card
 * drag, link drag, selection), our own layout and cards for everything drawn.
 *
 * Every React Flow default the design depends on is pinned here, in one
 * place, with the reason:
 * - Backspace deletes nothing (`deleteKeyCode={null}`): removing goes through
 *   the inspector's buttons and their confirms.
 * - One selected task (`selectionKeyCode`/`multiSelectionKeyCode` null), since
 *   the inspector shows one.
 * - Double-click opens the task, so it does not zoom.
 * - Links are dragged one way, from the blocker's port onto the task that
 *   waits (strict connection mode), never placed by clicking.
 * - No grid snap: a smooth drag matters more than alignment, which Auto layout
 *   gives back.
 * - Scroll pans; Ctrl (Cmd on macOS) with the wheel, or a pinch, zooms.
 * - No attribution: the library is MIT and the project attributes only where
 *   the law requires it.
 */

const NODE_TYPES = { workflowTask: WorkflowTaskNode };
const EDGE_TYPES = { workflowLink: WorkflowEdge };
const PRO_OPTIONS = { hideAttribution: true };
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1 };
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

function sameNodeData(previous: WorkflowNodeData, next: WorkflowNodeData): boolean {
  return previous.viewTask === next.viewTask
    && previous.locked === next.locked
    && previous.canWait === next.canWait
    && previous.canBlock === next.canBlock
    && previous.editable === next.editable
    && previous.waiting?.label === next.waiting?.label
    && previous.waiting?.paused === next.waiting?.paused;
}

/**
 * Every reload derives fresh node objects, so keep the ones nothing changed:
 * React Flow re-renders a node whose object is new, and one moved card would
 * otherwise repaint every card. A node that only moved keeps its `data`, so its
 * card does not re-render either. Each keeps its measured size: a node without
 * one is hidden until React Flow measures it again, which would blink the card.
 */
function reseedNodes(current: WorkflowFlowNode[], derived: WorkflowFlowNode[]): WorkflowFlowNode[] {
  const byId = new Map(current.map((node) => [node.id, node]));
  return derived.map((node) => {
    const previous = byId.get(node.id);
    if (!previous) return node;
    const data = sameNodeData(previous.data, node.data) ? previous.data : node.data;
    const unchanged = data === previous.data
      && previous.selected === node.selected
      && previous.draggable === node.draggable
      && previous.connectable === node.connectable
      && previous.position.x === node.position.x
      && previous.position.y === node.position.y;
    return unchanged ? previous : { ...node, data, measured: previous.measured };
  });
}

interface WorkflowCanvasProps {
  detail: WorkflowDetail;
  selectedTaskKey: string | null;
  /** Cards can be moved and linked (always, in the view; the workflow agent's turn holds linking). */
  editable: boolean;
  /** The workflow agent is working: what would change its plan (a new link) is held. */
  planHeld: boolean;
  onSelectTask: (key: string | null) => void;
  onOpenTask: (key: string) => void;
  onMoveCards: (positions: Array<{ key: string; x: number; y: number }>) => void;
  onLink: (blockerKey: string, blockedKey: string) => void;
}

export function WorkflowCanvas({
  detail,
  selectedTaskKey,
  editable,
  planHeld,
  onSelectTask,
  onOpenTask,
  onMoveCards,
  onLink,
}: WorkflowCanvasProps) {
  const density = useConfigStore((state) => state.config.cardDensity);
  const reactFlow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();

  const layout = useMemo(() => layoutWorkflow(
    detail.tasks.map((task) => ({ key: task.key, height: canvasCardHeight(task, density), canvasX: task.canvasX, canvasY: task.canvasY })),
    detail.links,
  ), [detail.tasks, detail.links, density]);

  const locked = detail.workflow.state === 'running';
  const derivedNodes = useMemo<WorkflowFlowNode[]>(() => detail.tasks.map((task) => ({
    id: task.key,
    type: 'workflowTask',
    position: layout.positions.get(task.key) ?? { x: 0, y: 0 },
    selected: task.key === selectedTaskKey,
    draggable: editable,
    connectable: editable && !planHeld,
    data: {
      viewTask: task,
      locked: locked && task.place !== 'done',
      waiting: waitingOf(detail, task),
      canWait: canWait(task),
      canBlock: canBlock(task),
      editable: editable && !planHeld,
    },
  })), [detail, layout, selectedTaskKey, editable, planHeld, locked]);

  // Controlled nodes: React Flow writes positions during a drag through
  // `onNodesChange`, and the layout re-seeds them whenever the workflow
  // reloads. The re-seed happens during render (React's pattern for state
  // derived from props), so no frame commits with the old nodes.
  const [nodes, setNodes] = useState<WorkflowFlowNode[]>(derivedNodes);
  const [seededFrom, setSeededFrom] = useState(derivedNodes);
  if (seededFrom !== derivedNodes) {
    setSeededFrom(derivedNodes);
    setNodes((current) => reseedNodes(current, derivedNodes));
  }
  const onNodesChange = useCallback((changes: NodeChange<WorkflowFlowNode>[]) => {
    // Selection is ours (one task, mirrored into `selected` above); every other
    // change (position, dimensions) is React Flow's to apply.
    const applicable = changes.filter((change) => change.type !== 'select' && change.type !== 'remove');
    if (applicable.length > 0) setNodes((current) => applyNodeChanges(applicable, current));
  }, []);

  const doneKeys = useMemo(() => new Set(detail.tasks.filter((task) => task.place === 'done').map((task) => task.key)), [detail.tasks]);
  const edges = useMemo<WorkflowFlowEdge[]>(() => layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.blockerKey,
    target: edge.blockedKey,
    type: 'workflowLink',
    selectable: false,
    focusable: false,
    data: {
      waypoints: edge.waypoints,
      sourceOffset: edge.sourceOffset,
      targetOffset: edge.targetOffset,
      satisfied: doneKeys.has(edge.blockerKey),
      emphasized: selectedTaskKey !== null && (edge.blockerKey === selectedTaskKey || edge.blockedKey === selectedTaskKey),
    },
  })), [layout.edges, doneKeys, selectedTaskKey]);

  // Fit every card in view when a workflow opens, and when its card count
  // changes (Add task, the agent's first plan).
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const signature = `${detail.workflow.id}:${detail.tasks.length}`;
    if (fittedFor.current === signature) return;
    fittedFor.current = signature;
    const frame = requestAnimationFrame(() => { void reactFlow.fitView(FIT_VIEW_OPTIONS); });
    return () => cancelAnimationFrame(frame);
  }, [detail.workflow.id, detail.tasks.length, reactFlow]);

  const handleNodeClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>((_event, node) => onSelectTask(node.id), [onSelectTask]);
  const handleNodeDoubleClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>((_event, node) => onOpenTask(node.id), [onOpenTask]);
  const handlePaneClick = useCallback(() => onSelectTask(null), [onSelectTask]);
  const handleDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>((_event, _node, moved) => {
    onMoveCards(moved.map((node) => ({ key: node.id, x: node.position.x, y: node.position.y })));
  }, [onMoveCards]);
  const handleConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target) onLink(connection.source, connection.target);
  }, [onLink]);
  const isValidConnection = useCallback<IsValidConnection<WorkflowFlowEdge>>((connection) => (
    !planHeld && !!connection.source && !!connection.target && linkRefusal(detail, connection.source, connection.target) === null
  ), [detail, planHeld]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Escape returns the inspector to the workflow, as a click on the canvas does.
    if (event.key === 'Escape' && selectedTaskKey !== null) {
      event.stopPropagation();
      onSelectTask(null);
    }
  }, [onSelectTask, selectedTaskKey]);

  return (
    // data-no-dismiss: the pane's grab cursor is an action, so a click on empty
    // canvas must not close a task window (light-dismiss-denylist.md).
    <div className="relative h-full w-full workflow-canvas" data-no-dismiss onKeyDown={handleKeyDown} data-testid="workflow-canvas">
      {WORKFLOW_EDGE_MARKERS}
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={handlePaneClick}
        onNodeDragStop={handleDragStop}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        nodesDraggable={editable}
        nodesConnectable={editable && !planHeld}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        connectOnClick={false}
        connectionMode={ConnectionMode.Strict}
        snapToGrid={false}
        panOnScroll
        zoomOnScroll={false}
        zoomActivationKeyCode={IS_MAC ? 'Meta' : 'Control'}
        minZoom={0.5}
        maxZoom={2}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={PRO_OPTIONS}
        nodeDragThreshold={3}
      >
        {editable && <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--color-edge-input)" />}
      </ReactFlow>
    </div>
  );
}
