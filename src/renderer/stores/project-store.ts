import { create } from 'zustand';
import type { Project, ProjectCreateInput } from '../../shared/types';
import { useSessionStore } from './session-store';

interface ProjectStore {
  projects: Project[];
  currentProject: Project | null;
  loading: boolean;

  loadProjects: () => Promise<void>;
  createProject: (input: ProjectCreateInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;
  loadCurrent: () => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true });
    const projects = await window.electronAPI.projects.list();
    set({ projects, loading: false });
  },

  createProject: async (input) => {
    const project = await window.electronAPI.projects.create(input);
    set((s) => ({ projects: [project, ...s.projects] }));
    return project;
  },

  deleteProject: async (id) => {
    await window.electronAPI.projects.delete(id);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      currentProject: s.currentProject?.id === id ? null : s.currentProject,
    }));
  },

  openProject: async (id) => {
    await window.electronAPI.projects.open(id);
    const project = get().projects.find((p) => p.id === id) || await window.electronAPI.projects.getCurrent();
    set({ currentProject: project });
    useSessionStore.getState().markIdleSessionsSeen(id);
  },

  reorderProjects: async (ids) => {
    // Optimistic update: reorder projects array to match ids order
    const { projects } = get();
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const reordered = ids.map((id) => projectById.get(id)).filter((p): p is Project => p !== undefined);
    set({ projects: reordered });
    try {
      await window.electronAPI.projects.reorder(ids);
    } catch {
      // Rollback on error
      await get().loadProjects();
    }
  },

  loadCurrent: async () => {
    const project = await window.electronAPI.projects.getCurrent();
    set({ currentProject: project });
  },
}));
