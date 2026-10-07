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
import type { WorkflowBoardTask, WorkflowDetail } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { isWorkflowTaskLocked } from '../../utils/board-workflow';
import { layoutWorkflow } from './workflow-layout';
import { canBlock, canWait, findTask, linkRefusal, otherBoardDoneColor, taskLabel, waitingOf } from './workflow-graph';
import { NO_MEASURED_HEIGHTS, estimatedCardHeight, withMeasuredHeights } from './canvas-card-heights';
import { LINK_HINT_CLASS, WorkflowTaskNode, type WorkflowFlowNode, type WorkflowNodeData } from './WorkflowTaskNode';
import { WorkflowConnectionLine, WorkflowEdge, WORKFLOW_EDGE_MARKERS, type WorkflowFlowEdge } from './WorkflowEdge';
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
 * - Double-click selects the task and opens it, so it does not zoom.
 * - Links are dragged one way, from the blocker's port onto the task that
 *   waits (strict connection mode), never placed by clicking.
 * - No grid snap: a smooth drag matters more than alignment, which Auto layout
 *   gives back.
 * - Arrow keys move the selected card (React Flow's keyboard access, 5px a
 *   press, 20px with Shift), saved like a drag once the keys stop.
 * - Scroll pans; Ctrl (Cmd on macOS) with the wheel, or a pinch, zooms.
 * - No attribution: the library is MIT and the project attributes only where
 *   the law requires it.
 */

const NODE_TYPES = { workflowTask: WorkflowTaskNode };
const EDGE_TYPES = { workflowLink: WorkflowEdge };
const PRO_OPTIONS = { hideAttribution: true };
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1 };
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** How long the arrow keys rest before the card's new place is saved: one save per run of presses. */
const KEY_MOVE_SAVE_DELAY_MS = 400;
/** The empty-canvas hint's offset from the pointer, clear of the cursor (board 10). */
const POINTER_HINT_OFFSET = { x: 22, y: 16 };

function sameNodeData(previous: WorkflowNodeData, next: WorkflowNodeData): boolean {
  return previous.viewTask === next.viewTask
    && previous.locked === next.locked
    && previous.canWait === next.canWait
    && previous.canBlock === next.canBlock
    && previous.editable === next.editable
    && previous.doneColor === next.doneColor
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
  /**
   * The home board's Done column color (the open board: a workflow opens on
   * its home), which a Done card's border wears (Final 1). Set once on the
   * canvas as a CSS variable, so a recolored column repaints the cards without
   * re-rendering one. A card on another board sets the variable to that
   * board's color itself (`otherBoardDoneColor`).
   */
  doneColumnColor: string;
  /**
   * Each started task's board facts, from the workflow's summary (null until
   * it loads). The lock follows the board's rule from them: none while a task
   * sits in a human gate, where a person drags it on.
   */
  boardFacts: Readonly<Record<string, WorkflowBoardTask>> | null;
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
  doneColumnColor,
  boardFacts,
}: WorkflowCanvasProps) {
  const density = useConfigStore((state) => state.config.cardDensity);
  const reactFlow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();
  // The blocker a link is being drawn from, or null. Changes at the two ends of the gesture only.
  const linkingFrom = useConnection((connection) => (connection.inProgress ? connection.fromNode.id : null));

  // Each card's height as React Flow measured it: a card is as tall as its
  // content, so the layout stacks a column from these and re-spaces it when a
  // card grows (canvas-card-heights.ts). The ref holds what React Flow last
  // reported; the state is what the layout uses. They differ only while a card
  // is dragged: the layout waits for the drop, so a card that grows mid-drag
  // never pulls the dragged card back to its slot. An entry from another
  // workflow never misleads, since React Flow reports any card whose size
  // differs from it.
  const measuredHeights = useRef<ReadonlyMap<string, number>>(NO_MEASURED_HEIGHTS);
  const dragging = useRef(false);
  const [layoutHeights, setLayoutHeights] = useState<ReadonlyMap<string, number>>(NO_MEASURED_HEIGHTS);

  const layout = useMemo(() => layoutWorkflow(
    detail.tasks.map((task) => ({
      key: task.key,
      height: layoutHeights.get(task.key) ?? estimatedCardHeight(task, density),
      canvasX: task.canvasX,
      canvasY: task.canvasY,
    })),
    detail.links,
  ), [detail.tasks, detail.links, density, layoutHeights]);

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
      locked: task.place !== 'done'
        && isWorkflowTaskLocked(detail.workflow.state, (task.task ? boardFacts?.[task.task.id]?.humanGateTargetId : null) ?? null),
      waiting: waitingOf(detail, task),
      canWait: canWait(task),
      canBlock: canBlock(task),
      editable: editable && !planHeld,
      // Every card names its project, on one board or several, so a card has
      // one shape whatever the workflow spans (sign-off 4b).
      projectName: detail.projectNames[task.projectId] ?? 'Another project',
      doneColor: otherBoardDoneColor(detail, task),
    },
  })), [detail, layout, selectedTaskKey, editable, planHeld, boardFacts, visibleKeys]);

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
    // A height the layout has not seen yet lays the cards out again, once no
    // card is being dragged. A drag's position changes leave the map as it
    // was, so they never do.
    const measured = withMeasuredHeights(measuredHeights.current, changes);
    if (measured === measuredHeights.current) return;
    measuredHeights.current = measured;
    if (!dragging.current) setLayoutHeights(measured);
  }, []);

  // The link a drag just made stays in the accent until the selection moves
  // on. Linking itself selects the task that now waits once main accepts the
  // link, which is not moving on, so only a selection of another task (or of
  // none) clears it. Derived during render, as the node re-seed above is.
  const [freshLink, setFreshLink] = useState<{ blockerKey: string; blockedKey: string } | null>(null);
  const [selectionSeen, setSelectionSeen] = useState(selectedTaskKey);
  if (selectionSeen !== selectedTaskKey) {
    setSelectionSeen(selectedTaskKey);
    if (freshLink !== null && selectedTaskKey !== freshLink.blockedKey) setFreshLink(null);
  }

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
      fresh: freshLink !== null && edge.blockerKey === freshLink.blockerKey && edge.blockedKey === freshLink.blockedKey,
    },
  })), [layout.edges, doneKeys, selectedTaskKey, visibleKeys, freshLink]);

  // While a link is drawn, only the tasks that can take it keep their
  // incoming port (board 10b). index.css hides every port during the drag;
  // this one rule shows the targets' again. A rule rather than a prop, so
  // starting a link re-renders no card.
  const linkTargetsRule = useMemo(() => {
    if (linkingFrom === null) return null;
    const selectors = detail.tasks
      .filter((task) => task.key !== linkingFrom && linkRefusal(detail, linkingFrom, task.key) === null)
      .map((task) => `.workflow-canvas[data-linking] .react-flow__node[data-id="${CSS.escape(task.key)}"] .workflow-port-in`);
    return selectors.length > 0 ? `${selectors.join(',\n')} { visibility: visible; }` : null;
  }, [detail, linkingFrom]);

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
  // A double-click's first click already selects; selecting here as well keeps
  // the two together whatever reaches the handler first.
  const handleNodeDoubleClick = useCallback<NodeMouseHandler<WorkflowFlowNode>>((_event, node) => {
    onSelectTask(node.id);
    onOpenTask(node.id);
  }, [onSelectTask, onOpenTask]);
  const handleNodeContextMenu = useCallback<NodeMouseHandler<WorkflowFlowNode>>((event, node) => {
    event.preventDefault();
    onSelectTask(node.id);
    onCardContextMenu?.(node.id, { x: event.clientX, y: event.clientY });
  }, [onSelectTask, onCardContextMenu]);
  const handlePaneClick = useCallback(() => onSelectTask(null), [onSelectTask]);

  // A card moved with the arrow keys is saved the way a drag stop saves it,
  // once the keys rest. Each waiting place is kept per card, with the workflow
  // it was made on: another workflow on the canvas drops them, leaving the view
  // saves them, and a drag or Auto layout supersedes them.
  const pendingKeyMoves = useRef<{ workflowId: string; positions: Map<string, { x: number; y: number }>; timer: number } | null>(null);
  const onMoveCardsRef = useRef(onMoveCards);
  useEffect(() => { onMoveCardsRef.current = onMoveCards; }, [onMoveCards]);
  const takeKeyMoves = useCallback((): Map<string, { x: number; y: number }> => {
    const pending = pendingKeyMoves.current;
    pendingKeyMoves.current = null;
    if (!pending) return new Map();
    window.clearTimeout(pending.timer);
    return pending.positions;
  }, []);
  const saveKeyMoves = useCallback(() => {
    const positions = takeKeyMoves();
    if (positions.size > 0) onMoveCardsRef.current([...positions].map(([key, position]) => ({ key, ...position })));
  }, [takeKeyMoves]);
  const workflowId = detail.workflow.id;
  useEffect(() => {
    if (pendingKeyMoves.current !== null && pendingKeyMoves.current.workflowId !== workflowId) takeKeyMoves();
  }, [workflowId, takeKeyMoves]);
  useEffect(() => saveKeyMoves, [saveKeyMoves]);

  const handleDragStart = useCallback<OnNodeDrag<WorkflowFlowNode>>(() => { dragging.current = true; }, []);
  const handleDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>((_event, _node, moved) => {
    // A card that changed height during the drag is laid out now.
    dragging.current = false;
    setLayoutHeights(measuredHeights.current);
    // One save: any arrow-key place still waiting, then the drag's own places over it.
    const positions = takeKeyMoves();
    for (const node of moved) positions.set(node.id, { x: node.position.x, y: node.position.y });
    onMoveCards([...positions].map(([key, position]) => ({ key, ...position })));
  }, [onMoveCards, takeKeyMoves]);
  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setFreshLink({ blockerKey: connection.source, blockedKey: connection.target });
    onLink(connection.source, connection.target);
  }, [onLink]);
  const isValidConnection = useCallback<IsValidConnection<WorkflowFlowEdge>>((connection) => (
    !planHeld && !!connection.source && !!connection.target && linkRefusal(detail, connection.source, connection.target) === null
  ), [detail, planHeld]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Escape returns the inspector to the workflow, as a click on the canvas does.
    if (event.key === 'Escape' && selectedTaskKey !== null) {
      event.stopPropagation();
      onSelectTask(null);
      return;
    }
    // React Flow's node handler runs first and claims an arrow key only when
    // it moved the selected card, so a claimed key is a move to keep.
    const fromCard = event.target instanceof Element && event.target.closest('.react-flow__node') !== null;
    if (!ARROW_KEYS.has(event.key) || !event.isDefaultPrevented() || !fromCard || selectedTaskKey === null) return;
    const node = reactFlow.getInternalNode(selectedTaskKey);
    if (!node) return;
    const pending = pendingKeyMoves.current;
    if (pending) window.clearTimeout(pending.timer);
    const positions = pending?.positions ?? new Map<string, { x: number; y: number }>();
    positions.set(selectedTaskKey, { x: node.position.x, y: node.position.y });
    pendingKeyMoves.current = { workflowId, positions, timer: window.setTimeout(saveKeyMoves, KEY_MOVE_SAVE_DELAY_MS) };
  }, [onSelectTask, selectedTaskKey, reactFlow, workflowId, saveKeyMoves]);

  return (
    // data-no-dismiss: the pane's grab cursor is an action, so a click on empty
    // canvas must not close a task window (light-dismiss-denylist.md).
    <div
      className="relative h-full w-full workflow-canvas"
      data-no-dismiss
      // While a link is drawn the cards' full-size targets take the pointer
      // and the ports hide (index.css). One attribute here, so no card
      // re-renders at either end.
      data-linking={linkingFrom !== null ? '' : undefined}
      onKeyDown={handleKeyDown}
      style={{ '--workflow-done-color': doneColumnColor } as React.CSSProperties}
      data-testid="workflow-canvas"
    >
      {WORKFLOW_EDGE_MARKERS}
      {linkTargetsRule !== null && <style>{linkTargetsRule}</style>}
      <WorkflowDetailContext.Provider value={detail}>
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        connectionLineComponent={WorkflowConnectionLine}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        onNodeDragStart={handleDragStart}
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
          <ViewTools
            moved={detail.tasks.some((task) => task.canvasX !== null || task.canvasY !== null)}
            onFitView={() => { void reactFlow.fitView(FIT_VIEW_OPTIONS); }}
            onAutoLayout={() => {
              // Auto layout puts every card back, so an arrow-key place still waiting must not land after it.
              takeKeyMoves();
              onAutoLayout();
              // The cards move on the next render; fit them once they have.
              requestAnimationFrame(() => requestAnimationFrame(() => { void reactFlow.fitView(FIT_VIEW_OPTIONS); }));
            }}
          />
        </Panel>
        <Panel position="bottom-center">
          <AddTaskTool addTaskRefusal={addTaskRefusal} onAddTask={onAddTask} />
        </Panel>
      </ReactFlow>
      </WorkflowDetailContext.Provider>
      <LinkPointerHint detail={detail} />
    </div>
  );
}

/**
 * Beside the pointer while a link is drawn over empty canvas (board 10): what
 * a release on a task would do. Over a task the card itself says it, so this
 * one shows only where no card speaks: on empty canvas, back over the blocker,
 * or over a port that is no drop target. It follows the pointer, so it
 * re-renders on every move; it is the only thing that does.
 */
function LinkPointerHint({ detail }: { detail: WorkflowDetail }) {
  const drag = useConnection((connection) => (
    connection.inProgress
      ? {
        blockerKey: connection.fromNode.id,
        overKey: connection.toNode?.id ?? null,
        valid: connection.isValid === true,
        x: connection.pointer.x,
        y: connection.pointer.y,
      }
      : null
  ));
  if (drag === null) return null;
  const blocker = findTask(detail, drag.blockerKey);
  if (!blocker) return null;
  const cardSpeaks = drag.overKey !== null
    && drag.overKey !== drag.blockerKey
    && (drag.valid || linkRefusal(detail, drag.blockerKey, drag.overKey) !== null);
  if (cardSpeaks) return null;
  return (
    <div
      className={`${LINK_HINT_CLASS} absolute z-20`}
      style={{ left: drag.x + POINTER_HINT_OFFSET.x, top: drag.y + POINTER_HINT_OFFSET.y }}
      data-testid="workflow-link-canvas-hint"
    >
      Release on a task to make it wait for {taskLabel(blocker)}
    </div>
  );
}

const CANVAS_TOOL_CLASS = 'inline-flex items-center gap-2 px-3 py-2 rounded-md border border-edge-input bg-surface-raised shadow-xl text-[13px] text-fg-secondary enabled:hover:text-fg enabled:hover:bg-surface-hover disabled:opacity-45 disabled:cursor-not-allowed transition-colors';

/**
 * The canvas's view tools, bottom left, side by side: both arrange what is
 * already on the canvas. Fit view leads in every state: the canvas pans and
 * zooms, and a workflow panned out of sight needs one way back. Auto layout
 * puts hand-placed cards back, and is disabled until a card sits where a hand
 * put it.
 */
function ViewTools({ moved, onFitView, onAutoLayout }: {
  moved: boolean;
  onFitView: () => void;
  onAutoLayout: () => void;
}) {
  const tool = CANVAS_TOOL_CLASS;
  return (
    <div className="flex gap-2" data-testid="workflow-canvas-tools">
      <button type="button" onClick={onFitView} title="Fit every card in view" className={tool} data-testid="workflow-fit-view">
        <Scan size={14} className="text-fg-muted" />Fit view
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

/**
 * Add task, bottom center, apart from the view tools: it changes the plan
 * where they only arrange it. It uses the To Do column's words and opens the
 * same New Task dialog, and waits, with the reason, while the workflow agent
 * works.
 */
function AddTaskTool({ addTaskRefusal, onAddTask }: { addTaskRefusal: string | null; onAddTask: () => void }) {
  return (
    <button
      type="button"
      onClick={onAddTask}
      disabled={addTaskRefusal !== null}
      title={addTaskRefusal ?? 'Add a task to this workflow'}
      className={CANVAS_TOOL_CLASS}
      data-testid="workflow-add-task"
    >
      <Plus size={14} className="text-fg-muted" />Add task
    </button>
  );
}
