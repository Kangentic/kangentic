import { create, type StateCreator } from 'zustand';
import type { Project, ProjectCreateInput, ProjectGroup, ProjectGroupCreateInput, ProjectRelocateOptions, ProjectRelocateResult } from '../../shared/types';
import { PROJECT_PATH_MISSING_PREFIX } from '../../shared/ipc-channels';
import { useSessionStore } from './session-store';
import { useConfigStore } from './config-store';
import { dropProject as dropProjectCache } from './project-cache';

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
  openProject: (id: string) => Promise<void>;
  openProjectByPath: (folderPath: string) => Promise<Project>;
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
    const projects = await window.electronAPI.projects.list();
    projectsReady = true;
    set({ projects, loading: false, hydrated: projectsReady && currentReady });
  },

  createProject: async (input) => {
    const project = await window.electronAPI.projects.create(input);
    set((s) => ({ projects: [project, ...s.projects] }));
    return project;
  },

  deleteProject: async (id) => {
    useSessionStore.getState().killTransientSessionForProject(id).catch(() => {});
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
      // The project's folder was moved or renamed on disk. Surface the
      // "Locate Folder..." dialog instead of a generic failure.
      if (err instanceof Error && err.message.includes(PROJECT_PATH_MISSING_PREFIX)) {
        const project = get().projects.find((candidate) => candidate.id === id) ?? null;
        set({ missingPathProject: project });
        return;
      }
      throw err;
    }
    const project = get().projects.find((p) => p.id === id) || await window.electronAPI.projects.getCurrent();
    set({ currentProject: project });
    useSessionStore.getState().markIdleSessionsSeen(id);
  },

  openProjectByPath: async (folderPath) => {
    const { projects } = get();
    const normalized = folderPath.replace(/\\/g, '/');
    const existing = projects.find(
      (project) => project.path.replace(/\\/g, '/') === normalized,
    );

    if (existing) {
      await get().openProject(existing.id);
      return existing;
    }

    const project = await window.electronAPI.projects.openByPath(folderPath);
    await get().loadProjects();
    await get().loadCurrent();
    return project;
  },

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
    useSessionStore.getState().killTransientSessionForProject(id).catch(() => {});
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
    const project = await window.electronAPI.projects.getCurrent();
    currentReady = true;
    set({ currentProject: project, hydrated: projectsReady && currentReady });
  },

  // Group actions
  loadGroups: async () => {
    const groups = await window.electronAPI.projectGroups.list();
    set({ groups });
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
