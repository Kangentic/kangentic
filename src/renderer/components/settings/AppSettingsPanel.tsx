import { useCallback, useMemo, useRef } from 'react';
import type { ElementType } from 'react';
import { Bell, Bot, Brain, Bug, FolderCog, GitBranch, GitCompare, Globe, Keyboard, LayoutGrid, Mic, MousePointerClick, Palette, Plug, ShieldCheck, SlidersHorizontal, Smartphone, SquareKanban, Terminal, Zap } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { SettingsPanelProvider, SearchTabGroupHeader, NoSearchResults } from './shared';
import type { SettingsTabDefinition, SettingScope, SettingsContentProps } from './shared';
import { SETTINGS_TABS } from './settings-tabs';
import type { AppConfig, DeepPartial } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { TerminalTab } from './tabs/TerminalTab';
import { AgentTab } from './tabs/AgentTab';
import { GitTab } from './tabs/GitTab';
import { BrowserTab } from './tabs/BrowserTab';
import { BoardTab } from './tabs/BoardTab';
import { TaskTab } from './tabs/TaskTab';
import { ChangesTab } from './tabs/ChangesTab';
import { BehaviorTab } from './tabs/BehaviorTab';
import { DictationTab } from './tabs/DictationTab';
import { McpServerTab } from './tabs/McpServerTab';
import { BrowserAutomationTab } from './tabs/BrowserAutomationTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { MobileDevicesTab } from './tabs/MobileDevicesTab';
import { MemoryTab } from './tabs/MemoryTab';
import { PrivacyTab } from './tabs/PrivacyTab';
import { DeveloperTab } from './tabs/DeveloperTab';
import { HotkeysTab } from './tabs/HotkeysTab';
import { GeneralTab } from './tabs/GeneralTab';
import { ThemeTab } from './tabs/ThemeTab';

/** How long one setting stays quiet after its failed-write toast. Deliberately aligned
 *  with the cooldown on notifySpawnWarning (`src/main/ipc/helpers/task-git.ts`), which
 *  solves the same problem: a notice about a CONDITION must not fire once per event.
 *  The two are separate literals, not derived from one constant, so neither enforces the
 *  other - they are the same number because the judgement is the same, not by parity. */
const FAILED_WRITE_TOAST_COOLDOWN_MS = 60_000;

/**
 * The dot-path of the leaf a settings partial writes, e.g. `git.initScript`. Used as the
 * failed-write toast's cooldown bucket.
 *
 * It must be the LEAF, not `Object.keys(partial)[0]`. Nearly every setting lives under a
 * nested parent, so a top-level key buckets a whole tab: a failed `git.worktreesEnabled`
 * would then silence `git.initScript` failing ten seconds later, which is the exact
 * silence the per-key bucket exists to remove.
 *
 * The walk stops at the first level that is not a single plain-object key, so an array
 * value (`git.copyFiles`) and a multi-key partial both end the path where they are.
 */
function settingCooldownKey(partial: DeepPartial<AppConfig>): string {
  const segments: string[] = [];
  let currentLevel: unknown = partial;
  while (currentLevel && typeof currentLevel === 'object' && !Array.isArray(currentLevel)) {
    const keys = Object.keys(currentLevel as Record<string, unknown>);
    if (keys.length !== 1) break;
    segments.push(keys[0]);
    currentLevel = (currentLevel as Record<string, unknown>)[keys[0]];
  }
  return segments.length > 0 ? segments.join('.') : 'config';
}

/** Icon for each tab id. Kept separate from settings-tabs.ts so that JSX-free
 *  module can be imported by tests/unit without pulling in lucide-react. */
const TAB_ICONS: Record<string, ElementType> = {
  general: FolderCog,
  theme: Palette,
  terminal: Terminal,
  agent: Bot,
  git: GitBranch,
  browser: Globe,
  shortcuts: Zap,
  board: LayoutGrid,
  task: SquareKanban,
  changes: GitCompare,
  behavior: SlidersHorizontal,
  dictation: Mic,
  memory: Brain,
  hotkeys: Keyboard,
  mcpServer: Plug,
  browserAutomation: MousePointerClick,
  notifications: Bell,
  mobile: Smartphone,
  privacy: ShieldCheck,
  developer: Bug,
};

/**
 * Settings tab layout:
 *
 * Tabs whose `category` is 'project' (see settings-tabs.ts) are per-project
 * settings. When a project is open, changes save to the project's override
 * file. These tabs are hidden when no project is selected.
 *
 * Tabs whose `category` is 'system' are shared settings that apply across
 * all projects. They save to the global config, and MUST remain fully
 * functional with no project open (.claude/rules/settings-tab-scope.md).
 */
export const APP_TABS: SettingsTabDefinition[] = SETTINGS_TABS.map((tab) => ({
  ...tab,
  icon: TAB_ICONS[tab.id],
}));

/** Shared-only tabs (category 'system'). Shown even when no project is open. */
export const GLOBAL_ONLY_TABS = APP_TABS.filter((tab) => tab.category === 'system');

/**
 * Unified settings content. Rendered inside the SettingsPanel shell.
 *
 * For per-project tabs (category 'project'): reads from effectiveConfig
 * (global merged with project overrides), writes to project overrides.
 *
 * For shared tabs (category 'system'): reads from globalConfig, writes
 * to global config. These settings apply across all projects.
 *
 * Individual tab bodies live under ./tabs/; this file owns the tab
 * registry and the active/search dispatcher.
 */
export function SettingsContent({ activeTab, isSearching, searchQuery, matchingTabs, navigateToTab, shells, fonts }: SettingsContentProps) {
  const globalConfig = useConfigStore((state) => state.globalConfig);
  const projectOverrides = useConfigStore((state) => state.projectOverrides);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const updateProjectOverride = useConfigStore((state) => state.updateProjectOverride);
  const agentList = useConfigStore((state) => state.agentList);

  // Effective config for per-project tabs: global merged with project overrides
  const effectiveConfig = useMemo(
    () => projectOverrides ? deepMergeConfig(globalConfig, projectOverrides) as AppConfig : globalConfig,
    [globalConfig, projectOverrides],
  );

  /** When each setting last raised a failed-write toast, keyed by leaf dot-path. Keyed
   *  per setting, not a single timestamp: a plain timer would let one setting's toast
   *  silence a DIFFERENT setting failing seconds later, which is the silence this exists
   *  to remove. Bounded by the number of settings the panel can write, so it needs no
   *  pruning for the life of the panel. */
  const lastFailureToastByKeyRef = useRef<Map<string, number>>(new Map());

  /** Route updates to the correct target based on scope, and tell the user when the
   *  write did not reach disk.
   *
   *  Main already reports the machine-level condition once per failing source
   *  (`config:writeFailed`), but that one notice is usually spent on the 500 ms
   *  window-bounds debounce, which is by far the busiest writer of source `config`.
   *  After it fires, every settings change for the rest of the session was silent: the
   *  panel accepted the value and it never persisted. Sentry DESKTOP-1C.
   *
   *  This is the only caller that knows a write represents a deliberate user gesture -
   *  `config.set` also carries window layouts, model caches and announcement
   *  dismissals - which is why the check lives here and not in the IPC handler. */
  const updateSetting = useCallback((partial: DeepPartial<AppConfig>, scope: SettingScope) => {
    const reportFailure = (message: string) => {
      // One user gesture can still be many writes: NUMBER fields commit on every
      // keystroke (typing "120" writes 1, then 12, then 120), the Theme tab commits on
      // every arrow key, and the CLI path and remote-execution fields stay per-keystroke
      // by design (see SettingTextInput). Without this an outage toasts per character.
      // Collapse per setting, matching the 60s cooldown notifySpawnWarning uses for the
      // same "per condition, not per event" reason.
      const settingKey = settingCooldownKey(partial);
      const lastAt = lastFailureToastByKeyRef.current.get(settingKey) ?? 0;
      if (Date.now() - lastAt < FAILED_WRITE_TOAST_COOLDOWN_MS) return;
      lastFailureToastByKeyRef.current.set(settingKey, Date.now());
      useToastStore.getState().addToast({ message, variant: 'error', duration: 12000 });
    };

    const write = scope === 'project' ? updateProjectOverride(partial) : updateConfig(partial);
    void write.then(
      ({ persisted }) => {
        if (persisted) return;
        // Deliberately NOT the same sentence main pushes. That one names the machine
        // condition ("...because the disk is full"); this one names what the user just
        // did. On the first failure of an outage both can be up, and they read as one
        // cause and one consequence rather than as the same bug twice.
        reportFailure('This setting did not save. Kangentic could not write to its data folder.');
      },
      // A REJECTED write is a different failure from a write that degraded: the two
      // project-scoped channels throw for an unknown or unopened project. It used to
      // land as a silent unhandled rejection, which is the same class of bug as the
      // one above. No data-folder clause, because that is not what went wrong.
      //
      // It shares the degraded path's per-key cooldown deliberately, rather than
      // keeping its own. The cooldown is keyed to the fact the user needs ("this
      // setting did not save"), which is identical either way; the clause only
      // explains it. Giving each branch its own timer would toast twice for one
      // setting that is failing for two reasons at once.
      () => reportFailure('This setting did not save.'),
    );
  }, [updateProjectOverride, updateConfig]);

  const renderTab = (tabId: string) => {
    switch (tabId) {
      case 'general': return <GeneralTab />;
      case 'theme': return <ThemeTab config={effectiveConfig} />;
      case 'terminal': return <TerminalTab config={effectiveConfig} globalConfig={globalConfig} shells={shells} fonts={fonts} />;
      case 'agent': return <AgentTab config={effectiveConfig} globalConfig={globalConfig} agentList={agentList} />;
      case 'git': return <GitTab config={effectiveConfig} />;
      case 'browser': return <BrowserTab config={effectiveConfig} />;
      case 'shortcuts': return <ShortcutsTab />;
      case 'developer': return <DeveloperTab globalConfig={globalConfig} />;
      case 'board': return <BoardTab globalConfig={globalConfig} />;
      case 'task': return <TaskTab globalConfig={globalConfig} />;
      case 'changes': return <ChangesTab globalConfig={globalConfig} />;
      case 'behavior': return <BehaviorTab globalConfig={globalConfig} />;
      case 'dictation': return <DictationTab globalConfig={globalConfig} onOpenHotkeys={() => navigateToTab('hotkeys')} />;
      case 'hotkeys': return <HotkeysTab globalConfig={globalConfig} />;
      case 'mcpServer': return <McpServerTab globalConfig={globalConfig} />;
      case 'browserAutomation': return <BrowserAutomationTab globalConfig={globalConfig} />;
      case 'notifications': return <NotificationsTab globalConfig={globalConfig} />;
      case 'mobile': return <MobileDevicesTab globalConfig={globalConfig} />;
      case 'memory': return <MemoryTab globalConfig={globalConfig} />;
      case 'privacy': return <PrivacyTab />;
      default: return null;
    }
  };

  return (
    <SettingsPanelProvider value={{ updateSetting }}>
      {isSearching ? (
        // Search mode: render all matching tabs stacked
        matchingTabs.length > 0 ? (
          matchingTabs.map((tab, index) => (
            <div key={tab.id}>
              <SearchTabGroupHeader tab={tab} first={index === 0} onNavigate={navigateToTab} />
              <div className="space-y-4">
                {renderTab(tab.id)}
              </div>
            </div>
          ))
        ) : (
          <NoSearchResults query={searchQuery} />
        )
      ) : (
        // Normal mode: single active tab
        renderTab(activeTab)
      )}
    </SettingsPanelProvider>
  );
}
