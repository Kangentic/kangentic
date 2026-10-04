import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ListTree, Plus } from 'lucide-react';
import type { Task, WorkflowViewTask } from '../../../shared/types';
import { WORKFLOW_REFUSALS } from '../../../shared/workflow-refusals';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { describeIpcError } from '../../lib/ipc-error';
import { useHmrGeneration } from '../../utils/hmr-generation';
import { boardTaskFilter, isOpenFilter, matchesBoardTaskFilter } from '../../utils/board-task-filter';
import { NewTaskDialog } from '../dialogs/NewTaskDialog';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowHeader } from './WorkflowHeader';
import { WorkflowInspector } from './WorkflowInspector';
import { DeleteWorkflowDialog, RemoveTaskDialog, RenameWorkflowDialog, StartWorkflowDialog } from './WorkflowDialogs';
import { WorkflowCardMenu } from './WorkflowCardMenu';
import { DeleteTaskDialog } from '../board/DeleteTaskDialog';
import { findTask } from './workflow-graph';
import { useWorkflowAgentWorking, WORKFLOW_AGENT_PANE_DOCKED_MIN, WorkflowAgentPane } from './WorkflowAgentPane';

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

function refuse(message: string): void {
  useToastStore.getState().addToast({ message, variant: 'warning' });
}

/** Delete a workflow task from its canvas menu: as the board card does on its own board, by id elsewhere. */
async function deleteWorkflowTask(task: Task, taskProjectId: string): Promise<void> {
  if (taskProjectId === useProjectStore.getState().currentProject?.id) {
    const session = useSessionStore.getState()._sessionByTaskId.get(task.id);
    if (session) await useSessionStore.getState().killSession(session.id);
    // The board store reports its own failure.
    await useBoardStore.getState().deleteTask(task.id).catch(() => undefined);
    return;
  }
  try {
    await window.electronAPI.tasks.delete(task.id, taskProjectId);
  } catch (error) {
    useToastStore.getState().addToast({ message: `Failed to delete "${task.title}": ${describeIpcError(error)}`, variant: 'warning' });
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
  const setLink = useWorkflowStore((state) => state.setLink);
  const setRoute = useWorkflowStore((state) => state.setRoute);
  const addTask = useWorkflowStore((state) => state.addTask);
  const updateTask = useWorkflowStore((state) => state.updateTask);
  const removeTask = useWorkflowStore((state) => state.removeTask);
  const createWorkflow = useWorkflowStore((state) => state.createWorkflow);
  const renameWorkflow = useWorkflowStore((state) => state.renameWorkflow);
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
  // The body row's width decides whether the open agent pane takes its own
  // width or floats over the canvas.
  // The row exists only outside the empty state, so the observer follows it.
  const showsBody = summaries.length > 0 || detail !== null;
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [bodyRowWidth, setBodyRowWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const row = bodyRowRef.current;
    if (!showsBody || !row) return;
    // Measured now as well, so the first frame already has the right layout
    // rather than a docked pane that squeezes the canvas to nothing.
    setBodyRowWidth(row.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setBodyRowWidth(width);
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

  const moveCards = useCallback((positions: Array<{ key: string; x: number; y: number }>) => {
    void setPositions(positions);
  }, [setPositions]);

  const link = useCallback((blockerKey: string, blockedKey: string) => {
    void setLink(blockerKey, blockedKey, true).then((ok) => {
      if (ok) selectTask(blockedKey);
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
        <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-4 px-8 text-fg-faint" data-testid="workflows-empty">
          <ListTree size={48} strokeWidth={1} />
          <div className="text-center">
            <div className="text-lg font-medium text-fg-muted">No workflows</div>
            <div className="mt-1 text-sm">Plan linked tasks with an agent, or start from a To Do task on the board</div>
          </div>
          <button
            type="button"
            onClick={() => { void createWorkflow(null); }}
            className="mt-2 inline-flex items-center gap-1.5 rounded px-4 py-1.5 text-sm font-medium bg-accent-emphasis text-accent-on hover:bg-accent"
            data-testid="workflows-create-first"
          >
            <Plus size={14} />
            Create your first workflow
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflows-view">
      {header}
      <div ref={bodyRowRef} className="flex min-h-0 flex-1">
        {selectedWorkflowId && (
          <WorkflowAgentPane workflowId={selectedWorkflowId} floating={bodyRowWidth < WORKFLOW_AGENT_PANE_DOCKED_MIN} />
        )}
        <div className="relative min-w-0 flex-1">
          {/* The workflow agent is working, said on the canvas as the Agent
              Browser says an agent is driving: an accent ring at the edge and a
              label, both breathing. No veil: cards stay movable, and only what
              would change the plan waits. Always mounted, opacity-toggled. */}
          <div
            className={`pointer-events-none absolute inset-0 z-10 transition-opacity duration-200 ${planHeld ? 'opacity-100' : 'opacity-0'}`}
            data-testid="workflow-agent-working"
            data-working={planHeld ? 'true' : 'false'}
            aria-hidden={!planHeld}
          >
            <div className={`absolute inset-0 ring-2 ring-inset ring-accent/70 ${planHeld ? 'kng-drive-pulse' : ''}`} />
            <span className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded bg-surface-raised/95 px-2.5 py-1 text-xs text-fg-secondary shadow">
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
                onSelectTask={selectTask}
                onOpenTask={openTask}
                onMoveCards={moveCards}
                onLink={link}
                visibleKeys={visibleKeys}
                addTaskRefusal={planHeld ? WORKFLOW_REFUSALS.agentWorking : null}
                onAddTask={() => setDialog({ kind: 'addTask' })}
                onAutoLayout={() => { void setPositions(null); }}
                onCardContextMenu={handleCardContextMenu}
              />
            </ReactFlowProvider>
          )}
        </div>
        {detail && (
          <WorkflowInspector
            detail={detail}
            selectedTaskKey={selectedTaskKey}
            planHeld={planHeld}
            doneColumnColor={doneColumnColor}
            visibleKeys={visibleKeys}
            onSelectTask={selectTask}
            onOpenTask={openTask}
            onRequestRemove={(key) => setDialog({ kind: 'remove', key })}
            onSetRoute={setRouteFromInspector}
            onSetLink={setLinkFromInspector}
            onRefuse={refuse}
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
            initial: {
              title: editing.planned.title,
              description: editing.planned.description,
              labels: editing.planned.labels,
              priority: editing.planned.priority,
            },
            onSubmit: (input) => updateTask(editing.key, input),
          }}
        />
      )}
    </div>
  );
}
