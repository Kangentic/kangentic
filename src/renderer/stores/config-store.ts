import { create } from 'zustand';
import type { AppConfig, DeepPartial, AgentDetectionInfo } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';
import { deepMergeConfig } from '../../shared/object-utils';

/** Extract the version number from the raw string (e.g. "2.1.50 (Claude Code)" -> "2.1.50"). */
function parseAgentVersion(version: string | null): string | null {
  return version?.replace(/\s*\(.*\)/, '') || null;
}

interface ConfigStore {
  // -- App config --
  config: AppConfig;
  globalConfig: AppConfig;
  loading: boolean;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: DeepPartial<AppConfig>) => Promise<void>;

  // -- App version --
  appVersion: string | null;
  loadAppVersion: () => Promise<void>;

  // -- Agent CLI detection --
  agentInfo: { found: boolean; path: string | null; version: string | null } | null;
  agentVersionNumber: string | null;
  detectAgent: () => Promise<void>;

  // -- Git detection --
  gitInfo: { found: boolean; path: string | null; version: string | null; meetsMinimum: boolean } | null;
  detectGit: () => Promise<void>;

  // -- Agent detection --
  agentList: AgentDetectionInfo[];
  loadAgentList: () => Promise<void>;

  // -- Settings panel UI --
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  // -- Project Settings --
  projectSettingsPath: string | null;
  projectSettingsProjectName: string | null;
  projectSettingsInitialTab: string | null;
  openProjectSettings: (projectPath: string, projectName: string, initialTab?: string) => void;

  // -- Project overrides --
  projectOverrides: DeepPartial<AppConfig> | null;
  loadProjectOverrides: () => Promise<void>;
  updateProjectOverride: (partial: DeepPartial<AppConfig>) => Promise<void>;

}

/** Fetch both effective and global configs from main process. */
async function refreshConfigs(): Promise<{ config: AppConfig; globalConfig: AppConfig }> {
  const [config, globalConfig] = await Promise.all([
    window.electronAPI.config.get(),
    window.electronAPI.config.getGlobal(),
  ]);
  return { config, globalConfig };
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: DEFAULT_CONFIG,
  globalConfig: DEFAULT_CONFIG,
  appVersion: null,
  agentList: [],
  agentInfo: null,
  agentVersionNumber: null,
  gitInfo: null,
  loading: true,
  settingsOpen: false,
  projectSettingsPath: null,
  projectSettingsProjectName: null,
  projectSettingsInitialTab: null,
  projectOverrides: null,
  loadConfig: async () => {
    set({ loading: true });
    const configs = await refreshConfigs();
    set({ ...configs, loading: false });
  },

  updateConfig: async (partial) => {
    await window.electronAPI.config.set(partial);
    const configs = await refreshConfigs();
    set(configs);
  },

  loadAppVersion: async () => {
    const appVersion = await window.electronAPI.app.getVersion();
    set({ appVersion });
  },

  detectAgent: async () => {
    const agentInfo = await window.electronAPI.agent.detect();
    const version = parseAgentVersion(agentInfo?.version ?? null);
    set({
      agentInfo,
      agentVersionNumber: version,
    });
  },

  detectGit: async () => {
    const gitInfo = await window.electronAPI.git.detect();
    set({ gitInfo });
  },

  loadAgentList: async () => {
    const agentList = await window.electronAPI.agents.list();
    set({ agentList });
  },

  setSettingsOpen: (open) => {
    if (open) {
      set({ settingsOpen: true });
    } else {
      set({
        settingsOpen: false,
        projectSettingsPath: null,
        projectSettingsProjectName: null,
        projectSettingsInitialTab: null,
        projectOverrides: null,
      });
      refreshConfigs().then((configs) => set(configs));
    }
  },

  // -- Project settings --
  openProjectSettings: (projectPath, projectName, initialTab) => {
    const currentPath = get().projectSettingsPath;
    set({
      settingsOpen: true,
      projectSettingsPath: projectPath,
      projectSettingsProjectName: projectName,
      projectSettingsInitialTab: initialTab || null,
      ...(currentPath !== projectPath ? { projectOverrides: null } : {}),
    });
    window.electronAPI.config.getProjectOverridesByPath(projectPath).then((overrides) => {
      if (get().projectSettingsPath === projectPath) {
        set({ projectOverrides: overrides });
      }
    });
  },

  loadProjectOverrides: async () => {
    const projectPath = get().projectSettingsPath;
    if (!projectPath) return;
    const overrides = await window.electronAPI.config.getProjectOverridesByPath(projectPath);
    if (get().projectSettingsPath === projectPath) {
      set({ projectOverrides: overrides });
    }
  },

  updateProjectOverride: async (partial) => {
    const projectPath = get().projectSettingsPath;
    if (!projectPath) return;
    const current = get().projectOverrides || {};
    const merged = deepMergeConfig(current, partial) as DeepPartial<AppConfig>;
    await window.electronAPI.config.setProjectOverridesByPath(projectPath, merged);
    const effective = deepMergeConfig(get().globalConfig, merged);
    set({ projectOverrides: merged, config: effective });
  },

}));

// Sync resolved theme -> localStorage + <html> class whenever it changes.
// Runs outside React render so the DOM is always in sync, including for
// the FOUC-prevention script on next load.
useConfigStore.subscribe((state, prevState) => {
  if (state.config.theme !== prevState.config.theme) {
    try { localStorage.setItem('kng-resolved-theme', state.config.theme); } catch { /* localStorage may be unavailable */ }
    const classList = document.documentElement.classList;
    classList.forEach(className => { if (className.startsWith('theme-')) classList.remove(className); });
    if (state.config.theme !== 'dark') classList.add(`theme-${state.config.theme}`);
  }
});
