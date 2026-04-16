import { useCallback, useMemo } from 'react';
import { Bell, Bot, GitBranch, LayoutGrid, Palette, Plug, ShieldCheck, SlidersHorizontal, Terminal, Zap } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { SettingsPanelProvider, SearchTabGroupHeader, NoSearchResults } from './shared';
import type { SettingsTabDefinition, SettingScope, SettingsContentProps } from './shared';
import type { AppConfig, DeepPartial } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { ThemeTab } from './tabs/ThemeTab';
import { TerminalTab } from './tabs/TerminalTab';
import { AgentTab } from './tabs/AgentTab';
import { GitTab } from './tabs/GitTab';
import { LayoutTab } from './tabs/LayoutTab';
import { BehaviorTab } from './tabs/BehaviorTab';
import { McpServerTab } from './tabs/McpServerTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { PrivacyTab } from './tabs/PrivacyTab';

/**
 * Settings tab layout:
 *
 * Tabs ABOVE the separator are per-project settings. When a project is open,
 * changes save to the project's override file. These tabs are hidden when
 * no project is selected.
 *
 * Tabs BELOW the separator (after `separator: true`) are shared settings
 * that apply across all projects. They save to the global config.
 */
export const APP_TABS: SettingsTabDefinition[] = [
  // -- Per-project settings --
  { id: 'theme', label: 'Theme', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'shortcuts', label: 'Shortcuts', icon: Zap },
  // -- Shared settings (separator marks the boundary) --
  { id: 'layout', label: 'Layout', icon: LayoutGrid, separator: true, tooltip: 'Applies to all projects' },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal, tooltip: 'Applies to all projects' },
  { id: 'mcpServer', label: 'MCP Server', icon: Plug, tooltip: 'Applies to all projects' },
  { id: 'notifications', label: 'Notifications', icon: Bell, tooltip: 'Applies to all projects' },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, tooltip: 'Applies to all projects' },
];

/** Separator index: tabs before this are per-project, tabs at/after are shared. */
const SEPARATOR_INDEX = APP_TABS.findIndex((tab) => tab.separator);

/** Shared-only tabs (below separator). Shown even when no project is open. */
export const GLOBAL_ONLY_TABS = APP_TABS.slice(SEPARATOR_INDEX);

/**
 * Unified settings content. Rendered inside the SettingsPanel shell.
 *
 * For per-project tabs (above separator): reads from effectiveConfig
 * (global merged with project overrides), writes to project overrides.
 *
 * For shared tabs (below separator): reads from globalConfig, writes
 * to global config. These settings apply across all projects.
 *
 * Individual tab bodies live under ./tabs/; this file owns the tab
 * registry and the active/search dispatcher.
 */
export function SettingsContent({ activeTab, isSearching, searchQuery, matchingTabs, navigateToTab, shells }: SettingsContentProps) {
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
      case 'theme': return <ThemeTab config={effectiveConfig} />;
      case 'terminal': return <TerminalTab config={effectiveConfig} globalConfig={globalConfig} shells={shells} />;
      case 'agent': return <AgentTab config={effectiveConfig} globalConfig={globalConfig} agentInfo={agentInfo} agentList={agentList} />;
      case 'git': return <GitTab config={effectiveConfig} />;
      case 'shortcuts': return <ShortcutsTab />;
      case 'layout': return <LayoutTab globalConfig={globalConfig} />;
      case 'behavior': return <BehaviorTab globalConfig={globalConfig} />;
      case 'mcpServer': return <McpServerTab globalConfig={globalConfig} />;
      case 'notifications': return <NotificationsTab globalConfig={globalConfig} />;
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
