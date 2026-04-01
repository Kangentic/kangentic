import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { SettingsPanelShell } from './shared';
import type { SettingsContentProps } from './shared';
import { SettingsSearchProvider, computeSearchResults } from './settings-search';
import { APP_TABS, GLOBAL_ONLY_TABS, SettingsContent } from './AppSettingsPanel';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * Unified settings panel. Shows all 7 tabs when a project is open,
 * or only the 3 shared tabs (Behavior, Notifications, Privacy) when
 * no project is selected. No scope toggle; each setting saves to
 * the correct target based on its position relative to the separator.
 */
export function SettingsPanel() {
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);
  const projectSettingsPath = useConfigStore((state) => state.projectSettingsPath);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);
  const detectAgent = useConfigStore((state) => state.detectAgent);
  const loadAgentList = useConfigStore((state) => state.loadAgentList);

  // Determine if we have a project context (either from sidebar gear icon or current project)
  const hasProject = Boolean(projectSettingsPath || currentProject);

  // Show all tabs when a project is available, otherwise only shared tabs
  const tabs = hasProject ? APP_TABS : GLOBAL_ONLY_TABS;

  // Filter registry to match visible tabs
  const registry = useMemo(() => {
    const visibleTabIds = new Set(tabs.map((tab) => tab.id));
    return SETTINGS_REGISTRY.filter((setting) => visibleTabIds.has(setting.tabId));
  }, [tabs]);

  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [activeTab, setActiveTab] = useState(() => {
    const initialTab = useConfigStore.getState().projectSettingsInitialTab;
    if (initialTab) return initialTab;
    return hasProject ? 'appearance' : tabs[0].id;
  });
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells).catch(() => {});
    detectAgent();
    loadAgentList();
  }, []);

  // When opening settings for a different project via sidebar gear icon,
  // pick up the initial tab if set.
  useEffect(() => {
    const initialTab = useConfigStore.getState().projectSettingsInitialTab;
    if (initialTab) {
      const validIds = tabs.map((tab) => tab.id);
      if (validIds.includes(initialTab)) {
        setActiveTab(initialTab);
      }
    }
  }, [projectSettingsPath]);

  // Clamp activeTab when available tabs change (e.g. project opened/closed)
  useEffect(() => {
    const validIds = tabs.map((tab) => tab.id);
    if (!validIds.includes(activeTab)) {
      setActiveTab(validIds[0]);
    }
  }, [tabs, activeTab]);

  // Search computation
  const searchResults = useMemo(
    () => computeSearchResults(searchQuery, registry),
    [searchQuery, registry],
  );
  const isSearching = searchQuery.trim().length > 0;

  /** When clearing search, if results were in exactly one tab, switch to it. */
  const handleSearchChange = useCallback((query: string) => {
    if (!query && searchQuery) {
      const tabsWithMatches = Array.from(searchResults.tabMatchCounts.keys());
      if (tabsWithMatches.length === 1) {
        setActiveTab(tabsWithMatches[0]);
      }
    }
    setSearchQuery(query);
  }, [searchQuery, searchResults.tabMatchCounts]);

  /** Ordered list of tabs that have search matches. */
  const matchingTabs = useMemo(() => {
    if (!isSearching) return [];
    return tabs.filter((tab) => (searchResults.tabMatchCounts.get(tab.id) || 0) > 0);
  }, [isSearching, searchResults.tabMatchCounts, tabs]);

  /** Clear search and navigate to a specific tab. */
  const navigateToTab = useCallback((tabId: string) => {
    setSearchQuery('');
    setActiveTab(tabId);
  }, []);

  const handleClose = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  const contentProps: SettingsContentProps = {
    activeTab,
    isSearching,
    searchQuery,
    matchingTabs,
    navigateToTab,
    shells,
  };

  // Project switcher dropdown: shown when projects exist, allows switching
  // which project's settings are being edited.
  const activeProjectPath = projectSettingsPath || currentProject?.path;
  const projectSwitcher = projects.length > 0 ? (
    <div className="relative">
      <FolderOpen size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
      <select
        value={activeProjectPath || ''}
        onChange={(event) => {
          const selectedProject = projects.find((project) => project.path === event.target.value);
          if (selectedProject) {
            openProjectSettings(selectedProject.path, selectedProject.name);
          }
        }}
        data-testid="settings-project-switcher"
        className="appearance-none bg-surface-hover border border-edge-input rounded pl-7 pr-7 py-1 text-sm text-fg-secondary cursor-pointer hover:border-edge-hover focus:outline-none focus:border-accent max-w-[200px] truncate"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.path}>{project.name}</option>
        ))}
      </select>
      <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
    </div>
  ) : null;

  return (
    <SettingsPanelShell
      onClose={handleClose}
      projectSwitcher={projectSwitcher}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      searchQuery={searchQuery}
      onSearchChange={handleSearchChange}
      tabMatchCounts={searchResults.tabMatchCounts}
      isSearching={isSearching}
    >
      <SettingsSearchProvider query={searchQuery} matchingIds={searchResults.matchingIds}>
        <SettingsContent {...contentProps} />
      </SettingsSearchProvider>
    </SettingsPanelShell>
  );
}
