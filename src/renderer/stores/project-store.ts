import { create } from 'zustand';
import type { Project, ProjectCreateInput, ProjectGroup, ProjectGroupCreateInput } from '../../shared/types';
import { useSessionStore } from './session-store';

// Hydration gate: tracks whether both loadProjects() and loadCurrent() have
// resolved at least once. Module-scoped so they don't pollute the store
// interface. On HMR, the module re-evaluates and both reset to false, but the
// vite:afterUpdate handler in App.tsx immediately re-calls both methods.
let projectsReady = false;
let currentReady = false;

interface ProjectStore {
  projects: Project[];
  groups: ProjectGroup[];
  currentProject: Project | null;
  loading: boolean;
  hydrated: boolean;

  loadProjects: () => Promise<void>;
  createProject: (input: ProjectCreateInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  openProjectByPath: (folderPath: string) => Promise<Project>;
  reorderProjects: (ids: string[]) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
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

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  groups: [],
  currentProject: null,
  loading: false,
  hydrated: false,

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
  },

  openProject: async (id) => {
    // Stash current project's transient session (keep PTY alive for later restore)
    useSessionStore.getState().stashTransientSession();
    await window.electronAPI.projects.open(id);
    const project = get().projects.find((p) => p.id === id) || await window.electronAPI.projects.getCurrent();
    set({ currentProject: project });
    // Restore the target project's transient session if one exists
    useSessionStore.getState().restoreTransientSession(id);
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
}));
