import React, { useCallback, useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ListTree, Plus } from 'lucide-react';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useHmrGeneration } from '../../utils/hmr-generation';
import { WorkflowCanvas } from './WorkflowCanvas';

/**
 * The Workflows view: one workflow at a time, its cards on a canvas.
 *
 * Loaded only when the view first opens (`LazyWorkflowsView`), so the board
 * and the web demo pay nothing for React Flow until then.
 */
export function WorkflowsView() {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const detail = useWorkflowStore((state) => state.detail);
  const summaries = useWorkflowStore((state) => state.summaries);
  const selectedTaskKey = useWorkflowStore((state) => state.selectedTaskKey);
  const selectTask = useWorkflowStore((state) => state.selectTask);
  const setPositions = useWorkflowStore((state) => state.setPositions);
  const setLink = useWorkflowStore((state) => state.setLink);
  const createWorkflow = useWorkflowStore((state) => state.createWorkflow);
  // React Flow keeps internal subscription state: re-key its provider on a
  // Fast Refresh, as every DndContext is (hmr-patterns.md, Pattern C).
  const hmrGeneration = useHmrGeneration();

  useEffect(() => {
    void useWorkflowStore.getState().loadWorkflows();
  }, [projectId]);

  const openTask = useCallback((key: string) => {
    const viewTask = useWorkflowStore.getState().detail?.tasks.find((task) => task.key === key);
    if (!viewTask?.task) return;
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

  const moveCards = useCallback((positions: Array<{ key: string; x: number; y: number }>) => {
    void setPositions(positions);
  }, [setPositions]);

  const link = useCallback((blockerKey: string, blockedKey: string) => {
    void setLink(blockerKey, blockedKey, true).then((ok) => {
      if (ok) selectTask(blockedKey);
    });
  }, [setLink, selectTask]);

  if (summaries.length === 0 && !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-faint" data-testid="workflows-empty">
        <ListTree size={28} className="text-fg-disabled" />
        <div className="text-sm text-fg-muted">No workflows yet</div>
        <button
          type="button"
          onClick={() => { void createWorkflow(null); }}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm bg-accent-emphasis text-accent-on hover:bg-accent"
          data-testid="workflows-create-first"
        >
          <Plus size={14} />
          Create your first workflow
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflows-view">
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {detail && (
            <ReactFlowProvider key={hmrGeneration}>
              <WorkflowCanvas
                detail={detail}
                selectedTaskKey={selectedTaskKey}
                editable
                planHeld={false}
                onSelectTask={selectTask}
                onOpenTask={openTask}
                onMoveCards={moveCards}
                onLink={link}
              />
            </ReactFlowProvider>
          )}
        </div>
      </div>
    </div>
  );
}
