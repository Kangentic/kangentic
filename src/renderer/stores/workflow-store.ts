import { create } from 'zustand';
import type {
  Workflow,
  WorkflowAgentStatus,
  WorkflowCanvasPosition,
  WorkflowChangedEvent,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowSupersession,
  WorkflowTaskInput,
} from '../../shared/types';
import { describeIpcError } from '../lib/ipc-error';
import { useProjectStore } from './project-store';
import { useSessionStore } from './session-store';
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

  /**
   * The current project's tasks a workflow replaced at Start, by task id: what
   * the Done row's "Superseded by" line reads. Finished workflows included,
   * which `summaries` leaves out. Reloaded with the summaries, so every change
   * push refreshes it too.
   */
  supersededBy: Record<string, WorkflowSupersession>;
  loadSupersessions: () => Promise<void>;

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

  /**
   * The same edits addressed to a workflow by its home project and id, for the
   * surfaces that act on a task's OWN workflow whatever the view shows (task
   * detail's workflow panel, the board card's menu). The ids are read when the
   * user acts (project-scoped-ipc.md).
   */
  setLinkIn: (homeProjectId: string, workflowId: string, blockerKey: string, blockedKey: string, linked: boolean) => Promise<boolean>;
  setRouteIn: (homeProjectId: string, workflowId: string, key: string, swimlaneIds: string[]) => Promise<boolean>;
  removeTaskIn: (homeProjectId: string, workflowId: string, key: string) => Promise<boolean>;

  /**
   * The unfinished workflows of OTHER projects that have a task on this board,
   * by home project, so a card on this board can name and lock by its workflow.
   * The board's own project's workflows are `summaries`.
   */
  homeSummaries: Record<string, WorkflowSummary[]>;
  loadHomeSummaries: (homeProjectIds: string[]) => Promise<void>;

  /**
   * Open the Workflows view on a workflow and one of its tasks. A workflow
   * whose home is another project opens there: the selection waits in
   * `pendingOpen` until that project's list arrives, as a task waits in the
   * session store's pending open.
   */
  openWorkflow: (homeProjectId: string, workflowId: string, taskKey?: string | null) => void;
  pendingOpen: { projectId: string; workflowId: string; taskKey: string | null } | null;

  /** The board's links overlay: the card it is on, and that card's workflow. */
  linkFocus: { taskId: string; homeProjectId: string; detail: WorkflowDetail } | null;
  showLinks: (taskId: string, homeProjectId: string, workflowId: string) => Promise<void>;
  clearLinks: () => void;

  /**
   * Workflows a task detail's workflow panel shows, by workflow id, kept
   * current on every change push while at least one panel watches it. Any
   * workflow, whatever the Workflows view has selected.
   */
  watchedDetails: Record<string, { homeProjectId: string; watchers: number; detail: WorkflowDetail | null }>;
  /** Start watching a workflow; the returned function stops. */
  watchDetail: (homeProjectId: string, workflowId: string) => () => void;

  /**
   * The workflow agent, in the view's left pane. Its session lives in the
   * session store (it carries `workflowId`); this holds why a workflow's agent
   * cannot run, from its last open, by workflow id.
   */
  agentUnavailable: Record<string, string>;
  /** The session whose terminal the pane has mounted, so main streams its bytes here. */
  agentPaneSessionId: string | null;
  setAgentPaneSessionId: (sessionId: string | null) => void;
  /** The pane folded to a strip, for the most canvas. Kept across workflows and view switches. */
  agentPaneCollapsed: boolean;
  setAgentPaneCollapsed: (collapsed: boolean) => void;
  /** The pane opened on the selected workflow: its agent as it is, or started when it has none. */
  openAgent: (grid?: { cols: number; rows: number } | null) => Promise<void>;
  /** The pane's Resume. */
  resumeAgent: (grid?: { cols: number; rows: number } | null) => Promise<void>;
  /** The pane's Pause. */
  pauseAgent: () => Promise<void>;
}

/** Bumped per detail request, so a slow answer cannot overwrite a newer one. */
let detailGeneration = 0; // hmr-safe: a reset generation only discards in-flight answers, and the store reloads on HMR (App.tsx).
/** The same, for the picker list. */
let listGeneration = 0; // hmr-safe: as above.
/** The same, for other projects' lists. */
let homeGeneration = 0; // hmr-safe: as above.
/** The same, for the supersessions. */
let supersessionGeneration = 0; // hmr-safe: as above.
/** The same, for the board's links overlay: a clear outranks a load still in flight. */
let linkGeneration = 0; // hmr-safe: as above; the overlay is cleared on leaving the board.
/** The same, per watched workflow (a task detail's panel). */
const watchedGenerations = new Map<string, number>(); // hmr-safe: as above; a reset only discards in-flight answers.

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

/**
 * The same for the summaries: keep each workflow row and each task's board
 * facts that a reload did not change. A board card reads its own facts by
 * reference, so a move in a 100-task workflow re-renders the cards whose
 * footer or lock changed, not every card in the workflow.
 */
export function shareSummaries(previous: readonly WorkflowSummary[], next: WorkflowSummary[]): WorkflowSummary[] {
  if (previous.length === 0) return next;
  const before = new Map(previous.map((summary) => [summary.workflow.id, summary]));
  return next.map((summary) => {
    const old = before.get(summary.workflow.id);
    if (!old) return summary;
    const workflow = JSON.stringify(old.workflow) === JSON.stringify(summary.workflow) ? old.workflow : summary.workflow;
    const boardTasks: WorkflowSummary['boardTasks'] = {};
    for (const [taskId, facts] of Object.entries(summary.boardTasks)) {
      const oldFacts = old.boardTasks[taskId];
      boardTasks[taskId] = oldFacts && JSON.stringify(oldFacts) === JSON.stringify(facts) ? oldFacts : facts;
    }
    return { ...summary, workflow, boardTasks };
  });
}

/**
 * The supersessions by source task id, keeping each entry a reload did not
 * change. Every Done row subscribes to its own entry by reference, so a reload
 * re-renders only the rows whose line changed.
 */
export function shareSupersessions(
  previous: Readonly<Record<string, WorkflowSupersession>>,
  next: readonly WorkflowSupersession[],
): Record<string, WorkflowSupersession> {
  const bySource: Record<string, WorkflowSupersession> = {};
  for (const supersession of next) {
    const old = previous[supersession.sourceTaskId];
    const unchanged = old
      && old.workflowId === supersession.workflowId
      && old.title === supersession.title
      && old.colorSlot === supersession.colorSlot;
    bySource[supersession.sourceTaskId] = unchanged ? old : supersession;
  }
  const previousKeys = Object.keys(previous);
  const same = previousKeys.length === next.length
    && previousKeys.every((key) => bySource[key] === previous[key]);
  return same ? previous : bySource;
}

const EMPTY_SUPERSESSIONS: Record<string, WorkflowSupersession> = {};

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

  /** Reload a watched workflow (a task detail's panel), keeping what did not change. */
  async function refreshWatched(workflowId: string): Promise<void> {
    const watched = get().watchedDetails[workflowId];
    if (!watched) return;
    // Two pushes in a row can answer out of order: only the newest read lands.
    const generation = (watchedGenerations.get(workflowId) ?? 0) + 1;
    watchedGenerations.set(workflowId, generation);
    let detail: WorkflowDetail;
    try {
      detail = await window.electronAPI.workflows.get(watched.homeProjectId, workflowId);
    } catch (error) {
      console.warn('[workflow-store] Failed to load a task\'s workflow:', describeIpcError(error));
      return;
    }
    if (watchedGenerations.get(workflowId) !== generation) return;
    const current = get().watchedDetails[workflowId];
    if (!current) return;
    set({ watchedDetails: { ...get().watchedDetails, [workflowId]: { ...current, detail: shareUnchanged(current.detail, detail) } } });
  }

  /**
   * Show what an open or resume answered. The session arrives in the session
   * store by its own push too; upserting it here saves the pane a frame with
   * nothing in it.
   */
  function applyAgentStatus(workflowId: string, status: WorkflowAgentStatus): void {
    if (status.session) useSessionStore.getState().upsertSession(status.session);
    const { [workflowId]: _previous, ...rest } = get().agentUnavailable;
    set({ agentUnavailable: status.unavailable ? { ...rest, [workflowId]: status.unavailable } : rest });
  }

  /** One change against a workflow named by its home and id. */
  async function onWorkflow(failure: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      reportFailure(failure, error);
      return false;
    }
  }

  return {
    projectId: null,
    summaries: [],
    supersededBy: EMPTY_SUPERSESSIONS,
    selectedWorkflowId: null,
    detail: null,
    selectedTaskKey: null,
    homeSummaries: {},
    pendingOpen: null,
    linkFocus: null,
    watchedDetails: {},
    agentUnavailable: {},
    agentPaneSessionId: null,
    agentPaneCollapsed: false,

    setAgentPaneSessionId: (sessionId) => {
      if (get().agentPaneSessionId !== sessionId) set({ agentPaneSessionId: sessionId });
    },

    setAgentPaneCollapsed: (collapsed) => set({ agentPaneCollapsed: collapsed }),

    openAgent: async (grid) => {
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return;
      try {
        applyAgentStatus(selectedWorkflowId, await window.electronAPI.workflows.agentOpen(projectId, selectedWorkflowId, grid?.cols, grid?.rows));
      } catch (error) {
        reportFailure('Could not start the workflow agent', error);
      }
    },

    resumeAgent: async (grid) => {
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return;
      try {
        applyAgentStatus(selectedWorkflowId, await window.electronAPI.workflows.agentResume(projectId, selectedWorkflowId, grid?.cols, grid?.rows));
      } catch (error) {
        reportFailure('Could not resume the workflow agent', error);
      }
    },

    pauseAgent: async () => {
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return;
      try {
        await window.electronAPI.workflows.agentPause(projectId, selectedWorkflowId);
      } catch (error) {
        reportFailure('Could not pause the workflow agent', error);
      }
    },

    loadWorkflows: async () => {
      const projectId = currentProjectId();
      const generation = ++listGeneration;
      // Alongside, not after: the Done rows' lines need no summary.
      void get().loadSupersessions();
      if (!projectId) {
        set({ projectId: null, summaries: [], selectedWorkflowId: null, detail: null, selectedTaskKey: null });
        return;
      }
      let summaries: WorkflowSummary[];
      try {
        summaries = await window.electronAPI.workflows.list(projectId);
      } catch (error) {
        console.error('[workflow-store] Failed to load workflows:', describeIpcError(error));
        // A project switch whose read failed must not leave the old project's
        // workflow on screen under the new project's header, where its actions
        // would still reach the old project.
        if (generation === listGeneration && get().projectId !== projectId) {
          set({ projectId, summaries: [], selectedWorkflowId: null, detail: null, selectedTaskKey: null });
        }
        return;
      }
      if (generation !== listGeneration) return;
      const previous = get();
      // An Open workflow that switched projects to get here picks its workflow
      // and task once that project's list arrives.
      const pending = previous.pendingOpen?.projectId === projectId
        && summaries.some((summary) => summary.workflow.id === previous.pendingOpen?.workflowId)
        ? previous.pendingOpen
        : null;
      const sameProject = previous.projectId === projectId;
      const keepSelection = pending === null && sameProject && previous.selectedWorkflowId !== null
        && summaries.some((summary) => summary.workflow.id === previous.selectedWorkflowId);
      const selectedWorkflowId = pending?.workflowId
        ?? (keepSelection ? previous.selectedWorkflowId : (summaries[0]?.workflow.id ?? null));
      set({
        projectId,
        summaries: sameProject ? shareSummaries(previous.summaries, summaries) : summaries,
        selectedWorkflowId,
        // A workflow that left the picker (finished, deleted) leaves the view.
        detail: selectedWorkflowId === previous.detail?.workflow.id ? previous.detail : null,
        selectedTaskKey: pending
          ? pending.taskKey
          : selectedWorkflowId === previous.selectedWorkflowId ? previous.selectedTaskKey : null,
        pendingOpen: previous.pendingOpen?.projectId === projectId ? null : previous.pendingOpen,
      });
      if (selectedWorkflowId && (!keepSelection || !get().detail)) await get().loadDetail();
    },

    loadSupersessions: async () => {
      const projectId = currentProjectId();
      const generation = ++supersessionGeneration;
      if (!projectId) {
        set({ supersededBy: EMPTY_SUPERSESSIONS });
        return;
      }
      let supersessions: WorkflowSupersession[];
      try {
        supersessions = await window.electronAPI.workflows.listSupersessions(projectId);
      } catch (error) {
        console.error('[workflow-store] Failed to load superseded tasks:', describeIpcError(error));
        return;
      }
      // A newer load, or a project switch while this one was in flight, wins.
      if (generation !== supersessionGeneration || currentProjectId() !== projectId) return;
      const previous = get().supersededBy;
      const next = shareSupersessions(previous, supersessions);
      if (next !== previous) set({ supersededBy: next });
    },

    loadHomeSummaries: async (homeProjectIds) => {
      const own = currentProjectId();
      const wanted = [...new Set(homeProjectIds)].filter((id) => id && id !== own);
      const generation = ++homeGeneration;
      const loaded: Record<string, WorkflowSummary[]> = {};
      await Promise.all(wanted.map(async (homeProjectId) => {
        try {
          const list = await window.electronAPI.workflows.list(homeProjectId);
          loaded[homeProjectId] = shareSummaries(get().homeSummaries[homeProjectId] ?? [], list);
        } catch (error) {
          // A home that cannot be read (closed, deleted) names nothing; its cards show no workflow strip.
          console.warn('[workflow-store] Failed to load another project\'s workflows:', describeIpcError(error));
        }
      }));
      if (generation !== homeGeneration) return;
      set({ homeSummaries: loaded });
    },

    openWorkflow: (homeProjectId, workflowId, taskKey = null) => {
      if (homeProjectId === currentProjectId()) {
        set({ pendingOpen: null });
        get().selectWorkflow(workflowId, taskKey);
        return;
      }
      set({ pendingOpen: { projectId: homeProjectId, workflowId, taskKey } });
      void useProjectStore.getState().openProject(homeProjectId);
    },

    showLinks: async (taskId, homeProjectId, workflowId) => {
      // A clear (Escape, a click on empty board) or a newer show while this one
      // loads wins: a late answer must not bring the overlay back.
      const generation = ++linkGeneration;
      try {
        const detail = await window.electronAPI.workflows.get(homeProjectId, workflowId);
        if (generation !== linkGeneration) return;
        set({ linkFocus: { taskId, homeProjectId, detail } });
      } catch (error) {
        console.warn('[workflow-store] Failed to load the workflow for its links:', describeIpcError(error));
        if (generation !== linkGeneration) return;
        set({ linkFocus: null });
      }
    },

    clearLinks: () => {
      linkGeneration += 1;
      set({ linkFocus: null });
    },

    watchDetail: (homeProjectId, workflowId) => {
      const existing = get().watchedDetails[workflowId];
      set({
        watchedDetails: {
          ...get().watchedDetails,
          [workflowId]: { homeProjectId, watchers: (existing?.watchers ?? 0) + 1, detail: existing?.detail ?? null },
        },
      });
      if (!existing) void refreshWatched(workflowId);
      return () => {
        const current = get().watchedDetails[workflowId];
        if (!current) return;
        const { [workflowId]: _removed, ...rest } = get().watchedDetails;
        set({ watchedDetails: current.watchers <= 1 ? rest : { ...rest, [workflowId]: { ...current, watchers: current.watchers - 1 } } });
      };
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
      const { projectId, homeSummaries, linkFocus } = get();
      if (event.projectId === projectId) {
        void get().loadWorkflows();
        if (event.workflowId === get().selectedWorkflowId) void get().loadDetail();
      } else if (homeSummaries[event.projectId]) {
        // Another project's workflow with a task on this board: its name, state and lock.
        void get().loadHomeSummaries(Object.keys(homeSummaries));
      }
      if (linkFocus && linkFocus.detail.workflow.id === event.workflowId) {
        void get().showLinks(linkFocus.taskId, linkFocus.homeProjectId, event.workflowId);
      }
      if (get().watchedDetails[event.workflowId]) void refreshWatched(event.workflowId);
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
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return false;
      const ok = await get().removeTaskIn(projectId, selectedWorkflowId, key);
      if (ok && get().selectedTaskKey === key) set({ selectedTaskKey: null });
      return ok;
    },

    setLink: async (blockerKey, blockedKey, linked) => {
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return false;
      return get().setLinkIn(projectId, selectedWorkflowId, blockerKey, blockedKey, linked);
    },

    setRoute: async (key, swimlaneIds) => {
      const { projectId, selectedWorkflowId } = get();
      if (!projectId || !selectedWorkflowId) return false;
      return get().setRouteIn(projectId, selectedWorkflowId, key, swimlaneIds);
    },

    removeTaskIn: (homeProjectId, workflowId, key) =>
      onWorkflow('Could not remove the task', () => window.electronAPI.workflows.removeTask(homeProjectId, workflowId, key)),

    setLinkIn: (homeProjectId, workflowId, blockerKey, blockedKey, linked) =>
      onWorkflow(linked ? 'Could not link the tasks' : 'Could not remove the link', () =>
        window.electronAPI.workflows.setLink(homeProjectId, workflowId, blockerKey, blockedKey, linked)),

    setRouteIn: (homeProjectId, workflowId, key, swimlaneIds) =>
      onWorkflow('Could not change the route', () => window.electronAPI.workflows.setRoute(homeProjectId, workflowId, key, swimlaneIds)),

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
      const saved = (await onSelected('Could not save the layout', (projectId, workflowId) =>
        window.electronAPI.workflows.setPositions(projectId, workflowId, positions))).ok;
      // The positions above were drawn before the save. A refused save writes
      // nothing, so no push arrives to put the cards back: read them again.
      if (!saved) void get().loadDetail();
      return saved;
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
