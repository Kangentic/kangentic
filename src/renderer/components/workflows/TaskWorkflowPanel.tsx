import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ListTree, X } from 'lucide-react';
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
import { findTask } from './workflow-graph';

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
  const doneColumnColor = useBoardStore((state) => (taskProjectId === boardProjectId
    ? state.swimlanes.find((lane) => lane.role === 'done')?.color
    : undefined)) ?? 'var(--color-active)';
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

  const body = !workflowId || !homeProjectId
    ? <div className="p-4 text-sm text-fg-faint">This task is not in a workflow.</div>
    : !detail
      ? <div className="p-4 text-sm text-fg-faint" data-testid="workflow-panel-loading">Loading...</div>
      : !viewTask
        ? <div className="p-4 text-sm text-fg-faint">This task is no longer in {detail.workflow.title}.</div>
        : (
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
        <ListTree size={15} className="text-fg-muted" />
        Workflow
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workflow panel"
          title="Close"
          className="ml-auto p-1 rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-hover transition-colors"
          data-testid="task-workflow-panel-close"
        >
          <X size={14} />
        </button>
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
