import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Workflow as WorkflowIcon, X } from 'lucide-react';
import type { Task } from '../../../shared/types';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { WorkflowInspector } from './WorkflowInspector';
import { RemoveTaskDialog } from './WorkflowDialogs';
import { DONE_COLOR_FALLBACK, findTask } from './workflow-graph';
import { Tooltip } from '../Tooltip';

/**
 * Task detail's workflow panel (#732 board 9): the Workflows inspector itself,
 * for this task, so its route switches, link X, Add blocker and Remove carry
 * the same guards in both places. It acts on the task's OWN workflow, by its
 * home project and id, whatever the Workflows view has selected.
 *
 * Free of the canvas library: task detail loads it with the window.
 */

export const TASK_WORKFLOW_PANEL_WIDTH = 400;

interface TaskWorkflowPanelProps {
  task: Task;
  /** The project whose board the task is on (the window's host project). */
  taskProjectId: string | null;
  onClose: () => void;
}

export function TaskWorkflowPanel({ task, taskProjectId, onClose }: TaskWorkflowPanelProps) {
  const workflowId = task.workflow_id;
  const homeProjectId = task.workflow_project_id ?? taskProjectId;
  const watched = useWorkflowStore((state) => (workflowId ? state.watchedDetails[workflowId] : undefined));
  const detail = watched?.detail ?? null;
  const boardProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // The workflow's home board's Done color, which the inspector's rail ends
  // in: live from the board store when that board is open, else as the
  // workflow read it. A task on yet another board wears its own board's.
  const openBoardDoneColor = useBoardStore((state) => (homeProjectId === boardProjectId
    ? state.swimlanes.find((lane) => lane.role === 'done')?.color
    : undefined));
  const doneColumnColor = openBoardDoneColor
    ?? (homeProjectId ? detail?.boardEnds[homeProjectId]?.done?.color : null)
    ?? DONE_COLOR_FALLBACK;
  const [removing, setRemoving] = useState(false);
  const inPopOut = !!window.electronAPI.popOut?.descriptor;

  useEffect(() => {
    if (!workflowId || !homeProjectId) return undefined;
    return useWorkflowStore.getState().watchDetail(homeProjectId, workflowId);
  }, [workflowId, homeProjectId]);

  const viewTask = useMemo(() => findTask(detail, task.id), [detail, task.id]);

  /** A linked task opens in its own window, on its own board. */
  const openLinked = useCallback((key: string | null) => {
    if (!key || key === task.id || !detail) return;
    const linked = findTask(detail, key);
    if (!linked?.task) return;
    if (linked.projectId === useProjectStore.getState().currentProject?.id) {
      useSessionStore.getState().setDetailTaskId(linked.task.id);
      return;
    }
    useSessionStore.getState().setPendingOpenTaskId(linked.task.id);
    void useProjectStore.getState().openProject(linked.projectId);
  }, [detail, task.id]);

  let body: React.ReactNode;
  if (!workflowId || !homeProjectId) {
    body = <div className="p-4 text-sm text-fg-faint">This task is not in a workflow.</div>;
  } else if (watched?.readFailure === 'gone') {
    body = <div className="p-4 text-sm text-fg-faint" data-testid="workflow-panel-gone">The workflow this task was in no longer exists.</div>;
  } else if (!detail && watched?.readFailure === 'unreadable') {
    // A read that failed for another reason keeps the last detail it had; only
    // a panel with none says so, and the next change push reads again.
    body = <div className="p-4 text-sm text-fg-faint" data-testid="workflow-panel-unreadable">The workflow this task is in could not be loaded.</div>;
  } else if (!detail) {
    body = <div className="p-4 text-sm text-fg-faint" data-testid="workflow-panel-loading">Loading...</div>;
  } else if (!viewTask) {
    body = <div className="p-4 text-sm text-fg-faint">This task is no longer in {detail.workflow.title}.</div>;
  } else {
    body = (
      <WorkflowInspector
        detail={detail}
        selectedTaskKey={viewTask.key}
        planHeld={false}
        doneColumnColor={doneColumnColor}
        visibleKeys={null}
        variant="taskDetail"
        onSelectTask={openLinked}
        onOpenTask={openLinked}
        onRequestRemove={() => setRemoving(true)}
        onSetRoute={(key, columns) => { void useWorkflowStore.getState().setRouteIn(homeProjectId, workflowId, key, columns); }}
        onSetLink={(blockerKey, blockedKey, linked) => { void useWorkflowStore.getState().setLinkIn(homeProjectId, workflowId, blockerKey, blockedKey, linked); }}
        onRefuse={(message) => useToastStore.getState().addToast({ message, variant: 'warning' })}
        // A popped-out window (the Agent Monitor's) has no Workflows view of its own.
        onOpenWorkflow={inPopOut ? undefined : () => {
          // Task detail is also hosted over the Agent Monitor, the Knowledge Graph
          // and Stats; the view switches underneath them, so they make way first.
          if (useMonitorStore.getState().monitorOpen) useMonitorStore.getState().close();
          if (useKnowledgeGraphStore.getState().graphOpen) useKnowledgeGraphStore.getState().close();
          if (useUsageDashboardStore.getState().statsOpen) useUsageDashboardStore.getState().close();
          useBoardStore.getState().setActiveView('workflows');
          useWorkflowStore.getState().openWorkflow(homeProjectId, workflowId, task.id);
        }}
      />
    );
  }

  return (
    <div
      className="shrink-0 min-h-0 flex flex-col border-l border-edge bg-surface-raised overflow-hidden"
      style={{ width: TASK_WORKFLOW_PANEL_WIDTH }}
      data-testid="task-workflow-panel"
    >
      <div
        className="flex items-center gap-2 h-10 shrink-0 px-4 border-b border-edge text-[13px] font-semibold text-fg-secondary"
        data-testid="task-workflow-panel-header"
      >
        <WorkflowIcon size={15} className="text-fg-muted" />
        Workflow
        <Tooltip label="Close workflow panel">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close workflow panel"
            className="ml-auto p-1 rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-hover transition-colors"
            data-testid="task-workflow-panel-close"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{body}</div>
      {removing && detail && viewTask && homeProjectId && workflowId && (
        <RemoveTaskDialog
          workflow={detail.workflow}
          task={viewTask}
          onConfirm={() => {
            setRemoving(false);
            void useWorkflowStore.getState().removeTaskIn(homeProjectId, workflowId, viewTask.key);
          }}
          onCancel={() => setRemoving(false)}
        />
      )}
    </div>
  );
}
