import { useCallback, useMemo } from 'react';
import { Bell, Bot, Check, CircleAlert, GitBranch, Palette, Plug, ShieldAlert, ShieldCheck, SlidersHorizontal, Terminal, Zap } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { SettingsPanelProvider, SectionHeader, SettingRow, Select, ToggleSwitch, CompactToggleList, INPUT_CLASS, useScopedUpdate, SearchTabGroupHeader, NoSearchResults } from './shared';
import { Pill } from '../Pill';
import type { SettingsTabDefinition, SettingScope, SettingsContentProps } from './shared';
import { useProjectStore } from '../../stores/project-store';
import type { AgentDetectionInfo } from '../../../shared/types';
import type { AppConfig, DeepPartial, NotificationConfig, PermissionMode, ThemeMode, AgentPermissionEntry } from '../../../shared/types';
import { NAMED_THEMES, nearestPermission, CLAUDE_DEFAULT_PERMISSIONS, DEFAULT_AGENT, DEFAULT_CONFIG } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';
import { agentDisplayName } from '../../utils/agent-display-name';
import { settingProps } from './settings-registry';
import { ShortcutsTab } from './ShortcutsTab';

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
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'shortcuts', label: 'Shortcuts', icon: Zap },
  // -- Shared settings (separator marks the boundary) --
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal, separator: true, tooltip: 'Applies to all projects' },
  { id: 'mcpServer', label: 'MCP Server', icon: Plug, tooltip: 'Applies to all projects' },
  { id: 'notifications', label: 'Notifications', icon: Bell, tooltip: 'Applies to all projects' },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, tooltip: 'Applies to all projects' },
];

/** Separator index: tabs before this are per-project, tabs at/after are shared. */
const SEPARATOR_INDEX = APP_TABS.findIndex((tab) => tab.separator);

/** Shared-only tabs (below separator). Shown even when no project is open. */
export const GLOBAL_ONLY_TABS = APP_TABS.slice(SEPARATOR_INDEX);

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

/**
 * Unified settings content. Rendered inside the SettingsPanel shell.
 *
 * For per-project tabs (above separator): reads from effectiveConfig
 * (global merged with project overrides), writes to project overrides.
 *
 * For shared tabs (below separator): reads from globalConfig, writes
 * to global config. These settings apply across all projects.
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

  return (
    <SettingsPanelProvider value={{ updateSetting }}>
      {isSearching ? (
        // Search mode: render all matching tabs stacked
        matchingTabs.length > 0 ? (
          matchingTabs.map((tab, index) => (
            <div key={tab.id}>
              <SearchTabGroupHeader tab={tab} first={index === 0} onNavigate={navigateToTab} />
              <div className="space-y-4">
                {tab.id === 'appearance' && <AppearanceTab config={effectiveConfig} />}
                {tab.id === 'terminal' && <TerminalTab config={effectiveConfig} globalConfig={globalConfig} shells={shells} />}
                {tab.id === 'agent' && <AgentTab config={effectiveConfig} globalConfig={globalConfig} agentInfo={agentInfo} agentList={agentList} />}
                {tab.id === 'git' && <GitTab config={effectiveConfig} />}
                {tab.id === 'shortcuts' && <ShortcutsTab />}
                {tab.id === 'behavior' && <BehaviorTab globalConfig={globalConfig} />}
                {tab.id === 'mcpServer' && <McpServerTab globalConfig={globalConfig} />}
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
          {activeTab === 'appearance' && <AppearanceTab config={effectiveConfig} />}
          {activeTab === 'terminal' && <TerminalTab config={effectiveConfig} globalConfig={globalConfig} shells={shells} />}
          {activeTab === 'agent' && <AgentTab config={effectiveConfig} globalConfig={globalConfig} agentInfo={agentInfo} agentList={agentList} />}
          {activeTab === 'behavior' && <BehaviorTab globalConfig={globalConfig} />}
          {activeTab === 'mcpServer' && <McpServerTab globalConfig={globalConfig} />}
          {activeTab === 'notifications' && <NotificationsTab globalConfig={globalConfig} />}
          {activeTab === 'privacy' && <PrivacyTab />}
          {activeTab === 'git' && <GitTab config={effectiveConfig} />}
          {activeTab === 'shortcuts' && <ShortcutsTab />}
        </>
      )}
    </SettingsPanelProvider>
  );
}

/* ── Tab Components ── */

function AppearanceTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <SettingRow {...settingProps('theme')}>
      <Select
        value={config.theme}
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

function TerminalTab({ config, globalConfig, shells }: { config: AppConfig; globalConfig: AppConfig; shells: Array<{ name: string; path: string }> }) {
  const updateProject = useScopedUpdate('project');
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('terminal.shell')}>
        <Select
          value={config.terminal.shell || ''}
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
          value={config.terminal.fontSize ?? DEFAULT_CONFIG.terminal.fontSize}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateProject({ terminal: { fontSize: value } });
          }}
          min={8}
          max={32}
          placeholder={String(DEFAULT_CONFIG.terminal.fontSize)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontFamily')}>
        <input
          type="text"
          value={config.terminal.fontFamily ?? ''}
          onChange={(event) => updateProject({ terminal: { fontFamily: event.target.value } })}
          placeholder={DEFAULT_CONFIG.terminal.fontFamily}
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.scrollbackLines')}>
        <input
          type="number"
          value={config.terminal.scrollbackLines ?? DEFAULT_CONFIG.terminal.scrollbackLines}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateProject({ terminal: { scrollbackLines: value } });
          }}
          min={1000}
          max={100000}
          step={1000}
          placeholder={String(DEFAULT_CONFIG.terminal.scrollbackLines)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.cursorStyle')}>
        <Select
          value={config.terminal.cursorStyle}
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
      <CompactToggleList items={[
        { label: 'Shell', description: 'Detected shell name', checked: globalConfig.contextBar.showShell, onChange: (value) => updateGlobal({ contextBar: { showShell: value } }), searchId: 'contextBar.showShell' },
        { label: 'Version', description: 'Agent CLI version', checked: globalConfig.contextBar.showVersion, onChange: (value) => updateGlobal({ contextBar: { showVersion: value } }), searchId: 'contextBar.showVersion' },
        { label: 'Model', description: 'Active model name', checked: globalConfig.contextBar.showModel, onChange: (value) => updateGlobal({ contextBar: { showModel: value } }), searchId: 'contextBar.showModel' },
        { label: 'Cost', description: 'Session API cost', checked: globalConfig.contextBar.showCost, onChange: (value) => updateGlobal({ contextBar: { showCost: value } }), searchId: 'contextBar.showCost' },
        { label: 'Token Counts', description: 'Input / output totals', checked: globalConfig.contextBar.showTokens, onChange: (value) => updateGlobal({ contextBar: { showTokens: value } }), searchId: 'contextBar.showTokens' },
        { label: 'Context Window', description: 'Used / total tokens', checked: globalConfig.contextBar.showContextFraction, onChange: (value) => updateGlobal({ contextBar: { showContextFraction: value } }), searchId: 'contextBar.showContextFraction' },
        { label: 'Progress Bar', description: 'Usage bar and percentage', checked: globalConfig.contextBar.showProgressBar, onChange: (value) => updateGlobal({ contextBar: { showProgressBar: value } }), searchId: 'contextBar.showProgressBar' },
      ]} />
    </>
  );
}

function AgentTab({ config, globalConfig, agentInfo, agentList }: { config: AppConfig; globalConfig: AppConfig; agentInfo: { found: boolean; path: string | null; version: string | null } | null; agentList: AgentDetectionInfo[] }) {
  const updateGlobal = useScopedUpdate('global');
  const updateProject = useScopedUpdate('project');
  const currentProject = useProjectStore((state) => state.currentProject);
  const refreshCurrentProject = useProjectStore((state) => state.loadCurrent);

  const effectiveAgent = currentProject?.default_agent ?? DEFAULT_AGENT;
  const agentPermissions: AgentPermissionEntry[] = agentList.find((agent) => agent.name === effectiveAgent)?.permissions ?? CLAUDE_DEFAULT_PERMISSIONS;

  const handleDefaultAgentChange = async (agentName: string) => {
    if (!currentProject) return;
    await window.electronAPI.projects.setDefaultAgent(currentProject.id, agentName);
    // Auto-adjust permission mode if unsupported by the new agent
    const newAgentPermissions = agentList.find((agent) => agent.name === agentName)?.permissions ?? [];
    if (newAgentPermissions.length > 0) {
      const adjusted = nearestPermission(newAgentPermissions, config.agent.permissionMode);
      if (adjusted !== config.agent.permissionMode) {
        updateProject({ agent: { permissionMode: adjusted } });
      }
    }
    await refreshCurrentProject();
  };

  return (
    <>
      <SettingRow {...settingProps('project.defaultAgent')}>
        <Select
          value={effectiveAgent}
          onChange={(event) => handleDefaultAgentChange(event.target.value)}
          disabled={!currentProject}
        >
          {agentList.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.displayName ?? agent.name}{agent.found ? '' : ' (not found)'}
            </option>
          ))}
          {agentList.length === 0 && <option value={DEFAULT_AGENT}>{agentDisplayName(DEFAULT_AGENT)}</option>}
        </Select>
      </SettingRow>
      {agentList.map((agent) => (
        <SettingRow key={agent.name} {...settingProps('agent.cliPaths')} label={`${agent.displayName} Path`}>
          <div className="relative">
            <input
              type="text"
              value={globalConfig.agent.cliPaths[agent.name] || ''}
              onChange={(event) => updateGlobal({ agent: { cliPaths: { ...globalConfig.agent.cliPaths, [agent.name]: event.target.value || null } } })}
              placeholder={agent.found ? (agent.path ?? undefined) : 'Not found. Enter path manually'}
              className={`${INPUT_CLASS} pr-8 ${agent.found ? 'placeholder-fg-muted' : 'placeholder-red-400/70'}`}
            />
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2" title={agent.found ? `Detected: ${agent.version || 'unknown version'}` : `${agent.displayName} not found`}>
              {agent.found
                ? <Check size={16} className="text-green-400" />
                : <CircleAlert size={16} className="text-red-400" />}
            </div>
          </div>
        </SettingRow>
      ))}
      <SettingRow {...settingProps('agent.idleTimeoutMinutes')}>
        <input
          type="number"
          value={globalConfig.agent.idleTimeoutMinutes}
          onChange={(event) => updateGlobal({ agent: { idleTimeoutMinutes: Number(event.target.value) } })}
          min={0}
          max={120}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('agent.permissionMode')}>
        <Select
          value={config.agent.permissionMode}
          onChange={(event) => updateProject({ agent: { permissionMode: event.target.value as PermissionMode } })}
        >
          {agentPermissions.map((entry) => (
            <option key={entry.mode} value={entry.mode}>{entry.label}</option>
          ))}
        </Select>
      </SettingRow>
    </>
  );
}

function BehaviorTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SectionHeader
        label="Session Limits"
        searchIds={['agent.maxConcurrentSessions', 'agent.queueOverflow']}
      />
      <SettingRow {...settingProps('agent.maxConcurrentSessions')}>
        <input
          type="number"
          value={globalConfig.agent.maxConcurrentSessions}
          onChange={(event) => updateGlobal({ agent: { maxConcurrentSessions: Number(event.target.value) } })}
          min={1}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('agent.queueOverflow')}>
        <Select
          value={globalConfig.agent.queueOverflow}
          onChange={(event) => updateGlobal({ agent: { queueOverflow: event.target.value as 'queue' | 'reject' } })}
        >
          <option value="queue">Queue</option>
          <option value="reject">Reject</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('showBoardSearch')}>
        <ToggleSwitch
          checked={globalConfig.showBoardSearch}
          onChange={(value) => updateGlobal({ showBoardSearch: value })}
        />
      </SettingRow>
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
      <Pill as="div" size="lg" className="bg-surface-hover">
        <ShieldAlert className="size-5 text-fg-muted shrink-0" />
        <span className="text-[1em] text-fg-secondary">Anonymous analytics only. No personal data collected.</span>
      </Pill>

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

function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-surface-hover px-4 py-3">
        <Plug className="size-5 text-fg-muted shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-primary">Kangentic MCP Server</div>
          <div className="text-xs text-fg-muted">Give agents tools to interact with your board</div>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
        />
      </div>

      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <SectionHeader label="Available Tools" searchIds={['mcpServer.enabled']} />
        <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
          <li><strong className="text-fg-secondary">Create Task</strong> - add tasks to any column from within an agent session</li>
          <li><strong className="text-fg-secondary">Update Task</strong> - edit title and description of existing tasks</li>
          <li><strong className="text-fg-secondary">List Columns</strong> - see all board columns with task counts</li>
          <li><strong className="text-fg-secondary">List Tasks</strong> - browse tasks, optionally filtered by column</li>
          <li><strong className="text-fg-secondary">Search Tasks</strong> - find tasks by keyword across titles and descriptions</li>
          <li><strong className="text-fg-secondary">Find Task</strong> - look up tasks by branch name, title, or PR number</li>
          <li><strong className="text-fg-secondary">Board Summary</strong> - overview of task counts, active sessions, and costs</li>
          <li><strong className="text-fg-secondary">Task Stats</strong> - token usage, cost, and duration for individual or all tasks</li>
          <li><strong className="text-fg-secondary">Session History</strong> - timeline of sessions for a task</li>
          <li><strong className="text-fg-secondary">Column Detail</strong> - automation settings, permission mode, and configuration</li>
        </ul>

        <SectionHeader label="How It Works" searchIds={['mcpServer.enabled']} />
        <p className="text-sm text-fg-muted leading-relaxed">
          When enabled, Kangentic injects a local MCP server into each agent session.
          The agent discovers the tools automatically and can call them at any time during its work.
          Tasks created by agents appear on the board with a toast notification.
          If a task is created in a column with auto-spawn enabled, a new agent session starts for it automatically.
        </p>
      </div>
    </div>
  );
}

function GitTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <>
      <SettingRow {...settingProps('git.worktreesEnabled')}>
        <ToggleSwitch
          checked={config.git.worktreesEnabled}
          onChange={(value) => updateProject({ git: { worktreesEnabled: value } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.autoCleanup')}>
        <ToggleSwitch
          checked={config.git.autoCleanup}
          onChange={(value) => updateProject({ git: { autoCleanup: value } })}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.defaultBaseBranch')}>
        <BranchPicker
          variant="input"
          value={config.git.defaultBaseBranch}
          defaultBranch="main"
          onChange={(branch) => {
            updateProject({ git: { defaultBaseBranch: branch } });
            window.electronAPI.boardConfig.setDefaultBaseBranch(branch);
          }}
        />
      </SettingRow>
      <SettingRow {...settingProps('git.copyFiles')}>
        <input
          type="text"
          value={(config.git.copyFiles ?? []).join(', ')}
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
          value={config.git.initScript || ''}
          onChange={(event) => updateProject({ git: { initScript: event.target.value || null } })}
          placeholder="npm install"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
    </>
  );
}
