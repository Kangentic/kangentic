import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, FolderOpen, GitBranch, Palette, Terminal } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { SettingsPanelShell, SettingsPanelProvider, SettingRow, Select, ToggleSwitch, ResetOverridesFooter, INPUT_CLASS, useScopedUpdate, SearchTabGroupHeader, NoSearchResults } from './shared';
import type { SettingsTabDefinition } from './shared';
import type { AppConfig, DeepPartial, PermissionMode, ThemeMode } from '../../../shared/types';
import { NAMED_THEMES } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';
import { SETTINGS_REGISTRY, settingProps } from './settings-registry';
import { SettingsSearchProvider, computeSearchResults } from './settings-search';

/**
 * Project Settings only shows tabs that are project-overridable (the tabs
 * above the separator in AppSettingsPanel). Global-only tabs like Behavior,
 * Notifications, and Privacy are NOT shown here.
 */
const PROJECT_TABS: SettingsTabDefinition[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
];

/** Only project-overridable settings for search. */
const PROJECT_TAB_IDS = new Set(PROJECT_TABS.map((tab) => tab.id));
const PROJECT_REGISTRY = SETTINGS_REGISTRY.filter(
  (setting) => PROJECT_TAB_IDS.has(setting.tabId) && setting.scope === 'project',
);

export function ProjectSettingsPanel() {
  const globalConfig = useConfigStore((state) => state.globalConfig);
  const projectSettingsProjectName = useConfigStore((state) => state.projectSettingsProjectName);
  const projectOverrides = useConfigStore((state) => state.projectOverrides);
  const updateProjectOverride = useConfigStore((state) => state.updateProjectOverride);
  const removeProjectOverride = useConfigStore((state) => state.removeProjectOverride);
  const resetAllProjectOverrides = useConfigStore((state) => state.resetAllProjectOverrides);
  const isOverridden = useConfigStore((state) => state.isOverridden);
  const setProjectSettingsOpen = useConfigStore((state) => state.setProjectSettingsOpen);

  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells).catch(() => {});
  }, []);

  const handleClose = () => setProjectSettingsOpen(false);

  const displayConfig = projectOverrides
    ? deepMergeConfig(globalConfig, projectOverrides)
    : globalConfig;

  /** In the project panel, scope is ignored -- all updates write to project overrides. */
  const updateSetting = (partial: DeepPartial<AppConfig>) => {
    updateProjectOverride(partial);
  };

  const hasAnyOverrides = projectOverrides != null && Object.keys(projectOverrides).length > 0;

  /** Format a global default value for display as an inherited hint. */
  const defaultHint = (value: unknown): string => {
    if (value === null || value === undefined) return 'Auto-detect';
    if (typeof value === 'boolean') return value ? 'On' : 'Off';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
    return String(value);
  };

  const [activeTab, setActiveTab] = useState('appearance');

  // Search computation
  const searchResults = useMemo(
    () => computeSearchResults(searchQuery, PROJECT_REGISTRY),
    [searchQuery],
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
    return PROJECT_TABS.filter((tab) => (searchResults.tabMatchCounts.get(tab.id) || 0) > 0);
  }, [isSearching, searchResults.tabMatchCounts]);

  /** Clear search and navigate to a specific tab. */
  const navigateToTab = useCallback((tabId: string) => {
    setSearchQuery('');
    setActiveTab(tabId);
  }, []);

  const resetFooter = hasAnyOverrides ? (
    <ResetOverridesFooter onReset={resetAllProjectOverrides} />
  ) : undefined;

  return (
    <SettingsPanelProvider value={{ panelType: 'project', updateSetting }}>
      <SettingsSearchProvider query={searchQuery} matchingIds={searchResults.matchingIds}>
        <SettingsPanelShell
          subtitle={projectSettingsProjectName ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-accent/10 text-accent text-xs">
              <FolderOpen size={14} />
              {projectSettingsProjectName}
            </span>
          ) : undefined}
          onClose={handleClose}
          tabs={PROJECT_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          footer={resetFooter}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          tabMatchCounts={searchResults.tabMatchCounts}
          isSearching={isSearching}
        >
          {isSearching ? (
            // Search mode: render all matching tabs stacked
            matchingTabs.length > 0 ? (
              matchingTabs.map((tab, index) => (
                <div key={tab.id}>
                  <SearchTabGroupHeader tab={tab} first={index === 0} onNavigate={navigateToTab} />
                  <div className="space-y-4">
                    {tab.id === 'appearance' && (
                      <AppearanceTabProject
                        displayConfig={displayConfig}
                        globalConfig={globalConfig}
                        isOverridden={isOverridden}
                        removeProjectOverride={removeProjectOverride}
                        updateProjectOverride={updateProjectOverride}
                        defaultHint={defaultHint}
                      />
                    )}
                    {tab.id === 'terminal' && (
                      <TerminalTabProject
                        displayConfig={displayConfig}
                        globalConfig={globalConfig}
                        shells={shells}
                        isOverridden={isOverridden}
                        removeProjectOverride={removeProjectOverride}
                        updateProjectOverride={updateProjectOverride}
                        defaultHint={defaultHint}
                      />
                    )}
                    {tab.id === 'agent' && (
                      <AgentTabProject
                        displayConfig={displayConfig}
                        globalConfig={globalConfig}
                        isOverridden={isOverridden}
                        removeProjectOverride={removeProjectOverride}
                        updateProjectOverride={updateProjectOverride}
                        defaultHint={defaultHint}
                      />
                    )}
                    {tab.id === 'git' && (
                      <GitTabProject
                        displayConfig={displayConfig}
                        globalConfig={globalConfig}
                        isOverridden={isOverridden}
                        removeProjectOverride={removeProjectOverride}
                        updateProjectOverride={updateProjectOverride}
                        defaultHint={defaultHint}
                      />
                    )}
                  </div>
                </div>
              ))
            ) : (
              <NoSearchResults query={searchQuery} />
            )
          ) : (
            // Normal mode: single active tab
            <>
              {activeTab === 'appearance' && (
                <AppearanceTabProject
                  displayConfig={displayConfig}
                  globalConfig={globalConfig}
                  isOverridden={isOverridden}
                  removeProjectOverride={removeProjectOverride}
                  updateProjectOverride={updateProjectOverride}
                  defaultHint={defaultHint}
                />
              )}
              {activeTab === 'terminal' && (
                <TerminalTabProject
                  displayConfig={displayConfig}
                  globalConfig={globalConfig}
                  shells={shells}
                  isOverridden={isOverridden}
                  removeProjectOverride={removeProjectOverride}
                  updateProjectOverride={updateProjectOverride}
                  defaultHint={defaultHint}
                />
              )}
              {activeTab === 'agent' && (
                <AgentTabProject
                  displayConfig={displayConfig}
                  globalConfig={globalConfig}
                  isOverridden={isOverridden}
                  removeProjectOverride={removeProjectOverride}
                  updateProjectOverride={updateProjectOverride}
                  defaultHint={defaultHint}
                />
              )}
              {activeTab === 'git' && (
                <GitTabProject
                  displayConfig={displayConfig}
                  globalConfig={globalConfig}
                  isOverridden={isOverridden}
                  removeProjectOverride={removeProjectOverride}
                  updateProjectOverride={updateProjectOverride}
                  defaultHint={defaultHint}
                />
              )}
            </>
          )}
        </SettingsPanelShell>
      </SettingsSearchProvider>
    </SettingsPanelProvider>
  );
}

/* ── Tab Components ── */

interface ProjectTabProps {
  displayConfig: AppConfig;
  globalConfig: AppConfig;
  isOverridden: (path: string) => boolean;
  removeProjectOverride: (path: string) => void;
  updateProjectOverride: (partial: DeepPartial<AppConfig>) => void;
  defaultHint: (value: unknown) => string;
}

function AppearanceTabProject({ displayConfig, globalConfig, isOverridden, removeProjectOverride, updateProjectOverride, defaultHint }: ProjectTabProps) {
  return (
    <SettingRow
      {...settingProps('theme')}
      isOverridden={isOverridden('theme')}
      onReset={() => removeProjectOverride('theme')}
      inheritedHint={defaultHint(globalConfig.theme)}
    >
      <Select
        value={displayConfig.theme}
        onChange={(event) => updateProjectOverride({ theme: event.target.value as ThemeMode })}
      >
        <optgroup label="Standard">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </optgroup>
        <optgroup label="Dark Palette">
          {NAMED_THEMES.filter(theme => theme.base === 'dark').map(theme => (
            <option key={theme.id} value={theme.id}>{theme.label}</option>
          ))}
        </optgroup>
        <optgroup label="Light Palette">
          {NAMED_THEMES.filter(theme => theme.base === 'light').map(theme => (
            <option key={theme.id} value={theme.id}>{theme.label}</option>
          ))}
        </optgroup>
      </Select>
    </SettingRow>
  );
}

interface TerminalTabProjectProps extends ProjectTabProps {
  shells: Array<{ name: string; path: string }>;
}

function TerminalTabProject({ displayConfig, globalConfig, shells, isOverridden, removeProjectOverride, updateProjectOverride, defaultHint }: TerminalTabProjectProps) {
  return (
    <>
      <SettingRow
        {...settingProps('terminal.shell')}
        isOverridden={isOverridden('terminal.shell')}
        onReset={() => removeProjectOverride('terminal.shell')}
        inheritedHint={defaultHint(globalConfig.terminal.shell)}
      >
        <Select
          value={displayConfig.terminal.shell || ''}
          onChange={(event) => updateProjectOverride({ terminal: { shell: event.target.value || null } })}
        >
          <option value="">Auto-detect</option>
          {shells.map((shell) => (
            <option key={shell.path} value={shell.path}>{shell.name}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        {...settingProps('terminal.fontSize')}
        isOverridden={isOverridden('terminal.fontSize')}
        onReset={() => removeProjectOverride('terminal.fontSize')}
        inheritedHint={defaultHint(globalConfig.terminal.fontSize)}
      >
        <input
          type="number"
          value={displayConfig.terminal.fontSize}
          onChange={(event) => updateProjectOverride({ terminal: { fontSize: Number(event.target.value) } })}
          min={8}
          max={32}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow
        {...settingProps('terminal.fontFamily')}
        isOverridden={isOverridden('terminal.fontFamily')}
        onReset={() => removeProjectOverride('terminal.fontFamily')}
        inheritedHint={defaultHint(globalConfig.terminal.fontFamily)}
      >
        <input
          type="text"
          value={displayConfig.terminal.fontFamily}
          onChange={(event) => updateProjectOverride({ terminal: { fontFamily: event.target.value } })}
          className={INPUT_CLASS}
        />
      </SettingRow>
    </>
  );
}

function AgentTabProject({ displayConfig, globalConfig, isOverridden, removeProjectOverride, updateProjectOverride, defaultHint }: ProjectTabProps) {
  return (
    <SettingRow
      {...settingProps('claude.permissionMode')}
      isOverridden={isOverridden('claude.permissionMode')}
      onReset={() => removeProjectOverride('claude.permissionMode')}
      inheritedHint={defaultHint(globalConfig.claude.permissionMode)}
    >
      <Select
        value={displayConfig.claude.permissionMode}
        onChange={(event) => updateProjectOverride({ claude: { permissionMode: event.target.value as PermissionMode } })}
      >
        <option value="default">Default (Allowlist)</option>
        <option value="acceptEdits">Accept Edits</option>
        <option value="bypass-permissions">Bypass (Unsafe)</option>
      </Select>
    </SettingRow>
  );
}

function GitTabProject({ displayConfig, globalConfig, isOverridden, removeProjectOverride, updateProjectOverride, defaultHint }: ProjectTabProps) {
  return (
    <>
      <SettingRow
        {...settingProps('git.worktreesEnabled')}
        isOverridden={isOverridden('git.worktreesEnabled')}
        onReset={() => removeProjectOverride('git.worktreesEnabled')}
        inheritedHint={defaultHint(globalConfig.git.worktreesEnabled)}
      >
        <ToggleSwitch
          checked={displayConfig.git.worktreesEnabled}
          onChange={(value) => updateProjectOverride({ git: { worktreesEnabled: value } })}
        />
      </SettingRow>
      <SettingRow
        {...settingProps('git.autoCleanup')}
        isOverridden={isOverridden('git.autoCleanup')}
        onReset={() => removeProjectOverride('git.autoCleanup')}
        inheritedHint={defaultHint(globalConfig.git.autoCleanup)}
      >
        <ToggleSwitch
          checked={displayConfig.git.autoCleanup}
          onChange={(value) => updateProjectOverride({ git: { autoCleanup: value } })}
        />
      </SettingRow>
      <SettingRow
        {...settingProps('git.defaultBaseBranch')}
        isOverridden={isOverridden('git.defaultBaseBranch')}
        onReset={() => removeProjectOverride('git.defaultBaseBranch')}
        inheritedHint={defaultHint(globalConfig.git.defaultBaseBranch)}
      >
        <BranchPicker
          variant="input"
          value={displayConfig.git.defaultBaseBranch}
          defaultBranch="main"
          onChange={(branch) => updateProjectOverride({ git: { defaultBaseBranch: branch } })}
        />
      </SettingRow>
      <SettingRow
        {...settingProps('git.copyFiles')}
        isOverridden={isOverridden('git.copyFiles')}
        onReset={() => removeProjectOverride('git.copyFiles')}
        inheritedHint={defaultHint(globalConfig.git.copyFiles)}
      >
        <input
          type="text"
          value={displayConfig.git.copyFiles.join(', ')}
          onChange={(event) => {
            const files = event.target.value.split(',').map((file) => file.trim()).filter(Boolean);
            updateProjectOverride({ git: { copyFiles: files } });
          }}
          placeholder=".env, .env.local"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow
        {...settingProps('git.initScript')}
        isOverridden={isOverridden('git.initScript')}
        onReset={() => removeProjectOverride('git.initScript')}
        inheritedHint={defaultHint(globalConfig.git.initScript)}
      >
        <input
          type="text"
          value={displayConfig.git.initScript || ''}
          onChange={(event) => updateProjectOverride({ git: { initScript: event.target.value || null } })}
          placeholder="npm install"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
    </>
  );
}
