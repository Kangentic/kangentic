import { create } from 'zustand';
import type {
  Workflow,
  WorkflowCanvasPosition,
  WorkflowChangedEvent,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowTaskInput,
} from '../../shared/types';
import { describeIpcError } from '../lib/ipc-error';
import { useProjectStore } from './project-store';
import { useToastStore } from './toast-store';

/**
 * The Workflows view's state: the project's unfinished workflows (the picker,
 * and the count on the view's segment), the one on screen, and the selected
 * task. Main is the truth; every change comes back as a `workflow:changed`
 * push, whoever made it, and the store reloads only the workflow it names. It
 * never refetches on board churn (activity, PR refresh): the canvas cards read
 * their live session data from the session store, as board cards do.
 *
 * Card positions are the one optimistic write: a dragged card must stay where
 * it was dropped while the write round-trips.
 */
interface WorkflowStore {
  /** The project `summaries` belongs to. */
  projectId: string | null;
  summaries: WorkflowSummary[];
  selectedWorkflowId: string | null;
  detail: WorkflowDetail | null;
  /** The task the inspector shows, by view key; null shows the run order. */
  selectedTaskKey: string | null;

  loadWorkflows: () => Promise<void>;
  selectWorkflow: (workflowId: string | null, taskKey?: string | null) => void;
  selectTask: (taskKey: string | null) => void;
  loadDetail: () => Promise<void>;
  handleChanged: (event: WorkflowChangedEvent) => void;

  createWorkflow: (sourceTaskId: string | null) => Promise<Workflow | null>;
  renameWorkflow: (title: string) => Promise<boolean>;
  deleteWorkflow: () => Promise<boolean>;
  startWorkflow: () => Promise<boolean>;
  pauseWorkflow: () => Promise<boolean>;
  resumeWorkflow: () => Promise<boolean>;
  addTask: (input: WorkflowTaskInput) => Promise<string | null>;
  updateTask: (key: string, input: Partial<WorkflowTaskInput>) => Promise<boolean>;
  removeTask: (key: string) => Promise<boolean>;
  setLink: (blockerKey: string, blockedKey: string, linked: boolean) => Promise<boolean>;
  setRoute: (key: string, swimlaneIds: string[]) => Promise<boolean>;
  setPositions: (positions: WorkflowCanvasPosition[] | null) => Promise<boolean>;
}

/** Bumped per detail request, so a slow answer cannot overwrite a newer one. */
let detailGeneration = 0; // hmr-safe: a reset generation only discards in-flight answers, and the store reloads on HMR (App.tsx).
/** The same, for the picker list. */
let listGeneration = 0; // hmr-safe: as above.

function currentProjectId(): string | null {
  return useProjectStore.getState().currentProject?.id ?? null;
}

function reportFailure(action: string, error: unknown): void {
  useToastStore.getState().addToast({ message: `${action}. ${describeIpcError(error)}`, variant: 'error' });
}

/**
 * Keep every task and link object a reload did not change, so the canvas
 * re-renders only the cards that did. Every push reloads the whole workflow,
 * and without this one moved card repaints all 100 (measured with
 * `scripts/drag-perf-rig.mjs`, W100). A JSON compare costs about a
 * millisecond for 100 tasks, once per reload.
 */
export function shareUnchanged(previous: WorkflowDetail | null, next: WorkflowDetail): WorkflowDetail {
  if (!previous || previous.workflow.id !== next.workflow.id) return next;
  const previousTasks = new Map(previous.tasks.map((task) => [task.key, task]));
  const tasks = next.tasks.map((task) => {
    const before = previousTasks.get(task.key);
    return before && JSON.stringify(before) === JSON.stringify(task) ? before : task;
  });
  const sameTasks = tasks.length === previous.tasks.length && tasks.every((task, index) => task === previous.tasks[index]);
  const sameLinks = JSON.stringify(previous.links) === JSON.stringify(next.links);
  return {
    ...next,
    tasks: sameTasks ? previous.tasks : tasks,
    links: sameLinks ? previous.links : next.links,
  };
}

const createWorkflowStore = () => create<WorkflowStore>((set, get) => {
  /**
   * Run one change against the workflow on screen. `projectId` is read when the
   * user acted, never after the await, so a project switch mid-call cannot aim
   * it elsewhere.
   */
  async function onSelected<Result>(
    failure: string,
    run: (projectId: string, workflowId: string) => Promise<Result>,
  ): Promise<{ ok: true; value: Result } | { ok: false }> {
    const { projectId, selectedWorkflowId } = get();
    if (!projectId || !selectedWorkflowId) return { ok: false };
    try {
      return { ok: true, value: await run(projectId, selectedWorkflowId) };
    } catch (error) {
      reportFailure(failure, error);
      return { ok: false };
    }
  }

  return {
    projectId: null,
    summaries: [],
    selectedWorkflowId: null,
    detail: null,
    selectedTaskKey: null,

    loadWorkflows: async () => {
      const projectId = currentProjectId();
      const generation = ++listGeneration;
      if (!projectId) {
        set({ projectId: null, summaries: [], selectedWorkflowId: null, detail: null, selectedTaskKey: null });
        return;
      }
      let summaries: WorkflowSummary[];
      try {
        summaries = await window.electronAPI.workflows.list(projectId);
      } catch (error) {
        console.error('[workflow-store] Failed to load workflows:', describeIpcError(error));
        return;
      }
      if (generation !== listGeneration) return;
      const previous = get();
      const sameProject = previous.projectId === projectId;
      const keepSelection = sameProject && previous.selectedWorkflowId !== null
        && summaries.some((summary) => summary.workflow.id === previous.selectedWorkflowId);
      const selectedWorkflowId = keepSelection ? previous.selectedWorkflowId : (summaries[0]?.workflow.id ?? null);
      set({
        projectId,
        summaries,
        selectedWorkflowId,
        // A workflow that left the picker (finished, deleted) leaves the view.
        detail: selectedWorkflowId === previous.detail?.workflow.id ? previous.detail : null,
        selectedTaskKey: selectedWorkflowId === previous.selectedWorkflowId ? previous.selectedTaskKey : null,
      });
      if (selectedWorkflowId && (!keepSelection || !get().detail)) await get().loadDetail();
    },

    selectWorkflow: (workflowId, taskKey = null) => {
      if (workflowId === get().selectedWorkflowId) {
        set({ selectedTaskKey: taskKey });
        return;
      }
      set({ selectedWorkflowId: workflowId, detail: null, selectedTaskKey: taskKey });
      if (workflowId) void get().loadDetail();
    },

    selectTask: (taskKey) => set({ selectedTaskKey: taskKey }),

    loadDetail: async () => {
      const { projectId, selectedWorkflowId } = get();
      const generation = ++detailGeneration;
      if (!projectId || !selectedWorkflowId) return;
      let detail: WorkflowDetail;
      try {
        detail = await window.electronAPI.workflows.get(projectId, selectedWorkflowId);
      } catch (error) {
        // Deleted under the view (by an agent, or another surface): the list
        // reload that follows moves the view on.
        console.warn('[workflow-store] Failed to load workflow:', describeIpcError(error));
        return;
      }
      if (generation !== detailGeneration || get().selectedWorkflowId !== selectedWorkflowId) return;
      const selectedTaskKey = get().selectedTaskKey;
      set({
        detail: shareUnchanged(get().detail, detail),
        // A selected task that left the workflow leaves the inspector.
        selectedTaskKey: selectedTaskKey && detail.tasks.some((task) => task.key === selectedTaskKey) ? selectedTaskKey : null,
      });
    },

    handleChanged: (event) => {
      if (event.projectId !== get().projectId) return;
      void get().loadWorkflows();
      if (event.workflowId === get().selectedWorkflowId) void get().loadDetail();
    },

    createWorkflow: async (sourceTaskId) => {
      const projectId = currentProjectId();
      if (!projectId) return null;
      try {
        const workflow = await window.electronAPI.workflows.create(projectId, sourceTaskId);
        set({ projectId, selectedWorkflowId: workflow.id, detail: null, selectedTaskKey: null });
        await get().loadWorkflows();
        return workflow;
      } catch (error) {
        reportFailure('Could not create the workflow', error);
        return null;
      }
    },

    renameWorkflow: async (title) =>
      (await onSelected('Could not rename the workflow', (projectId, workflowId) =>
        window.electronAPI.workflows.rename(projectId, workflowId, title))).ok,

    deleteWorkflow: async () => {
      const result = await onSelected('Could not delete the workflow', (projectId, workflowId) =>
        window.electronAPI.workflows.delete(projectId, workflowId));
      if (result.ok) {
        set({ selectedWorkflowId: null, detail: null, selectedTaskKey: null });
        await get().loadWorkflows();
      }
      return result.ok;
    },

    startWorkflow: async () =>
      (await onSelected('Could not start the workflow', (projectId, workflowId) =>
        window.electronAPI.workflows.start(projectId, workflowId))).ok,

    pauseWorkflow: async () =>
      (await onSelected('Could not pause the workflow', (projectId, workflowId) =>
        window.electronAPI.workflows.pause(projectId, workflowId))).ok,

    resumeWorkflow: async () =>
      (await onSelected('Could not resume the workflow', (projectId, workflowId) =>
        window.electronAPI.workflows.resume(projectId, workflowId))).ok,

    addTask: async (input) => {
      const result = await onSelected('Could not add the task', (projectId, workflowId) =>
        window.electronAPI.workflows.addTask(projectId, workflowId, input));
      if (!result.ok) return null;
      set({ selectedTaskKey: result.value });
      return result.value;
    },

    updateTask: async (key, input) =>
      (await onSelected('Could not save the task', (projectId, workflowId) =>
        window.electronAPI.workflows.updateTask(projectId, workflowId, key, input))).ok,

    removeTask: async (key) => {
      const result = await onSelected('Could not remove the task', (projectId, workflowId) =>
        window.electronAPI.workflows.removeTask(projectId, workflowId, key));
      if (result.ok && get().selectedTaskKey === key) set({ selectedTaskKey: null });
      return result.ok;
    },

    setLink: async (blockerKey, blockedKey, linked) =>
      (await onSelected(linked ? 'Could not link the tasks' : 'Could not remove the link', (projectId, workflowId) =>
        window.electronAPI.workflows.setLink(projectId, workflowId, blockerKey, blockedKey, linked))).ok,

    setRoute: async (key, swimlaneIds) =>
      (await onSelected('Could not change the route', (projectId, workflowId) =>
        window.electronAPI.workflows.setRoute(projectId, workflowId, key, swimlaneIds))).ok,

    setPositions: async (positions) => {
      const detail = get().detail;
      if (detail) {
        const byKey = new Map((positions ?? []).map((position) => [position.key, position]));
        set({
          detail: {
            ...detail,
            tasks: detail.tasks.map((task) => {
              if (positions === null) return { ...task, canvasX: null, canvasY: null };
              const position = byKey.get(task.key);
              return position ? { ...task, canvasX: Math.round(position.x), canvasY: Math.round(position.y) } : task;
            }),
          },
        });
      }
      return (await onSelected('Could not save the layout', (projectId, workflowId) =>
        window.electronAPI.workflows.setPositions(projectId, workflowId, positions))).ok;
    },
  };
});

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component hook, so it is not a
// React Fast Refresh boundary. Pin the instance in `import.meta.hot.data` so a
// Fast Refresh cannot hand a second store to part of the view.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedWorkflowStore: ReturnType<typeof createWorkflowStore> | undefined = import.meta.hot?.data?.workflowStore;

export const useWorkflowStore = preservedWorkflowStore ?? createWorkflowStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.workflowStore = useWorkflowStore;
  // Editing this module's OWN code would leave the pinned instance running
  // stale closures; force a clean full reload instead. Rare; prod is
  // unaffected (import.meta.hot is undefined there, so this block is dropped).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
