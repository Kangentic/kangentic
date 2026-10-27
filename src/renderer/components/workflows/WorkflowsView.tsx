import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Plus } from 'lucide-react';
import type { Task, WorkflowViewTask } from '../../../shared/types';
import { WORKFLOW_REFUSAL_MESSAGES } from '../../../shared/workflow-refusals';
import { translateText } from '../../i18n/translate';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import { openTaskFromNotification } from '../../utils/open-task-from-notification';
import { useHmrGeneration } from '../../utils/hmr-generation';
import { boardTaskFilter, isOpenFilter, matchesBoardTaskFilter } from '../../utils/board-task-filter';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { WorkflowCanvas, type WorkflowCanvasTarget } from './WorkflowCanvas';
import { WorkflowHeader } from './WorkflowHeader';
import { WorkflowInspector } from './WorkflowInspector';
import { DeleteWorkflowDialog, RemoveTaskDialog, RenameWorkflowDialog, StartWorkflowDialog } from './WorkflowDialogs';
import { WorkflowCardMenu } from './WorkflowCardMenu';
import { DeleteTaskDialog } from '../board/DeleteTaskDialog';
import { findTask, firstInRunOrder } from './workflow-graph';
import { NoWorkflowsIllustration } from './NoWorkflowsIllustration';
import {
  useWorkflowAgentWorking,
  workflowAgentPaneDockedMin,
  workflowAgentPaneWidth,
  WorkflowAgentPane,
  WORKFLOW_CANVAS_MIN_WIDTH,
} from './WorkflowAgentPane';

/**
 * The Workflows view: the header (which workflow, its lifecycle, its
 * progress), the canvas, and the inspector beside it, which never closes so
 * the canvas never shifts. The board's search and filter apply here too (the
 * toolbar row drives both): a card that does not match is hidden with its
 * links, and the rest keep their places.
 *
 * Loaded only when the view first opens (`LazyWorkflowsView`), so the board
 * and the web demo pay nothing for React Flow until then.
 */

type ViewDialog =
  | { kind: 'start' }
  | { kind: 'delete' }
  | { kind: 'rename' }
  | { kind: 'remove'; key: string }
  | { kind: 'addTask' }
  | { kind: 'editPlanned'; key: string }
  | { kind: 'deleteTask'; task: Task; projectId: string };

/** A route step toggle the inspector refused, with its reason as the body. */
function refuse(message: string): void {
  useToastStore.getState().addToast({ title: 'Route step refused', message, variant: 'warning' });
}

/** What an empty workflow's canvas walks through, in order (sign-off 10). */
const WELCOME_STEPS = [
  'Tell the workflow agent what to build, and it plans the tasks.',
  'Review the plan, and click a task to change its route or blockers.',
  'Press Start and the tasks run automatically in order until complete.',
] as const;

/**
 * An empty workflow's canvas (sign-off 10): the No workflows drawing, a title,
 * and the three steps from a plan to a run, one line each. No button: Add task
 * stays in the canvas tools. It goes when the first card lands, the same
 * moment that card is selected. It takes no pointer, so a click on the canvas
 * under it still reaches the pane. Static, like the No workflows state.
 */
function EmptyWorkflowWelcome() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="workflow-canvas-welcome">
      {/* A touch above center, as drawn, so the canvas tools below keep their room. */}
      <div className="absolute left-1/2 top-[47%] flex w-max max-w-full -translate-x-1/2 -translate-y-1/2 flex-col items-center px-4">
        <NoWorkflowsIllustration />
        <div className="mt-[18px] text-lg font-semibold text-fg" data-testid="workflow-canvas-welcome-title">Nothing planned yet</div>
        <ol className="mt-3 flex flex-col gap-2">
          {WELCOME_STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-2.5" data-testid="workflow-canvas-welcome-step">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fg-faint/20 text-[11px] font-semibold text-fg-muted">
                {index + 1}
              </span>
              {/* text-sm, ui-conventions.md's floor for an empty state's text. */}
              <span className="text-sm leading-5 text-fg-muted">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** A failed delete from the canvas menu. The task is still there, so a click on the card opens it. */
function reportDeleteFailure(task: Task, taskProjectId: string, error: unknown): void {
  useToastStore.getState().addToast({
    title: "Couldn't delete task",
    message: `"${task.title}": ${asSentence(describeIpcError(error))}`,
    variant: 'warning',
    onOpen: () => openTaskFromNotification(taskProjectId, task.id),
  });
}

/** Delete a workflow task from its canvas menu: as the board card does on its own board, by id elsewhere. */
async function deleteWorkflowTask(task: Task, taskProjectId: string): Promise<void> {
  if (taskProjectId === useProjectStore.getState().currentProject?.id) {
    const session = useSessionStore.getState()._sessionByTaskId.get(task.id);
    if (session) {
      try {
        await useSessionStore.getState().killSession(session.id);
      } catch (error) {
        reportDeleteFailure(task, taskProjectId, error);
        return;
      }
    }
    // The board store reports its own failure.
    await useBoardStore.getState().deleteTask(task.id).catch(() => undefined);
    return;
  }
  try {
    await window.electronAPI.tasks.delete(task.id, taskProjectId);
  } catch (error) {
    reportDeleteFailure(task, taskProjectId, error);
  }
}

export function WorkflowsView() {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const detail = useWorkflowStore((state) => state.detail);
  const summaries = useWorkflowStore((state) => state.summaries);
  const selectedWorkflowId = useWorkflowStore((state) => state.selectedWorkflowId);
  const selectedTaskKey = useWorkflowStore((state) => state.selectedTaskKey);
  const selectWorkflow = useWorkflowStore((state) => state.selectWorkflow);
  const selectTask = useWorkflowStore((state) => state.selectTask);
  const setPositions = useWorkflowStore((state) => state.setPositions);
  const setPositionsIn = useWorkflowStore((state) => state.setPositionsIn);
  const setLink = useWorkflowStore((state) => state.setLink);
  const setRoute = useWorkflowStore((state) => state.setRoute);
  const addTask = useWorkflowStore((state) => state.addTask);
  const updateTask = useWorkflowStore((state) => state.updateTask);
  const removeTask = useWorkflowStore((state) => state.removeTask);
  const createWorkflow = useWorkflowStore((state) => state.createWorkflow);
  const renameWorkflow = useWorkflowStore((state) => state.renameWorkflow);
  const setTaskPlanApproval = useWorkflowStore((state) => state.setTaskPlanApproval);
  const deleteWorkflow = useWorkflowStore((state) => state.deleteWorkflow);
  const startWorkflow = useWorkflowStore((state) => state.startWorkflow);
  const pauseWorkflow = useWorkflowStore((state) => state.pauseWorkflow);
  const resumeWorkflow = useWorkflowStore((state) => state.resumeWorkflow);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const boardTasks = useBoardStore((state) => state.tasks);
  const boardSearchQuery = useBoardStore((state) => state.boardSearchQuery);
  const priorityFilters = useBoardStore((state) => state.priorityFilters);
  const labelFilters = useBoardStore((state) => state.labelFilters);
  const [dialog, setDialog] = useState<ViewDialog | null>(null);
  const [cardMenu, setCardMenu] = useState<{ key: string; position: { x: number; y: number } } | null>(null);
  // React Flow keeps internal subscription state: re-key its provider on a
  // Fast Refresh, as every DndContext is (hmr-patterns.md, Pattern C).
  const hmrGeneration = useHmrGeneration();
  // While the workflow agent is mid-turn, what would change its plan waits (board 2c).
  const planHeld = useWorkflowAgentWorking(selectedWorkflowId);
  const agentPaneWidth = workflowAgentPaneWidth(useConfigStore((state) => state.config.workflows?.agentPaneWidth));
  // The body row's width decides whether the open agent pane takes its own
  // width or floats over the canvas. Only that decision is state, so a window
  // resize re-renders the view when it flips, not at every pixel.
  // The row exists only outside the empty state, so the observer follows it.
  const showsBody = summaries.length > 0 || detail !== null;
  const dockedMin = workflowAgentPaneDockedMin(agentPaneWidth);
  const dockedMinRef = useRef(dockedMin);
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const bodyRowWidthRef = useRef(Number.POSITIVE_INFINITY);
  const [paneFloats, setPaneFloats] = useState(false);
  // A new pane width moves the threshold. Declared first, so the observer's
  // first measure below reads the current one.
  useLayoutEffect(() => {
    dockedMinRef.current = dockedMin;
    setPaneFloats(bodyRowWidthRef.current < dockedMin);
  }, [dockedMin]);
  useLayoutEffect(() => {
    const row = bodyRowRef.current;
    if (!showsBody || !row) return;
    // Measured now as well, so the first frame already has the right layout
    // rather than a docked pane that squeezes the canvas to nothing.
    bodyRowWidthRef.current = row.getBoundingClientRect().width;
    setPaneFloats(bodyRowWidthRef.current < dockedMinRef.current);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      bodyRowWidthRef.current = width;
      setPaneFloats(width < dockedMinRef.current);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [showsBody]);

  useEffect(() => {
    void useWorkflowStore.getState().loadWorkflows();
  }, [projectId]);

  const selected = useMemo(
    () => summaries.find((summary) => summary.workflow.id === selectedWorkflowId) ?? null,
    [summaries, selectedWorkflowId],
  );
  const todoLane = useMemo(() => swimlanes.find((lane) => lane.role === 'todo') ?? null, [swimlanes]);
  const doneColumnColor = useMemo(() => swimlanes.find((lane) => lane.role === 'done')?.color ?? 'var(--color-active)', [swimlanes]);

  // The board's search and filter, by the board's own rule. A card reads the
  // board's live row where the board has it, so it matches on what it shows.
  const taskFilter = useMemo(() => boardTaskFilter(boardSearchQuery, priorityFilters, labelFilters), [boardSearchQuery, priorityFilters, labelFilters]);
  const visibleKeys = useMemo(() => {
    if (!detail || isOpenFilter(taskFilter)) return null;
    const liveById = new Map<string, Task>(boardTasks.map((task) => [task.id, task]));
    const keys = new Set<string>();
    for (const viewTask of detail.tasks) {
      const row = viewTask.task ? liveById.get(viewTask.task.id) ?? viewTask.task : null;
      const matches = matchesBoardTaskFilter(row ?? {
        title: viewTask.title,
        description: viewTask.planned?.description ?? '',
        labels: viewTask.planned?.labels ?? [],
        priority: viewTask.planned?.priority ?? 0,
        display_id: null,
      }, taskFilter);
      if (matches) keys.add(viewTask.key);
    }
    return keys;
  }, [detail, taskFilter, boardTasks]);

  // What the inspector shows on arrival (Final 4). Opening the view, or another
  // workflow, selects the first task in its run order, so the inspector shows a
  // task instead of asking for one. So does losing the selected task to a
  // Remove or a delete, and an empty workflow's first cards landing (the
  // workflow agent's first draft arriving while the user watches, or an Add
  // task). Escape and a click on empty canvas still clear the selection, and
  // nothing selects again until one of those moments comes round. Layout
  // effects, so the run order never paints for a frame first.
  const openedWorkflowId = useRef<string | null>(null);
  // How many tasks the open workflow had when the effect last ran, so the
  // moment it goes from none to some is seen.
  const seenTaskCount = useRef<{ workflowId: string; count: number } | null>(null);
  // The task last selected, until a hand clears the selection: the one to
  // replace if it leaves the workflow.
  const lastSelectedKey = useRef<string | null>(null);
  const selectTaskByHand = useCallback((key: string | null) => {
    if (key === null) lastSelectedKey.current = null;
    selectTask(key);
  }, [selectTask]);
  useLayoutEffect(() => {
    if (selectedTaskKey !== null) lastSelectedKey.current = selectedTaskKey;
  }, [selectedTaskKey]);
  useLayoutEffect(() => {
    if (!detail || detail.workflow.id !== selectedWorkflowId) return;
    // Recorded even while the workflow is empty, so its first cards landing
    // later is not taken for an opening: that moment is its own, below.
    const opening = openedWorkflowId.current !== detail.workflow.id;
    openedWorkflowId.current = detail.workflow.id;
    // Counted before the early returns, so every reload is seen. Only the step
    // from none to some selects: with tasks present, a selection the user
    // cleared stays cleared.
    const seen = seenTaskCount.current;
    const firstCardsLanded = !opening && seen !== null && seen.workflowId === detail.workflow.id
      && seen.count === 0 && detail.tasks.length > 0;
    seenTaskCount.current = { workflowId: detail.workflow.id, count: detail.tasks.length };
    if (selectedTaskKey !== null) return;
    // A Remove clears the selection before the workflow reloads, so this waits
    // until the reloaded workflow no longer holds the task. Picking sooner
    // could pick the task on its way out.
    const lostKey = lastSelectedKey.current;
    const vanished = lostKey !== null && !detail.tasks.some((task) => task.key === lostKey);
    if (!opening && !vanished && !firstCardsLanded) return;
    lastSelectedKey.current = null;
    const first = firstInRunOrder(detail, visibleKeys);
    if (first !== null) selectTask(first);
  }, [detail, selectedWorkflowId, selectedTaskKey, visibleKeys, selectTask]);

  const openTask = useCallback((key: string) => {
    const viewTask = useWorkflowStore.getState().detail?.tasks.find((task) => task.key === key);
    if (!viewTask) return;
    // A task that is still only planned has no task window yet: it opens in
    // the task form, and Save writes into the workflow.
    if (!viewTask.task) {
      if (viewTask.planned) setDialog({ kind: 'editPlanned', key });
      return;
    }
    const taskId = viewTask.task.id;
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (viewTask.projectId === currentProjectId) {
      useSessionStore.getState().setDetailTaskId(taskId, { initialEdit: viewTask.place === 'todo' });
      return;
    }
    // A task on another board opens there, as the Agent Monitor's Open on board does.
    useSessionStore.getState().setPendingOpenTaskId(taskId);
    void useProjectStore.getState().openProject(viewTask.projectId);
  }, []);

  /** Open on board: Board, with the task's window open; on another board, that project first. */
  const openOnBoard = useCallback((viewTask: WorkflowViewTask) => {
    if (!viewTask.task) return;
    const taskId = viewTask.task.id;
    useBoardStore.getState().setActiveView('board');
    if (viewTask.projectId === useProjectStore.getState().currentProject?.id) {
      useSessionStore.getState().setDetailTaskId(taskId);
      return;
    }
    useSessionStore.getState().setPendingOpenTaskId(taskId);
    void useProjectStore.getState().openProject(viewTask.projectId);
  }, []);

  const deleteTask = useCallback((task: Task, taskProjectId: string) => {
    if (useConfigStore.getState().config.skipDeleteConfirm) {
      void deleteWorkflowTask(task, taskProjectId);
      return;
    }
    setDialog({ kind: 'deleteTask', task, projectId: taskProjectId });
  }, []);

  const handleCardContextMenu = useCallback((key: string, position: { x: number; y: number }) => {
    // A planned task is not a board task yet: it has no board menu.
    if (useWorkflowStore.getState().detail?.tasks.find((task) => task.key === key)?.task) setCardMenu({ key, position });
  }, []);

  const moveCards = useCallback((positions: Array<{ key: string; x: number; y: number }>, workflow: WorkflowCanvasTarget) => {
    // Places saved as the canvas leaves a workflow arrive after the switch has
    // selected the next one: they go to their own workflow, and draw nothing.
    const { projectId, selectedWorkflowId } = useWorkflowStore.getState();
    if (workflow.workflowId === selectedWorkflowId && workflow.homeProjectId === projectId) void setPositions(positions);
    else void setPositionsIn(workflow.homeProjectId, workflow.workflowId, positions);
  }, [setPositions, setPositionsIn]);

  const link = useCallback((blockerKey: string, blockedKey: string) => {
    const linkedIn = useWorkflowStore.getState().selectedWorkflowId;
    void setLink(blockerKey, blockedKey, true).then((ok) => {
      // A key names a task only in its own workflow: another one picked while
      // the link was saved keeps its own selection.
      if (ok && useWorkflowStore.getState().selectedWorkflowId === linkedIn) selectTask(blockedKey);
    });
  }, [setLink, selectTask]);

  const setLinkFromInspector = useCallback((blockerKey: string, blockedKey: string, linked: boolean) => {
    void setLink(blockerKey, blockedKey, linked);
  }, [setLink]);

  const setRouteFromInspector = useCallback((key: string, columns: string[]) => {
    void setRoute(key, columns);
  }, [setRoute]);

  const sourceTaskLabel = useMemo(() => {
    const sourceId = selected?.workflow.source_task_id;
    if (!sourceId) return null;
    const source = boardTasks.find((task) => task.id === sourceId);
    // Start moves the source to Done only while it is still in To Do.
    return source && todoLane && source.swimlane_id === todoLane.id ? `#${source.display_id}` : null;
  }, [selected, boardTasks, todoLane]);

  const menuTask = cardMenu ? findTask(detail, cardMenu.key) : null;
  const removing: WorkflowViewTask | null = dialog?.kind === 'remove' ? findTask(detail, dialog.key) : null;
  const editing: WorkflowViewTask | null = dialog?.kind === 'editPlanned' ? findTask(detail, dialog.key) : null;

  const header = (
    <WorkflowHeader
      summaries={summaries}
      selected={selected}
      detail={detail}
      planHeld={planHeld}
      doneColumnColor={doneColumnColor}
      onSelect={(workflowId) => selectWorkflow(workflowId)}
      onRename={() => setDialog({ kind: 'rename' })}
      onStart={() => setDialog({ kind: 'start' })}
      onPause={() => { void pauseWorkflow(); }}
      onResume={() => { void resumeWorkflow(); }}
      onDelete={() => setDialog({ kind: 'delete' })}
      onNew={() => { void createWorkflow(null); }}
    />
  );

  if (summaries.length === 0 && !detail) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="workflows-view">
        {header}
        {/* A small drawing of what a workflow is, one plain line, the button,
            and the other way in (Final 7). Static: nothing here moves. */}
        <div className="flex flex-1 min-h-0 flex-col items-center justify-center px-8 text-center" data-testid="workflows-empty">
          <NoWorkflowsIllustration />
          <div className="mt-[18px] text-lg font-semibold text-fg">No workflows</div>
          <div className="mt-1.5 max-w-[460px] text-sm text-fg-muted" data-testid="workflows-empty-line">
            Linked tasks that run through your board on their own.
          </div>
          <button
            type="button"
            onClick={() => { void createWorkflow(null); }}
            className="mt-[18px] inline-flex h-9 items-center gap-1.5 rounded px-4 text-sm font-medium bg-accent-emphasis text-accent-on hover:bg-accent"
            data-testid="workflows-create-first"
          >
            <Plus size={15} />
            Create your first workflow
          </button>
          <div className="mt-3 text-sm text-fg-faint" data-testid="workflows-empty-hint">
            Or right-click a task and choose New workflow.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflows-view">
      {header}
      <div ref={bodyRowRef} className="flex min-h-0 flex-1">
        {selectedWorkflowId && (
          <WorkflowAgentPane workflowId={selectedWorkflowId} floating={paneFloats} />
        )}
        {/* While the pane is docked the canvas keeps its minimum. A window that
            jumps narrower (a snap, a restore) lays out once with the pane still
            docked before the observer floats it; the row then overflows and
            clips for that frame instead of crushing the canvas to 0, which React
            Flow cannot render. */}
        <div
          className="relative min-w-0 flex-1"
          style={paneFloats ? undefined : { minWidth: WORKFLOW_CANVAS_MIN_WIDTH }}
        >
          {/* The workflow agent is working, said on the canvas as the Agent
              Browser says an agent is driving: an accent ring at the edge and a
              label, both breathing. No veil: cards stay movable, and only what
              would change the plan waits. Always mounted, opacity-toggled. The
              label sits top left, clear of the canvas tools along the bottom
              edge: Add task, bottom right, is disabled exactly while this shows. */}
          <div
            className={`pointer-events-none absolute inset-0 z-10 transition-opacity duration-200 ${planHeld ? 'opacity-100' : 'opacity-0'}`}
            data-testid="workflow-agent-working"
            data-working={planHeld ? 'true' : 'false'}
            aria-hidden={!planHeld}
          >
            <div className={`absolute inset-0 ring-2 ring-inset ring-accent/70 ${planHeld ? 'kng-drive-pulse' : ''}`} />
            <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded bg-surface-raised/95 px-2.5 py-1 text-xs text-fg-secondary shadow" data-testid="workflow-agent-working-label">
              <span className={`h-1.5 w-1.5 rounded-full bg-active ${planHeld ? 'kng-drive-pulse' : ''}`} />
              Workflow agent is working
            </span>
          </div>
          {detail && (
            <ReactFlowProvider key={hmrGeneration}>
              <WorkflowCanvas
                detail={detail}
                selectedTaskKey={selectedTaskKey}
                editable
                planHeld={planHeld}
                onSelectTask={selectTaskByHand}
                onOpenTask={openTask}
                onMoveCards={moveCards}
                onLink={link}
                visibleKeys={visibleKeys}
                addTaskRefusal={planHeld ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : null}
                onAddTask={() => setDialog({ kind: 'addTask' })}
                onAutoLayout={() => { void setPositions(null); }}
                onCardContextMenu={handleCardContextMenu}
                doneColumnColor={doneColumnColor}
              />
            </ReactFlowProvider>
          )}
          {detail && detail.tasks.length === 0 && <EmptyWorkflowWelcome />}
        </div>
        {detail && (
          <WorkflowInspector
            detail={detail}
            selectedTaskKey={selectedTaskKey}
            planHeld={planHeld}
            doneColumnColor={doneColumnColor}
            visibleKeys={visibleKeys}
            onSelectTask={selectTaskByHand}
            onOpenTask={openTask}
            onRequestRemove={(key) => setDialog({ kind: 'remove', key })}
            onSetRoute={setRouteFromInspector}
            onSetLink={setLinkFromInspector}
            onRefuse={refuse}
            onSetTaskPlanApproval={(key, next) => { void setTaskPlanApproval(key, next); }}
          />
        )}
      </div>

      {cardMenu && menuTask?.task && (
        <WorkflowCardMenu
          // Keyed by the card, so a right-click on another card starts its own menu.
          key={menuTask.key}
          viewTask={{ ...menuTask, task: menuTask.task }}
          position={cardMenu.position}
          onClose={() => setCardMenu(null)}
          onOpenOnBoard={openOnBoard}
          onDelete={deleteTask}
        />
      )}
      {dialog?.kind === 'deleteTask' && (
        <DeleteTaskDialog
          title={dialog.task.title}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
            const { task, projectId: taskProjectId } = dialog;
            setDialog(null);
            void deleteWorkflowTask(task, taskProjectId);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'start' && selected && (
        <StartWorkflowDialog
          summary={selected}
          sourceTaskLabel={sourceTaskLabel}
          onConfirm={() => { setDialog(null); void startWorkflow(); }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && selected && (
        <DeleteWorkflowDialog
          summary={selected}
          onConfirm={() => { setDialog(null); void deleteWorkflow(); }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && selected && (
        <RenameWorkflowDialog
          name={selected.workflow.title}
          onRename={(title) => { setDialog(null); void renameWorkflow(title); }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && selected && removing && (
        <RemoveTaskDialog
          workflow={selected.workflow}
          task={removing}
          onConfirm={() => { setDialog(null); void removeTask(removing.key); }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'addTask' && todoLane && (
        <NewTaskDialog
          swimlaneId={todoLane.id}
          onClose={() => setDialog(null)}
          workflow={{ onSubmit: async (input) => (await addTask(input)) !== null }}
        />
      )}
      {dialog?.kind === 'editPlanned' && todoLane && editing?.planned && (
        <NewTaskDialog
          // Keyed by the task, so opening another planned task starts a fresh form.
          key={editing.key}
          swimlaneId={todoLane.id}
          onClose={() => setDialog(null)}
          workflow={{
            title: 'Edit Task',
            submitLabel: 'Save',
            // The planned row itself: its board and run settings open as stored.
            initial: editing.planned,
            onSubmit: (input) => updateTask(editing.key, input),
          }}
        />
      )}
    </div>
  );
}
