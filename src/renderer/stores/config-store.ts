import { create } from 'zustand';
import type { AppConfig, DeepPartial, AgentDetectionInfo, OnboardingBaseline, OnboardingStepKey, SerializedWorkspace } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';
import { deepMergeConfig } from '../../shared/object-utils';
import { parseModelId } from '../../shared/model-id';
import { invalidateAllProjects } from './project-cache';

/** Last-viewed settings tab, preserved across HMR (Pattern A) so the panel
 *  reopens to the same section during dogfooding instead of resetting to the
 *  first tab. Session-scoped only: intentionally not persisted across restarts. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let lastSettingsTabHmr: string | null = import.meta.hot?.data?.lastSettingsTab ?? null;

/** Onboarding steps ticked off this session, preserved across HMR (Pattern A).
 *
 *  This state is session-only by design, which means Pattern B cannot rescue it: there is no
 *  main-process truth for `loadConfig()` to re-fetch. So a Fast Refresh of this module (or of
 *  `shared/types.ts`, which it imports) rebuilt the store with an empty map and silently
 *  un-ticked completed steps - including `taskDetailOpened`, step 5's ONLY signal. A dogfooder
 *  editing this very feature would watch the checklist walk backwards. */
// @ts-expect-error -- Vite handles import.meta.hot
let onboardingStepsCompletedHmr: Record<string, OnboardingStepKey[]> = import.meta.hot?.data?.onboardingStepsCompleted ?? {};

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.lastSettingsTab = lastSettingsTabHmr;
    data.onboardingStepsCompleted = onboardingStepsCompletedHmr;
  });
}

/** Throttle for the on-demand model rescan a Model dropdown fires when it opens
 *  (`rescanModels`). Models ship rarely and each forced rescan spawns a fresh
 *  hidden /model PTY probe, so re-opening a dropdown within this window is a
 *  cheap no-op rather than another probe. */
const MODEL_RESCAN_COOLDOWN_MS = 60_000;
// hmr-safe: transient rescan throttle; resetting on HMR at worst allows one extra probe
let modelRescanInFlight = false;
// hmr-safe: transient rescan throttle; resetting on HMR at worst allows one extra probe
let modelRescanLastAtMs = 0;

interface ConfigStore {
  // -- App config --
  config: AppConfig;
  globalConfig: AppConfig;
  loading: boolean;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: DeepPartial<AppConfig>) => Promise<void>;
  /** Dismiss the onboarding checklist for a project (adds its id to `onboardedProjectIds`). */
  markProjectOnboarded: (projectId: string) => void;
  /** Record what a project's watched settings looked like before the user touched them, so
   *  checklist steps 1 and 2 can tick on a real change rather than on a screen being opened.
   *  No-op when a baseline already exists, so re-opening the checklist never re-baselines
   *  (which would silently un-tick work the user already did). */
  captureOnboardingBaseline: (projectId: string, baseline: OnboardingBaseline) => void;
  /** Persist the in-app window layout for a project into global config, keyed by
   *  project id and merged in via `config.set` (so it never clobbers other config).
   *  Decoupled from the Settings panel: the window-manager calls this during normal
   *  board use. Mirrors `selectActiveSession`'s `lastActiveTaskByProject` write. */
  saveWorkspaceForProject: (projectId: string, workspace: SerializedWorkspace) => void;
  /** Synchronous sibling of saveWorkspaceForProject for the quit/unload flush: persists via
   *  the blocking `config.setSync` so the final layout reaches disk before the renderer tears
   *  down (an async set() can be dropped mid-teardown). */
  flushWorkspaceForProject: (projectId: string, workspace: SerializedWorkspace) => void;
  /** Persist the GLOBAL command-terminal window layout (one blob shared across all
   *  projects) into global config via `config.set`, like saveWorkspaceForProject but
   *  not keyed by project. The renderer owns this blob once seeded. */
  saveCommandTerminalWorkspace: (workspace: SerializedWorkspace) => void;
  /** Synchronous sibling of saveCommandTerminalWorkspace for the quit/unload flush. */
  flushCommandTerminalWorkspace: (workspace: SerializedWorkspace) => void;
  /** Internal: whether workspaceByProject has been seeded from disk yet. After the first
   *  config fetch the renderer owns the layout map, so later fetches preserve it instead of
   *  letting a stale disk read clobber an in-flight save. Resets with the store on HMR. */
  workspaceSeeded: boolean;

  // -- App version --
  appVersion: string | null;
  loadAppVersion: () => Promise<void>;

  // -- Git detection --
  gitInfo: { found: boolean; path: string | null; version: string | null; meetsMinimum: boolean } | null;
  detectGit: (forceRefresh?: boolean) => Promise<void>;

  // -- Agent detection --
  agentList: AgentDetectionInfo[];
  agentListLoaded: boolean;
  loadAgentList: (forceRefresh?: boolean) => Promise<void>;

  /** Record a model that's been seen for an agent (live usage event or override
   *  assignment). Idempotent and cheap: no-op when already known. Persists via
   *  `updateConfig` so the next launch starts with the merged set. */
  rememberDiscoveredModel: (agent: string, model: string) => void;

  /** Record the empirically-observed context-window size (tokens) for a model,
   *  learned from a live session's status.json. Keyed by agent + BASE model id
   *  (`[1m]`/dated suffix stripped). No-op on a non-positive size (the "unknown"
   *  sentinel) or when the value is unchanged; otherwise last-observation-wins.
   *  Fire-and-forget persist, so the dropdown context-size badge survives
   *  restarts without re-observing every launch. */
  rememberModelContextWindow: (agent: string, model: string, contextWindowSize: number) => void;

  /** Fire a forced agent-list refresh (`loadAgentList(true)`) so a newly shipped
   *  model surfaces in the open dropdown without a Kangentic restart. Called when
   *  a Model dropdown opens; non-blocking (the caller never awaits it) and
   *  throttled by an in-flight lock plus a cooldown so repeat opens do not spawn
   *  concurrent /model probes. */
  rescanModels: () => void;

  // -- Settings panel UI --
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Open the settings panel directly to a given tab (used by the title-bar
   *  mic button to jump to the global Dictation tab). Works with or without a
   *  project open, since the target may be a shared (global) tab. */
  openSettingsToTab: (tabId: string) => void;
  /** Last settings tab the user viewed, so closing and reopening the panel
   *  returns to the same section instead of resetting to the first tab. */
  lastSettingsTab: string | null;
  setLastSettingsTab: (tabId: string) => void;

  // -- Onboarding checklist + walkthrough (ephemeral UI state, like settingsOpen) --
  /** Whether the checklist dialog is on screen. Distinct from `onboardedProjectIds`:
   *  that records dismissal, this records "is it currently showing". Reopening from the
   *  title bar sets this without un-dismissing the project. */
  onboardingChecklistOpen: boolean;
  setOnboardingChecklistOpen: (open: boolean) => void;
  /** The checklist step currently being spotlighted, or null when the walkthrough layer
   *  is idle. Only ever set by the user clicking a checklist item - nothing auto-advances
   *  into it, and any value here is cleared by Escape or by the step completing. */
  walkthroughStep: OnboardingStepKey | null;
  setWalkthroughStep: (step: OnboardingStepKey | null) => void;
  /** Onboarding steps completed in a way the board and settings cannot evidence, keyed by
   *  project. Two sources feed it: a task detail the user opened (step 5's signal is "a
   *  window exists", true only while one is open, so reading it live would un-tick the step
   *  the moment they closed the window they were told to open), and any step the user ticked
   *  off with the walkthrough's "Next step".
   *
   *  OR-ed with the derived signals, never replacing them - a step still ticks on its own the
   *  moment the real thing happens. Deliberately session-only: onboarding is a first-run flow
   *  that retires itself on completion, so a mid-flow restart is not worth a config key. */
  onboardingStepsCompleted: Record<string, OnboardingStepKey[]>;
  markOnboardingStepCompleted: (projectId: string, step: OnboardingStepKey) => void;

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

export const useConfigStore = create<ConfigStore>((set, get) => {
  /** Overlay freshly-fetched configs, preserving the renderer-authoritative workspaceByProject
   *  after the first (seeding) fetch so a stale disk read can never revert the live layout. The
   *  renderer is the SOLE writer of workspaceByProject (saveWorkspaceForProject updates it
   *  optimistically + persists async, the quit flush persists it synchronously), so once seeded
   *  from disk its in-memory map is always at least as fresh as disk for every project. The
   *  `workspaceSeeded` flag lives in store state so it resets with the store on HMR, where the
   *  post-HMR loadConfig (Pattern B) re-seeds from disk. */
  const withSeededWorkspace = (
    fetched: { config: AppConfig; globalConfig: AppConfig },
  ): { config: AppConfig; globalConfig: AppConfig; workspaceSeeded?: boolean } => {
    if (!get().workspaceSeeded) {
      return { ...fetched, workspaceSeeded: true };
    }
    // Renderer-authoritative blobs: once seeded from disk, the live store is always
    // at least as fresh as a later disk read, so preserve them across a refetch.
    const workspaceByProject = get().globalConfig.workspaceByProject ?? {};
    const commandTerminalWorkspace = get().globalConfig.commandTerminalWorkspace ?? null;
    return {
      config: { ...fetched.config, workspaceByProject, commandTerminalWorkspace },
      globalConfig: { ...fetched.globalConfig, workspaceByProject, commandTerminalWorkspace },
    };
  };

  /** Apply an optimistic workspace update to both effective + global config and return the
   *  merged map, so the IPC write persists exactly what the store now shows. */
  const applyWorkspaceOptimistic = (
    projectId: string,
    workspace: SerializedWorkspace,
  ): Record<string, SerializedWorkspace> => {
    const existing = get().globalConfig.workspaceByProject ?? {};
    const updated = { ...existing, [projectId]: workspace };
    set((state) => ({
      config: { ...state.config, workspaceByProject: updated },
      globalConfig: { ...state.globalConfig, workspaceByProject: updated },
    }));
    return updated;
  };

  /** Optimistically apply the global command-terminal layout to both effective +
   *  global config so a follow-on read sees the value just written, and return it
   *  so the IPC write persists exactly what the store now shows. */
  const applyCommandWorkspaceOptimistic = (workspace: SerializedWorkspace): SerializedWorkspace => {
    set((state) => ({
      config: { ...state.config, commandTerminalWorkspace: workspace },
      globalConfig: { ...state.globalConfig, commandTerminalWorkspace: workspace },
    }));
    return workspace;
  };

  return {
    config: DEFAULT_CONFIG,
    globalConfig: DEFAULT_CONFIG,
    appVersion: null,
    agentList: [],
    agentListLoaded: false,
    gitInfo: null,
    loading: true,
    workspaceSeeded: false,
    settingsOpen: false,
    lastSettingsTab: lastSettingsTabHmr,
    onboardingChecklistOpen: false,
    walkthroughStep: null,
    onboardingStepsCompleted: onboardingStepsCompletedHmr,
    projectSettingsPath: null,
    projectSettingsProjectName: null,
    projectSettingsInitialTab: null,
    projectOverrides: null,
    loadConfig: async () => {
      set({ loading: true });
      const configs = await refreshConfigs();
      set({ ...withSeededWorkspace(configs), loading: false });
    },

    updateConfig: async (partial) => {
      await window.electronAPI.config.set(partial);
      const configs = await refreshConfigs();
      set(withSeededWorkspace(configs));
      // Global settings can change every project's effective config, so
      // any cached warm-switch snapshot is now stale. The active project's
      // live config was just updated above; cached non-current projects
      // need to be invalidated so a future switch refetches.
      invalidateAllProjects();
      // Re-detect agents when CLI path settings change so the UI
      // updates immediately instead of requiring an app restart. CONFIG_SET
      // already invalidated the detection + list caches server-side, so a
      // plain (non-forced) reload is enough to pick up the new cliPaths.
      if (partial.agent) {
        get().loadAgentList();
      }
    },

    markProjectOnboarded: (projectId) => {
      const existing = get().config.onboardedProjectIds ?? [];
      if (existing.includes(projectId)) return;
      get().updateConfig({ onboardedProjectIds: [...existing, projectId] });
    },

    captureOnboardingBaseline: (projectId, baseline) => {
      // First write wins. A later capture would re-baseline against settings the user has
      // ALREADY changed, which would un-tick steps 1 and 2 and lose real progress.
      const existing = get().config.onboardingBaseline ?? {};
      if (existing[projectId]) return;
      // `onboardingBaseline` is a CONFIG_DICTIONARY_PATH, so this write REPLACES the map
      // rather than merging into it - send every project's entry, not just this one, or
      // the others are dropped. Same contract as saveWorkspaceForProject.
      get().updateConfig({ onboardingBaseline: { ...existing, [projectId]: baseline } });
    },

    saveWorkspaceForProject: (projectId, workspace) => {
      // Optimistically update the local config (both effective + global) so back-to-back
      // saves and a follow-on project-switch restore read the value just written rather
      // than a pre-IPC stale snapshot, then persist async.
      window.electronAPI.config.set({ workspaceByProject: applyWorkspaceOptimistic(projectId, workspace) });
    },

    flushWorkspaceForProject: (projectId, workspace) => {
      // Quit/unload path: same optimistic update as the async save, but persisted
      // synchronously so the final layout reaches disk before the renderer tears down.
      window.electronAPI.config.setSync({ workspaceByProject: applyWorkspaceOptimistic(projectId, workspace) });
    },

    saveCommandTerminalWorkspace: (workspace) => {
      window.electronAPI.config.set({ commandTerminalWorkspace: applyCommandWorkspaceOptimistic(workspace) });
    },

    flushCommandTerminalWorkspace: (workspace) => {
      window.electronAPI.config.setSync({ commandTerminalWorkspace: applyCommandWorkspaceOptimistic(workspace) });
    },

    loadAppVersion: async () => {
      const appVersion = await window.electronAPI.app.getVersion();
      set({ appVersion });
    },

    detectGit: async (forceRefresh?: boolean) => {
      const gitInfo = await window.electronAPI.git.detect(forceRefresh);
      set({ gitInfo });
    },

    loadAgentList: async (forceRefresh?: boolean) => {
      const agentList = await window.electronAPI.agents.list(forceRefresh);
      set({ agentList, agentListLoaded: true });

      // Seed the discovered-models cache from `capabilities.models` so every
      // launch starts with at least the JSONL-walk result merged in. Only writes
      // when there's actually new material - avoids a config round-trip on every
      // detection refresh.
      const current = get().config.discoveredModelsByAgent ?? {};
      const updates: Record<string, string[]> = {};
      for (const info of agentList) {
        const fresh = info.capabilities?.models;
        if (!fresh || fresh.length === 0) continue;
        const existing = current[info.name] ?? [];
        const union = new Set<string>([...existing, ...fresh]);
        if (union.size > existing.length) {
          updates[info.name] = Array.from(union).sort((a, b) => a.localeCompare(b));
        }
      }
      if (Object.keys(updates).length > 0) {
        get().updateConfig({
          discoveredModelsByAgent: { ...current, ...updates },
        });
      }
    },

    rememberDiscoveredModel: (agent, model) => {
      if (!agent || !model) return;
      const current = get().config.discoveredModelsByAgent ?? {};
      const existing = current[agent] ?? [];
      if (existing.includes(model)) return;
      const next = [...existing, model].sort((a, b) => a.localeCompare(b));
      // Fire-and-forget: this is a cache write, not a user-driven setting. If the
      // persist fails the in-memory effective config will still pick up the new
      // value via deepMergeConfig on the next refresh.
      get().updateConfig({
        discoveredModelsByAgent: { ...current, [agent]: next },
      }).catch(() => undefined);
    },

    rememberModelContextWindow: (agent, model, contextWindowSize) => {
      // 0 is the "unknown window" sentinel (transcript-fallback telemetry emits
      // it because the window is not derivable from a model id); only a real
      // status.json observation carries a positive size.
      if (!agent || !model || !(contextWindowSize > 0)) return;
      // Key by base id so a plain id, its `[1m]` variant, and dated pins share
      // one window (a model+account constant).
      const baseId = parseModelId(model).baseId;
      const byAgent = get().config.discoveredContextWindowsByAgent ?? {};
      const forAgent = byAgent[agent] ?? {};
      if (forAgent[baseId] === contextWindowSize) return; // unchanged: no write
      // Fire-and-forget cache write (not a user-driven setting), last-wins so an
      // entitlement change re-baselines the badge.
      get().updateConfig({
        discoveredContextWindowsByAgent: {
          ...byAgent,
          [agent]: { ...forAgent, [baseId]: contextWindowSize },
        },
      }).catch(() => undefined);
    },

    rescanModels: () => {
      // In-flight lock + cooldown: a Model dropdown can open many times a
      // session (tabbing through a form, reopening the picker), and each forced
      // rescan re-probes every agent's CLI plus spawns a hidden /model PTY
      // probe. Collapse those into at most one probe per cooldown window.
      if (modelRescanInFlight) return;
      if (Date.now() - modelRescanLastAtMs < MODEL_RESCAN_COOLDOWN_MS) return;
      modelRescanInFlight = true;
      // Fire-and-forget: the dropdown already shows the current list and
      // re-renders via useKnownModels once loadAgentList resolves (~2s), so the
      // UI never blocks on the probe round trip.
      get().loadAgentList(true).catch(() => undefined).finally(() => {
        modelRescanInFlight = false;
        modelRescanLastAtMs = Date.now();
      });
    },

    setOnboardingChecklistOpen: (open) => {
      // Deliberately does NOT touch walkthroughStep. Clicking a step CLOSES the checklist
      // (to get out of the way of the surface it just opened) and starts a spotlight, so
      // clearing the step here would destroy the spotlight the click just asked for. The
      // walkthrough is ended by Escape, its own skip control, the step completing, or its
      // target disappearing - never by the list closing.
      set({ onboardingChecklistOpen: open });
    },

    setWalkthroughStep: (step) => {
      set({ walkthroughStep: step });
    },

    markOnboardingStepCompleted: (projectId, step) => {
      set((state) => {
        const existing = state.onboardingStepsCompleted[projectId] ?? [];
        if (existing.includes(step)) return state;
        // Dual-write the module mirror, same as setLastSettingsTab: it is what survives the
        // Fast Refresh that rebuilds this store.
        onboardingStepsCompletedHmr = {
          ...state.onboardingStepsCompleted,
          [projectId]: [...existing, step],
        };
        return { onboardingStepsCompleted: onboardingStepsCompletedHmr };
      });
    },

    openSettingsToTab: (tabId) => {
      set({ settingsOpen: true, projectSettingsInitialTab: tabId });
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
        refreshConfigs().then((configs) => set(withSeededWorkspace(configs)));
      }
    },

    setLastSettingsTab: (tabId) => {
      lastSettingsTabHmr = tabId;
      set({ lastSettingsTab: tabId });
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

  };
});

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

// Toggle CSS keyframe animations via .no-motion class on <html>.
useConfigStore.subscribe((state, prevState) => {
  if (state.config.animationsEnabled !== prevState.config.animationsEnabled) {
    document.documentElement.classList.toggle('no-motion', !state.config.animationsEnabled);
  }
});
