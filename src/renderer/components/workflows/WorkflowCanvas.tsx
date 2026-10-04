import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Plus, Scan } from 'lucide-react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Panel,
  ReactFlow,
  applyNodeChanges,
  useConnection,
  useNodesInitialized,
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
import { WorkflowDetailContext } from './workflow-canvas-context';

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
      && previous.hidden === node.hidden
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
  /** Tasks the board's search and filter leave showing; null shows all. A hidden card keeps its place. */
  visibleKeys: ReadonlySet<string> | null;
  /** Add task's refusal (the workflow agent is working), or null while it can add. */
  addTaskRefusal: string | null;
  onAddTask: () => void;
  /** Put every hand-placed card back in the automatic layout. */
  onAutoLayout: () => void;
  /**
   * A card was right-clicked. The view draws the menu, outside React Flow: a
   * fixed menu inside the transformed viewport would land offset.
   */
  onCardContextMenu?: (key: string, position: { x: number; y: number }) => void;
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
  visibleKeys,
  addTaskRefusal,
  onAddTask,
  onAutoLayout,
  onCardContextMenu,
}: WorkflowCanvasProps) {
  const density = useConfigStore((state) => state.config.cardDensity);
  const reactFlow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();
  const linking = useConnection((connection) => connection.inProgress);

  // Once any task is on another board, every card names its board (board 17).
  const acrossBoards = useMemo(() => detail.tasks.some((task) => task.projectId !== detail.homeProjectId), [detail.tasks, detail.homeProjectId]);
  const layout = useMemo(() => layoutWorkflow(
    detail.tasks.map((task) => ({ key: task.key, height: canvasCardHeight(task, density, acrossBoards), canvasX: task.canvasX, canvasY: task.canvasY })),
    detail.links,
  ), [detail.tasks, detail.links, density, acrossBoards]);

  const locked = detail.workflow.state === 'running';
  const derivedNodes = useMemo<WorkflowFlowNode[]>(() => detail.tasks.map((task) => ({
    id: task.key,
    type: 'workflowTask',
    position: layout.positions.get(task.key) ?? { x: 0, y: 0 },
    selected: task.key === selectedTaskKey,
    hidden: visibleKeys !== null && !visibleKeys.has(task.key),
    draggable: editable,
    connectable: editable && !planHeld,
    data: {
      viewTask: task,
      locked: locked && task.place !== 'done',
      waiting: waitingOf(detail, task),
      canWait: canWait(task),
      canBlock: canBlock(task),
      editable: editable && !planHeld,
      projectName: acrossBoards ? detail.projectNames[task.projectId] ?? 'Another project' : null,
    },
  })), [detail, layout, selectedTaskKey, editable, planHeld, locked, visibleKeys, acrossBoards]);

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
    // A link goes with either end the search hides.
    hidden: visibleKeys !== null && (!visibleKeys.has(edge.blockerKey) || !visibleKeys.has(edge.blockedKey)),
    selectable: false,
    focusable: false,
    data: {
      waypoints: edge.waypoints,
      sourceOffset: edge.sourceOffset,
      targetOffset: edge.targetOffset,
      satisfied: doneKeys.has(edge.blockerKey),
      emphasized: selectedTaskKey !== null && (edge.blockerKey === selectedTaskKey || edge.blockedKey === selectedTaskKey),
    },
  })), [layout.edges, doneKeys, selectedTaskKey, visibleKeys]);

  // Fit every card in view when a workflow opens, and when its card count
  // changes (Add task, the agent's first plan). Only once React Flow has
  // measured every card: a fit before that frames the cards against sizes it
  // does not have yet, and left the third card of a three-card workflow
  // under the inspector.
  const nodesInitialized = useNodesInitialized();
  const fitSignature = `${detail.workflow.id}:${detail.tasks.length}`;
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!nodesInitialized || fittedFor.current === fitSignature) return;
    fittedFor.current = fitSignature;
    void reactFlow.fitView(FIT_VIEW_OPTIONS);
  }, [nodesInitialized, fitSignature, reactFlow]);

  const handleNodeClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>((_event, node) => onSelectTask(node.id), [onSelectTask]);
  const handleNodeDoubleClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>((_event, node) => onOpenTask(node.id), [onOpenTask]);
  const handleNodeContextMenu = useCallback<NodeMouseHandler<WorkflowFlowNode>>((event, node) => {
    event.preventDefault();
    onSelectTask(node.id);
    onCardContextMenu?.(node.id, { x: event.clientX, y: event.clientY });
  }, [onSelectTask, onCardContextMenu]);
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
    <div
      className="relative h-full w-full workflow-canvas"
      data-no-dismiss
      // While a link is drawn the cards' full-size targets take the pointer
      // (index.css). One attribute here, so no card re-renders at either end.
      data-linking={linking ? '' : undefined}
      onKeyDown={handleKeyDown}
      data-testid="workflow-canvas"
    >
      {WORKFLOW_EDGE_MARKERS}
      <WorkflowDetailContext.Provider value={detail}>
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeContextMenu={handleNodeContextMenu}
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
        <Panel position="bottom-left">
          <CanvasTools
            moved={detail.tasks.some((task) => task.canvasX !== null || task.canvasY !== null)}
            addTaskRefusal={addTaskRefusal}
            onFitView={() => { void reactFlow.fitView(FIT_VIEW_OPTIONS); }}
            onAddTask={onAddTask}
            onAutoLayout={() => {
              onAutoLayout();
              // The cards move on the next render; fit them once they have.
              requestAnimationFrame(() => requestAnimationFrame(() => { void reactFlow.fitView(FIT_VIEW_OPTIONS); }));
            }}
          />
        </Panel>
      </ReactFlow>
      </WorkflowDetailContext.Provider>
    </div>
  );
}

/**
 * The canvas's own tools, bottom left, always drawn in the same places. Fit
 * view leads in every state: the canvas pans and zooms, and a workflow panned
 * out of sight needs one way back. Add task uses the To Do column's words and
 * opens the same New Task dialog. Auto layout puts hand-placed cards back, and
 * is disabled until a card sits where a hand put it.
 */
function CanvasTools({ moved, addTaskRefusal, onFitView, onAddTask, onAutoLayout }: {
  moved: boolean;
  addTaskRefusal: string | null;
  onFitView: () => void;
  onAddTask: () => void;
  onAutoLayout: () => void;
}) {
  const tool = 'inline-flex items-center gap-2 px-3 py-2 rounded-md border border-edge-input bg-surface-raised shadow-xl text-[13px] text-fg-secondary enabled:hover:text-fg enabled:hover:bg-surface-hover disabled:opacity-45 disabled:cursor-not-allowed transition-colors';
  return (
    <div className="flex gap-2" data-testid="workflow-canvas-tools">
      <button type="button" onClick={onFitView} title="Fit every card in view" className={tool} data-testid="workflow-fit-view">
        <Scan size={14} className="text-fg-muted" />Fit view
      </button>
      <button
        type="button"
        onClick={onAddTask}
        disabled={addTaskRefusal !== null}
        title={addTaskRefusal ?? 'Add a task to this workflow'}
        className={tool}
        data-testid="workflow-add-task"
      >
        <Plus size={14} className="text-fg-muted" />Add task
      </button>
      <button
        type="button"
        onClick={onAutoLayout}
        disabled={!moved}
        title={moved ? 'Put moved cards back in the automatic layout' : 'No card has been moved'}
        className={tool}
        data-testid="workflow-auto-layout"
      >
        <LayoutGrid size={14} className="text-fg-muted" />Auto layout
      </button>
    </div>
  );
}
