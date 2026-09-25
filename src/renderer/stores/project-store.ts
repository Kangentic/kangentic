import { create, type StateCreator } from 'zustand';
import type { Project, ProjectCreateInput, ProjectGroup, ProjectGroupCreateInput, ProjectRelocateOptions, ProjectRelocateResult, ProjectOpenByPathOverrides, ProjectPathProbe, ProjectEnsureGitResult } from '../../shared/types';
import { PROJECT_PATH_MISSING_PREFIX, PROJECT_NOT_FOUND_PREFIX } from '../../shared/ipc-channels';
import { describeIpcError } from '../lib/ipc-error';
// Not `./session-store` directly: that would close an import cycle whose
// circular-import invalidate full-reloads the dev page. See the module docblock.
import { killTransientSessionForProject, markIdleSessionsSeen } from './session-lifecycle-hooks';
import { useConfigStore } from './config-store';
import { useToastStore } from './toast-store';
import { dropProject as dropProjectCache } from './project-cache';

/**
 * What `openProject` actually did. `openProject` never throws: every failure is
 * reported where it happens (a toast, or `missingPathProject` for the "Locate
 * Folder..." dialog) and reflected in the outcome instead. Callers branch on
 * this so they do not act as though a switch landed when it did not, which is
 * what `board-config-slice.ts` applying config against the wrong project, and
 * `ProjectPathMissingDialog` toasting success for a re-open that never
 * happened, both used to do. A caller that only needs "did it open" compares
 * against `'opened'`; the three failure values are diagnostic.
 */
export type OpenProjectOutcome = 'opened' | 'missing-path' | 'not-found' | 'failed';

// Hydration gate: tracks whether both loadProjects() and loadCurrent() have
// resolved at least once. Module-scoped so they don't pollute the store
// interface. The store instance is pinned across HMR (Pattern E, below), and the
// vite:afterUpdate handler in App.tsx re-calls both methods after every reload,
// so these gates stay correct for the pinned instance's closures.
let projectsReady = false;
let currentReady = false;

interface ProjectStore {
  projects: Project[];
  groups: ProjectGroup[];
  currentProject: Project | null;
  loading: boolean;
  hydrated: boolean;
  /** Project whose registered folder no longer exists on disk; drives the "Locate Folder..." dialog. */
  missingPathProject: Project | null;

  loadProjects: () => Promise<void>;
  createProject: (input: ProjectCreateInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  openProject: (id: string) => Promise<OpenProjectOutcome>;
  /**
   * Opens an already-registered path via `openProject`, or registers a new one.
   * The two branches fail differently, so a caller needs to handle both. For an
   * already-registered path this resolves to `null` and never throws, because
   * the inner `openProject` has already reported why (a toast, or the
   * missing-path dialog); stop rather than proceed as though a project opened.
   * Registering a NEW path still throws if `projects.openByPath` rejects, so
   * keep that call in a try/catch and report the error yourself.
   */
  openProjectByPath: (folderPath: string, overrides?: ProjectOpenByPathOverrides) => Promise<Project | null>;
  probePath: (folderPath: string) => Promise<ProjectPathProbe>;
  /** Make sure a picked folder is covered by git, initialising a repo when it is not. */
  ensureGit: (folderPath: string) => Promise<ProjectEnsureGitResult>;
  reorderProjects: (ids: string[]) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  relocateProject: (id: string, newPath: string, options?: ProjectRelocateOptions) => Promise<ProjectRelocateResult>;
  setMissingPathProject: (project: Project | null) => void;
  setProjectGroup: (projectId: string, groupId: string | null) => Promise<void>;
  loadCurrent: () => Promise<void>;

  // Group actions
  loadGroups: () => Promise<void>;
  createGroup: (input: ProjectGroupCreateInput) => Promise<ProjectGroup>;
  updateGroup: (id: string, name: string) => Promise<ProjectGroup>;
  deleteGroup: (id: string) => Promise<void>;
  reorderGroups: (ids: string[]) => Promise<void>;
  toggleGroupCollapsed: (id: string) => Promise<void>;
}

const projectStoreInitializer: StateCreator<ProjectStore> = (set, get) => ({
  projects: [],
  groups: [],
  currentProject: null,
  loading: false,
  hydrated: false,
  missingPathProject: null,

  loadProjects: async () => {
    set({ loading: true });
    // The catch is what stops a rejection from stranding the whole app on its
    // loading spinner: without it `loading` stays true and `hydrated` never
    // flips, so App.tsx never runs hydrateView either. The main process now
    // degrades this read rather than rejecting (see src/main/db/soft-db.ts),
    // but a permanent spinner is the wrong answer to ANY failure here.
    let projects: Project[] = [];
    try {
      projects = await window.electronAPI.projects.list();
    } catch (error) {
      console.error('[project-store] Failed to load projects:', describeIpcError(error));
    }
    projectsReady = true;
    set({ projects, loading: false, hydrated: projectsReady && currentReady });
  },

  createProject: async (input) => {
    const project = await window.electronAPI.projects.create(input);
    set((s) => ({ projects: [project, ...s.projects] }));
    return project;
  },

  deleteProject: async (id) => {
    killTransientSessionForProject(id);
    await window.electronAPI.projects.delete(id);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      currentProject: s.currentProject?.id === id ? null : s.currentProject,
    }));
    // Drop the deleted project's remembered active task. Stale entries are
    // harmless (they'd never match a real session) but accumulate over time.
    const existing = useConfigStore.getState().config.lastActiveTaskByProject ?? {};
    if (existing[id] !== undefined) {
      const { [id]: _removed, ...remaining } = existing;
      useConfigStore.setState((state) => ({
        config: { ...state.config, lastActiveTaskByProject: remaining },
        globalConfig: { ...state.globalConfig, lastActiveTaskByProject: remaining },
      }));
      window.electronAPI.config.set({ lastActiveTaskByProject: remaining });
    }
    // Drop the warm-switch cache entry. Mirrors the main-side
    // `recoveredProjects.delete(id)` in cleanupProject so a future project
    // sharing the same id (extremely unlikely, but possible after a manual
    // re-add) starts cold.
    dropProjectCache(id);
  },

  openProject: async (id) => {
    // Transient (Command Terminal) sessions stay tracked per (project, slot) in
    // the session store and survive the switch; the command bar closes on project
    // change (useCommandBar) and its windows rebind to the new project's slots on
    // reopen, so there is no singleton pointer to stash/restore here.
    try {
      await window.electronAPI.projects.open(id);
    } catch (err) {
      if (err instanceof Error && err.message.includes(PROJECT_PATH_MISSING_PREFIX)) {
        // The project's folder was moved or renamed on disk. Surface the
        // "Locate Folder..." dialog instead of a generic failure.
        let project = get().projects.find((candidate) => candidate.id === id) ?? null;
        if (!project) {
          // The renderer's own list is stale - the same staleness class as
          // the not-found branch below, just caught by a different sentinel.
          // Without this, `missingPathProject` is set to null, the dialog
          // never renders, and the click reads as doing nothing.
          await get().loadProjects();
          project = get().projects.find((candidate) => candidate.id === id) ?? null;
        }
        if (!project) {
          // Main confirmed the row exists (it threw the path-missing
          // sentinel, not not-found) - the renderer simply has nothing to
          // put in the dialog even after a refetch. Report it and stop;
          // 'not-found' would tell the caller a different, false story.
          // A static message here, not describeIpcError(err): this err's
          // message IS the PROJECT_PATH_MISSING_PREFIX sentinel, which
          // describeIpcError has no reason to know how to strip, so
          // interpolating it would leak the raw token into the toast.
          useToastStore.getState().addToast({
            message: 'Could not open that project. Its record could not be found after refreshing the project list.',
            variant: 'error',
          });
          return 'failed';
        }
        set({ missingPathProject: project });
        return 'missing-path';
      }

      if (err instanceof Error && err.message.includes(PROJECT_NOT_FOUND_PREFIX)) {
        // Sentry DESKTOP-V: the renderer's project list outlived the row
        // behind it. Refetch the whole list rather than dropping just this
        // row - the production repro clicked five different stale rows in
        // three seconds, so healing one at a time would leave the rest
        // clickable-but-broken.
        await get().loadProjects();
        await get().loadCurrent();
        const stillListed = get().projects.some((candidate) => candidate.id === id);
        useToastStore.getState().addToast({
          // Not describeIpcError(err) in the stillListed branch: this err's
          // message IS the PROJECT_NOT_FOUND_PREFIX sentinel, which
          // describeIpcError has no reason to know how to strip, so
          // interpolating it would leak the raw token into the toast.
          message: stillListed
            // The refetch still lists it: this is a main-side
            // inconsistency, not a stale renderer, and the "gone" story
            // would be false.
            ? 'Could not open that project. The project list may be out of sync - try again.'
            : 'That project is no longer available. The list has been refreshed.',
          variant: 'error',
        });
        return 'not-found';
      }

      useToastStore.getState().addToast({
        message: `Could not open that project. ${describeIpcError(err)}`,
        variant: 'error',
      });
      return 'failed';
    }
    // The `getCurrent()` fallback is reached exactly when the renderer's cached
    // list has not caught up with the row main just opened, which is the same
    // staleness this whole change exists for. It sits outside the try above, so
    // an unguarded rejection here would escape as a thrown `openProject` - the
    // one thing the five de-catched call sites no longer handle.
    let project = get().projects.find((candidate) => candidate.id === id) ?? null;
    if (!project) {
      try {
        project = await window.electronAPI.projects.getCurrent();
      } catch (err) {
        useToastStore.getState().addToast({
          message: `Could not open that project. ${describeIpcError(err)}`,
          variant: 'error',
        });
        return 'failed';
      }
    }
    set({ currentProject: project });
    markIdleSessionsSeen(id);
    return 'opened';
  },

  openProjectByPath: async (folderPath, overrides) => {
    const { projects } = get();
    const normalized = folderPath.replace(/\\/g, '/');
    const existing = projects.find(
      (project) => project.path.replace(/\\/g, '/') === normalized,
    );

    if (existing) {
      // openProject has already reported any failure itself (a toast, or the
      // missing-path dialog); null tells the caller to stop rather than
      // proceed as though the project opened.
      const outcome = await get().openProject(existing.id);
      return outcome === 'opened' ? existing : null;
    }

    const project = await window.electronAPI.projects.openByPath(folderPath, overrides);
    await get().loadProjects();
    await get().loadCurrent();
    return project;
  },

  probePath: (folderPath) => window.electronAPI.projects.probePath(folderPath),

  ensureGit: (folderPath) => window.electronAPI.projects.ensureGit(folderPath),

  reorderProjects: async (ids) => {
    // Optimistic update: reorder projects array and update position fields
    const { projects } = get();
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const reordered = ids
      .map((id, index) => {
        const project = projectById.get(id);
        return project ? { ...project, position: index } : undefined;
      })
      .filter((p): p is Project => p !== undefined);
    set({ projects: reordered });
    try {
      await window.electronAPI.projects.reorder(ids);
    } catch {
      // Rollback on error
      await get().loadProjects();
    }
  },

  renameProject: async (id, name) => {
    // Optimistic update
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, name } : project,
      ),
      currentProject: state.currentProject?.id === id
        ? { ...state.currentProject, name }
        : state.currentProject,
    }));
    try {
      await window.electronAPI.projects.rename(id, name);
    } catch {
      await get().loadProjects();
    }
  },

  relocateProject: async (id, newPath, options) => {
    // No optimistic update: validation failures (path missing, already
    // registered to another project) are expected user-facing errors.
    killTransientSessionForProject(id);
    const result = await window.electronAPI.projects.relocate(id, newPath, options);
    const updated = result.project;
    set((state) => ({
      projects: state.projects.map((project) => (project.id === id ? updated : project)),
      currentProject: state.currentProject?.id === id ? updated : state.currentProject,
      missingPathProject: state.missingPathProject?.id === id ? null : state.missingPathProject,
    }));
    // Re-open through the normal flow so the main process re-attaches the
    // board config watcher and re-runs session recovery at the new path.
    if (get().currentProject?.id === id) {
      await get().openProject(id);
    }
    return result;
  },

  setMissingPathProject: (project) => {
    set({ missingPathProject: project });
  },

  setProjectGroup: async (projectId, groupId) => {
    // Optimistic update
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, group_id: groupId } : p,
      ),
    }));
    try {
      await window.electronAPI.projects.setGroup(projectId, groupId);
    } catch {
      await get().loadProjects();
    }
  },

  loadCurrent: async () => {
    // The third hydration gate, and the same reasoning as loadProjects above:
    // `currentReady` is half of what flips `hydrated`, so a rejection here
    // strands the app on its loading spinner just as completely. App.tsx calls
    // this as a floating promise as well, so the rejection would also have no
    // owner. Degrading to "no current project" opens the project picker.
    let project: Project | null = null;
    try {
      project = await window.electronAPI.projects.getCurrent();
    } catch (error) {
      console.error('[project-store] Failed to load the current project:', describeIpcError(error));
    }
    currentReady = true;
    set({ currentProject: project, hydrated: projectsReady && currentReady });
  },

  // Group actions
  loadGroups: async () => {
    // Called as a floating promise from App.tsx, so a rejection here is an
    // unhandled one. Groups are presentational: no groups renders a flat
    // project list, which is a working app.
    try {
      const groups = await window.electronAPI.projectGroups.list();
      set({ groups });
    } catch (error) {
      console.error('[project-store] Failed to load project groups:', describeIpcError(error));
    }
  },

  createGroup: async (input) => {
    const group = await window.electronAPI.projectGroups.create(input);
    set((s) => ({ groups: [...s.groups, group] }));
    return group;
  },

  updateGroup: async (id, name) => {
    const group = await window.electronAPI.projectGroups.update(id, name);
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? group : g)),
    }));
    return group;
  },

  deleteGroup: async (id) => {
    await window.electronAPI.projectGroups.delete(id);
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      // Ungroup any projects that were in this group
      projects: s.projects.map((p) =>
        p.group_id === id ? { ...p, group_id: null } : p,
      ),
    }));
  },

  reorderGroups: async (ids) => {
    // Optimistic update
    const { groups } = get();
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const reordered = ids
      .map((id, index) => {
        const group = groupById.get(id);
        return group ? { ...group, position: index } : undefined;
      })
      .filter((g): g is ProjectGroup => g !== undefined);
    set({ groups: reordered });
    try {
      await window.electronAPI.projectGroups.reorder(ids);
    } catch {
      await get().loadGroups();
    }
  },

  toggleGroupCollapsed: async (id) => {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const newCollapsed = !group.is_collapsed;
    // Optimistic update
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === id ? { ...g, is_collapsed: newCollapsed } : g,
      ),
    }));
    try {
      await window.electronAPI.projectGroups.setCollapsed(id, newCollapsed);
    } catch {
      await get().loadGroups();
    }
  },
});

const createProjectStore = () => create<ProjectStore>(projectStoreInitializer);

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component `useProjectStore`, so it is
// not a React Fast Refresh boundary. Pin the instance in `import.meta.hot.data`
// so a Fast Refresh that re-evaluates this module cannot strand a second store
// instance while the mounted sidebar stays subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedProjectStore: ReturnType<typeof createProjectStore> | undefined = import.meta.hot?.data?.projectStore;

export const useProjectStore = preservedProjectStore ?? createProjectStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.projectStore = useProjectStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // closures; force a clean full reload instead (rare; prod drops this block).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
