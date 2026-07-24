import { useCallback, useMemo } from 'react';
import type { ElementType } from 'react';
import { Bell, Bot, Brain, Bug, FolderCog, GitBranch, GitCompare, Globe, Keyboard, LayoutGrid, Mic, MousePointerClick, Palette, Plug, ShieldCheck, SlidersHorizontal, Smartphone, SquareKanban, Terminal, Zap } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
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
  const agentInfo = useConfigStore((state) => state.agentInfo);
  const agentList = useConfigStore((state) => state.agentList);

  // Effective config for per-project tabs: global merged with project overrides
  const effectiveConfig = useMemo(
    () => projectOverrides ? deepMergeConfig(globalConfig, projectOverrides) as AppConfig : globalConfig,
    [globalConfig, projectOverrides],
  );

  /** Route updates to the correct target based on scope. */
  const updateSetting = useCallback((partial: DeepPartial<AppConfig>, scope: SettingScope) => {
    if (scope === 'project') {
      updateProjectOverride(partial);
    } else {
      updateConfig(partial);
    }
  }, [updateProjectOverride, updateConfig]);

  const renderTab = (tabId: string) => {
    switch (tabId) {
      case 'general': return <GeneralTab />;
      case 'theme': return <ThemeTab config={effectiveConfig} />;
      case 'terminal': return <TerminalTab config={effectiveConfig} globalConfig={globalConfig} shells={shells} fonts={fonts} />;
      case 'agent': return <AgentTab config={effectiveConfig} globalConfig={globalConfig} agentInfo={agentInfo} agentList={agentList} />;
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
