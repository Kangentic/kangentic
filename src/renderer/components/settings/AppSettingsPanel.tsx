import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Bot, Check, CircleAlert, GitBranch, Globe, Palette, ShieldAlert, ShieldCheck, SlidersHorizontal, Terminal } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { SettingsPanelShell, SettingsPanelProvider, SectionHeader, SettingRow, Select, ToggleSwitch, CompactToggleList, INPUT_CLASS, useScopedUpdate, SearchTabGroupHeader, NoSearchResults } from './shared';
import type { SettingsTabDefinition, SettingScope } from './shared';
import type { AppConfig, DeepPartial, NotificationConfig, PermissionMode, ThemeMode } from '../../../shared/types';
import { NAMED_THEMES } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';
import { SETTINGS_REGISTRY, settingProps } from './settings-registry';
import { SettingsSearchProvider, computeSearchResults } from './settings-search';

/**
 * App Settings tab layout:
 *
 * Tabs ABOVE the separator are project-overridable settings (also shown in
 * ProjectSettingsPanel). Changes here set the global default and optionally
 * sync to existing projects.
 *
 * Tabs BELOW the separator (after `separator: true`) are global-only settings
 * that apply to the entire app, not per-project. These tabs do NOT appear in
 * the ProjectSettingsPanel.
 */
const APP_TABS: SettingsTabDefinition[] = [
  // -- Project-overridable defaults --
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  // -- Global-only (separator marks the boundary) --
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal, separator: true },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
];

type NotifyEventKey = 'onAgentIdle' | 'onPlanComplete';

/** Map desktop/toast booleans to a single dropdown value. */
function notifyChannelValue(desktop: boolean, toast: boolean): string {
  if (desktop && toast) return 'both';
  if (desktop) return 'desktop';
  if (toast) return 'toast';
  return 'off';
}

/** Reusable row for a notification event with a Desktop/Toast channel dropdown. */
function NotifyChannelRow({ eventKey, config, searchId }: {
  eventKey: NotifyEventKey;
  config: NotificationConfig;
  searchId: string;
}) {
  const updateGlobal = useScopedUpdate('global');
  const value = notifyChannelValue(config.desktop[eventKey], config.toasts[eventKey]);
  const props = settingProps(searchId);
  return (
    <SettingRow {...props}>
      <Select
        value={value}
        onChange={(event) => {
          const selected = event.target.value;
          const desktop = selected === 'both' || selected === 'desktop';
          const toast = selected === 'both' || selected === 'toast';
          updateGlobal({
            notifications: {
              desktop: { [eventKey]: desktop },
              toasts: { [eventKey]: toast },
            },
          });
        }}
      >
        <option value="both">Desktop & Toast</option>
        <option value="desktop">Desktop Only</option>
        <option value="toast">Toast Only</option>
        <option value="off">Off</option>
      </Select>
    </SettingRow>
  );
}

export function AppSettingsPanel() {
  const globalConfig = useConfigStore((state) => state.globalConfig);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const claudeInfo = useConfigStore((state) => state.claudeInfo);
  const detectClaude = useConfigStore((state) => state.detectClaude);
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);

  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [pendingSyncPartial, setPendingSyncPartial] = useState<DeepPartial<AppConfig> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells).catch(() => {});
    detectClaude();
  }, []);

  const handleClose = () => setSettingsOpen(false);

  /**
   * Unified update dispatcher. Scope determines behavior:
   * - 'project' → triggers sync confirmation modal
   * - 'global'  → applies immediately (no sync)
   */
  const updateSetting = useCallback((partial: DeepPartial<AppConfig>, scope: SettingScope) => {
    if (scope === 'project') {
      setPendingSyncPartial(partial);
    } else {
      updateConfig(partial);
    }
  }, [updateConfig]);

  const handleSyncConfirm = (_dontAskAgain: boolean) => {
    if (pendingSyncPartial) {
      updateConfig(pendingSyncPartial);
      window.electronAPI.config.syncDefaultToProjects(pendingSyncPartial).catch(() => {});
    }
    setPendingSyncPartial(null);
  };

  /** Dismiss the sync modal -- discard the pending change entirely. */
  const handleSyncCancel = () => {
    setPendingSyncPartial(null);
  };

  // Show pending value in controls while the sync modal is open.
  const displayConfig = pendingSyncPartial
    ? deepMergeConfig(globalConfig, pendingSyncPartial)
    : globalConfig;

  const [activeTab, setActiveTab] = useState('appearance');

  // Search computation
  const searchResults = useMemo(
    () => computeSearchResults(searchQuery, SETTINGS_REGISTRY),
    [searchQuery],
  );
  const isSearching = searchQuery.trim().length > 0;

  /** When clearing search, if results were in exactly one tab, switch to it. */
  const handleSearchChange = useCallback((query: string) => {
    if (!query && searchQuery) {
      // Clearing search. If results were in exactly one tab, auto-switch.
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
    return APP_TABS.filter((tab) => (searchResults.tabMatchCounts.get(tab.id) || 0) > 0);
  }, [isSearching, searchResults.tabMatchCounts]);

  /** Clear search and navigate to a specific tab. */
  const navigateToTab = useCallback((tabId: string) => {
    setSearchQuery('');
    setActiveTab(tabId);
  }, []);

  return (
    <SettingsPanelProvider value={{ panelType: 'app', updateSetting }}>
      <SettingsSearchProvider query={searchQuery} matchingIds={searchResults.matchingIds}>
        <SettingsPanelShell
          subtitle={
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-fg-faint/10 text-fg-muted text-xs">
              <Globe size={14} />
              Global
            </span>
          }
          onClose={handleClose}
          tabs={APP_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
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
                    {tab.id === 'appearance' && <AppearanceTab displayConfig={displayConfig} />}
                    {tab.id === 'terminal' && <TerminalTab displayConfig={displayConfig} shells={shells} />}
                    {tab.id === 'agent' && <AgentTab displayConfig={displayConfig} globalConfig={globalConfig} claudeInfo={claudeInfo} />}
                    {tab.id === 'git' && <GitTab displayConfig={displayConfig} />}
                    {tab.id === 'behavior' && <BehaviorTab globalConfig={globalConfig} />}
                    {tab.id === 'notifications' && <NotificationsTab globalConfig={globalConfig} />}
                    {tab.id === 'privacy' && <PrivacyTab />}
                  </div>
                </div>
              ))
            ) : (
              <NoSearchResults query={searchQuery} />
            )
          ) : (
            // Normal mode: single active tab
            <>
              {activeTab === 'appearance' && <AppearanceTab displayConfig={displayConfig} />}
              {activeTab === 'terminal' && <TerminalTab displayConfig={displayConfig} shells={shells} />}
              {activeTab === 'agent' && <AgentTab displayConfig={displayConfig} globalConfig={globalConfig} claudeInfo={claudeInfo} />}
              {activeTab === 'behavior' && <BehaviorTab globalConfig={globalConfig} />}
              {activeTab === 'notifications' && <NotificationsTab globalConfig={globalConfig} />}
              {activeTab === 'privacy' && <PrivacyTab />}
              {activeTab === 'git' && <GitTab displayConfig={displayConfig} />}
            </>
          )}

          {/* Sync defaults confirmation */}
          {pendingSyncPartial && (
            <ConfirmDialog
              title="Apply to all projects?"
              message="Apply this change to all projects? New projects will use this setting by default."
              confirmLabel="Apply to All"
              onConfirm={handleSyncConfirm}
              onCancel={handleSyncCancel}
            />
          )}
        </SettingsPanelShell>
      </SettingsSearchProvider>
    </SettingsPanelProvider>
  );
}

/* ── Tab Components ── */

function AppearanceTab({ displayConfig }: { displayConfig: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <SettingRow {...settingProps('theme')}>
      <Select
        value={displayConfig.theme}
        onChange={(event) => updateProject({ theme: event.target.value as ThemeMode })}
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

function TerminalTab({ displayConfig, shells }: { displayConfig: AppConfig; shells: Array<{ name: string; path: string }> }) {
  const updateProject = useScopedUpdate('project');
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('terminal.shell')}>
        <Select
          value={displayConfig.terminal.shell || ''}
          onChange={(event) => updateProject({ terminal: { shell: event.target.value || null } })}
        >
          <option value="">Auto-detect</option>
          {shells.map((shell) => (
            <option key={shell.path} value={shell.path}>{shell.name}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontSize')}>
        <input
          type="number"
          value={displayConfig.terminal.fontSize}
          onChange={(event) => updateProject({ terminal: { fontSize: Number(event.target.value) } })}
          min={8}
          max={32}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontFamily')}>
        <input
          type="text"
          value={displayConfig.terminal.fontFamily}
          onChange={(event) => updateProject({ terminal: { fontFamily: event.target.value } })}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.scrollbackLines')}>
        <input
          type="number"
          value={displayConfig.terminal.scrollbackLines}
          onChange={(event) => updateProject({ terminal: { scrollbackLines: Number(event.target.value) } })}
          min={1000}
          max={100000}
          step={1000}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.cursorStyle')}>
        <Select
          value={displayConfig.terminal.cursorStyle}
          onChange={(event) => updateProject({ terminal: { cursorStyle: event.target.value as 'block' | 'underline' | 'bar' } })}
        >
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </Select>
      </SettingRow>

      <SectionHeader
        label="Context Bar"
        searchIds={[
          'contextBar.showShell', 'contextBar.showVersion', 'contextBar.showModel',
          'contextBar.showCost', 'contextBar.showTokens', 'contextBar.showContextFraction',
          'contextBar.showProgressBar',
        ]}
      />
      <CompactToggleList scope="global" items={[
        { label: 'Shell', description: 'Detected shell name', checked: displayConfig.contextBar.showShell, onChange: (value) => updateGlobal({ contextBar: { showShell: value } }), searchId: 'contextBar.showShell' },
        { label: 'Version', description: 'Claude Code version', checked: displayConfig.contextBar.showVersion, onChange: (value) => updateGlobal({ contextBar: { showVersion: value } }), searchId: 'contextBar.showVersion' },
        { label: 'Model', description: 'Active model name', checked: displayConfig.contextBar.showModel, onChange: (value) => updateGlobal({ contextBar: { showModel: value } }), searchId: 'contextBar.showModel' },
        { label: 'Cost', description: 'Session API cost', checked: displayConfig.contextBar.showCost, onChange: (value) => updateGlobal({ contextBar: { showCost: value } }), searchId: 'contextBar.showCost' },
        { label: 'Token Counts', description: 'Input / output totals', checked: displayConfig.contextBar.showTokens, onChange: (value) => updateGlobal({ contextBar: { showTokens: value } }), searchId: 'contextBar.showTokens' },
        { label: 'Context Window', description: 'Used / total tokens', checked: displayConfig.contextBar.showContextFraction, onChange: (value) => updateGlobal({ contextBar: { showContextFraction: value } }), searchId: 'contextBar.showContextFraction' },
        { label: 'Progress Bar', description: 'Usage bar and percentage', checked: displayConfig.contextBar.showProgressBar, onChange: (value) => updateGlobal({ contextBar: { showProgressBar: value } }), searchId: 'contextBar.showProgressBar' },
      ]} />
    </>
  );
}

function AgentTab({ displayConfig, globalConfig, claudeInfo }: { displayConfig: AppConfig; globalConfig: AppConfig; claudeInfo: { found: boolean; path: string | null; version: string | null } | null }) {
  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  return (
    <>
      <SettingRow {...settingProps('claude.cliPath')}>
        <div className="relative">
          <input
            type="text"
            value={globalConfig.claude.cliPath || ''}
            onChange={(event) => updateGlobal({ claude: { cliPath: event.target.value || null } })}
            placeholder={claudeInfo?.found ? (claudeInfo.path ?? undefined) : 'Not found -- enter path manually'}
            className={`${INPUT_CLASS} pr-8 ${claudeInfo?.found ? 'placeholder-fg-muted' : 'placeholder-red-400/70'}`}
          />
          {claudeInfo && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2" title={claudeInfo.found ? `Detected: ${claudeInfo.version || 'unknown version'}` : 'Claude CLI not found'}>
              {claudeInfo.found
                ? <Check size={16} className="text-green-400" />
                : <CircleAlert size={16} className="text-red-400" />}
            </div>
          )}
        </div>
      </SettingRow>
      <SettingRow {...settingProps('claude.maxConcurrentSessions')}>
        <input
          type="number"
          value={globalConfig.claude.maxConcurrentSessions}
          onChange={(event) => updateGlobal({ claude: { maxConcurrentSessions: Number(event.target.value) } })}
          min={1}
          max={20}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('claude.queueOverflow')}>
        <Select
          value={globalConfig.claude.queueOverflow}
          onChange={(event) => updateGlobal({ claude: { queueOverflow: event.target.value as 'queue' | 'reject' } })}
        >
          <option value="queue">Queue</option>
          <option value="reject">Reject</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('claude.idleTimeoutMinutes')}>
        <input
          type="number"
          value={globalConfig.claude.idleTimeoutMinutes}
          onChange={(event) => updateGlobal({ claude: { idleTimeoutMinutes: Number(event.target.value) } })}
          min={0}
          max={120}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('claude.permissionMode')}>
        <Select
          value={displayConfig.claude.permissionMode}
          onChange={(event) => updateProject({ claude: { permissionMode: event.target.value as PermissionMode } })}
        >
          <option value="default">Default (Allowlist)</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="bypass-permissions">Bypass (Unsafe)</option>
        </Select>
      </SettingRow>
    </>
  );
}

function BehaviorTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('skipDeleteConfirm')}>
        <ToggleSwitch
          checked={globalConfig.skipDeleteConfirm}
          onChange={(value) => updateGlobal({ skipDeleteConfirm: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('autoFocusIdleSession')}>
        <ToggleSwitch
          checked={globalConfig.autoFocusIdleSession}
          onChange={(value) => updateGlobal({ autoFocusIdleSession: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('activateAllProjectsOnStartup')}>
        <ToggleSwitch
          checked={globalConfig.activateAllProjectsOnStartup}
          onChange={(value) => updateGlobal({ activateAllProjectsOnStartup: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('restoreWindowPosition')}>
        <ToggleSwitch
          checked={globalConfig.restoreWindowPosition}
          onChange={(value) => updateGlobal({ restoreWindowPosition: value })}
        />
      </SettingRow>
    </>
  );
}

function NotificationsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <NotifyChannelRow
        eventKey="onAgentIdle"
        config={globalConfig.notifications}
        searchId="notifications.onAgentIdle"
      />
      <NotifyChannelRow
        eventKey="onPlanComplete"
        config={globalConfig.notifications}
        searchId="notifications.onPlanComplete"
      />
      <div className="border-t border-edge my-2" />
      <SettingRow {...settingProps('notifications.toasts.durationSeconds')}>
        <input
          type="number"
          value={globalConfig.notifications.toasts.durationSeconds}
          onChange={(event) => updateGlobal({ notifications: { toasts: { durationSeconds: Number(event.target.value) } } })}
          min={1}
          max={30}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('notifications.toasts.maxCount')}>
        <input
          type="number"
          value={globalConfig.notifications.toasts.maxCount}
          onChange={(event) => updateGlobal({ notifications: { toasts: { maxCount: Number(event.target.value) } } })}
          min={1}
          max={10}
          className={INPUT_CLASS}
        />
      </SettingRow>
    </>
  );
}

function PrivacyTab() {
  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-2 rounded-full bg-surface-hover px-3.5 py-1.5">
        <ShieldAlert className="size-5 text-fg-muted shrink-0" />
        <span className="text-[1em] text-fg-secondary">Anonymous analytics only -- no personal data collected.</span>
      </div>

      <SectionHeader label="What We Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>App launches, platform, and architecture</li>
        <li>App crashes and errors (sanitized, no file paths)</li>
        <li>Task and project creation counts</li>
        <li>Agent session starts, exit codes, and duration</li>
      </ul>

      <SectionHeader label="What We Don't Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>Task titles, descriptions, or any user-generated content</li>
        <li>File paths, project names, or code</li>
        <li>Usernames, emails, or any personally identifiable information</li>
      </ul>

      <SectionHeader label="How It Works" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Analytics are powered by Aptabase, a privacy-first platform.
        No cookies or persistent identifiers. IP addresses are used
        for geographic lookup only, then discarded. GDPR-compliant by design.
      </p>

      <SectionHeader label="How to Opt Out" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to disable analytics.
      </p>
    </div>
  );
}

function GitTab({ displayConfig }: { displayConfig: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <>
      <SettingRow {...settingProps('git.worktreesEnabled')}>
        <ToggleSwitch
          checked={displayConfig.git.worktreesEnabled}
          onChange={(value) => updateProject({ git: { worktreesEnabled: value } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.autoCleanup')}>
        <ToggleSwitch
          checked={displayConfig.git.autoCleanup}
          onChange={(value) => updateProject({ git: { autoCleanup: value } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.defaultBaseBranch')}>
        <BranchPicker
          variant="input"
          value={displayConfig.git.defaultBaseBranch}
          defaultBranch="main"
          onChange={(branch) => updateProject({ git: { defaultBaseBranch: branch } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.copyFiles')}>
        <input
          type="text"
          value={displayConfig.git.copyFiles.join(', ')}
          onChange={(event) => {
            const files = event.target.value.split(',').map((file) => file.trim()).filter(Boolean);
            updateProject({ git: { copyFiles: files } });
          }}
          placeholder=".env, .env.local"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.initScript')}>
        <input
          type="text"
          value={displayConfig.git.initScript || ''}
          onChange={(event) => updateProject({ git: { initScript: event.target.value || null } })}
          placeholder="npm install"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
    </>
  );
}
