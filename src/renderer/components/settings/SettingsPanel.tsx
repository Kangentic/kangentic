import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, CircleAlert, GitBranch, Lock, Palette, RotateCcw, SlidersHorizontal, Terminal, X } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { ScopeSelector } from './ScopeSelector';
import type { AppConfig, DeepPartial, PermissionMode, ThemeMode } from '../../../shared/types';
import { GLOBAL_ONLY_PATHS, NAMED_THEMES } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';

type Phase = 'entering' | 'visible' | 'exiting';
type SettingsTab = 'appearance' | 'terminal' | 'agent' | 'git' | 'behavior';

const tabs: Array<{ id: SettingsTab; label: string; icon: React.ElementType }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
];

export function SettingsPanel() {
  const globalConfig = useConfigStore((s) => s.globalConfig);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const settingsInitialTab = useConfigStore((s) => s.settingsInitialTab);
  const settingsScope = useConfigStore((s) => s.settingsScope);
  const settingsScopeProjectPath = useConfigStore((s) => s.settingsScopeProjectPath);
  const setSettingsScope = useConfigStore((s) => s.setSettingsScope);
  const projectOverrides = useConfigStore((s) => s.projectOverrides);
  const updateProjectOverride = useConfigStore((s) => s.updateProjectOverride);
  const removeProjectOverride = useConfigStore((s) => s.removeProjectOverride);
  const resetAllProjectOverrides = useConfigStore((s) => s.resetAllProjectOverrides);
  const isOverridden = useConfigStore((s) => s.isOverridden);
  const projects = useProjectStore((s) => s.projects);
  const openProject = useProjectStore((s) => s.openProject);
  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [phase, setPhase] = useState<Phase>('entering');
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    tabs.some((t) => t.id === settingsInitialTab) ? settingsInitialTab as SettingsTab : 'appearance',
  );
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells);
    detectClaude();
  }, []);

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  const handleBackdropAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') setSettingsOpen(false);
  };

  const backdropAnimation = phase === 'entering'
    ? 'dialog-backdrop-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-backdrop-out 150ms ease-in forwards'
      : 'none';

  const panelAnimation = phase === 'entering'
    ? 'settings-panel-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'settings-panel-out 150ms ease-in forwards'
      : 'none';

  const inputClass = 'bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent';

  const isProjectScope = settingsScope === 'project';
  const displayConfig = isProjectScope && projectOverrides
    ? deepMergeConfig(globalConfig, projectOverrides as Record<string, unknown>)
    : globalConfig;

  /** Update handler: routes to project override or global config. */
  const handleUpdate = (partial: DeepPartial<AppConfig>) => {
    if (isProjectScope) {
      updateProjectOverride(partial);
    } else {
      updateConfig(partial);
    }
  };

  /** Shorthand for the 4 scope-related props every SettingRow needs. */
  const settingProps = (keyPath: string) => ({
    scope: settingsScope,
    globalOnly: GLOBAL_ONLY_PATHS.has(keyPath),
    isOverridden: isProjectScope && isOverridden(keyPath),
    onReset: () => removeProjectOverride(keyPath),
  });

  /** Whether overrides contain any keys (for showing reset-all). */
  const hasAnyOverrides = isProjectScope && projectOverrides != null
    && Object.keys(projectOverrides).length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50"
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleBackdropAnimationEnd}
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        className="fixed top-10 right-0 bottom-0 w-[720px] bg-surface-raised border-l border-edge shadow-2xl flex flex-col"
        style={{ animation: panelAnimation }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-fg">Settings</h2>
            <span className="text-fg-faint select-none">—</span>
            <ScopeSelector
              scope={settingsScope}
              scopeProjectPath={settingsScopeProjectPath}
              projects={projects}
              onSelectGlobal={() => setSettingsScope('global')}
              onSelectProject={(projectId, projectPath) => { openProject(projectId); setSettingsScope('project', projectPath); }}
            />
          </div>
          <button
            onClick={requestClose}
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Two-column body */}
        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <div className="w-44 bg-surface-raised border-r border-edge p-2 flex-shrink-0">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded text-base text-left transition-colors ${
                    isActive
                      ? 'bg-surface-hover text-fg'
                      : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/50'
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
            {activeTab === 'appearance' && (
              <>
                <SettingRow label="Theme" description="Color scheme for the interface" {...settingProps('theme')}>
                  <Select
                    value={displayConfig.theme}
                    onChange={(e) => handleUpdate({ theme: e.target.value as ThemeMode })}
                  >
                    <optgroup label="Standard">
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </optgroup>
                    <optgroup label="Dark Palette">
                      {NAMED_THEMES.filter(t => t.base === 'dark').map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Light Palette">
                      {NAMED_THEMES.filter(t => t.base === 'light').map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </optgroup>
                  </Select>
                </SettingRow>
              </>
            )}

            {activeTab === 'terminal' && (
              <>
                <SettingRow label="Shell" description="Terminal shell used for agent sessions" {...settingProps('terminal.shell')}>
                  <Select
                    value={displayConfig.terminal.shell || ''}
                    onChange={(e) => handleUpdate({ terminal: { shell: e.target.value || null } })}
                  >
                    <option value="">Auto-detect</option>
                    {shells.map((s) => (
                      <option key={s.path} value={s.path}>{s.name}</option>
                    ))}
                  </Select>
                </SettingRow>
                <SettingRow label="Font Size" description="Terminal text size in pixels" {...settingProps('terminal.fontSize')}>
                  <input
                    type="number"
                    value={displayConfig.terminal.fontSize}
                    onChange={(e) => handleUpdate({ terminal: { fontSize: Number(e.target.value) } })}
                    min={8}
                    max={32}
                    className={inputClass}
                  />
                </SettingRow>
                <SettingRow label="Font Family" description="CSS font-family for the terminal" {...settingProps('terminal.fontFamily')}>
                  <input
                    type="text"
                    value={displayConfig.terminal.fontFamily}
                    onChange={(e) => handleUpdate({ terminal: { fontFamily: e.target.value } })}
                    className={inputClass}
                  />
                </SettingRow>
              </>
            )}

            {activeTab === 'agent' && (
              <>
                <SettingRow label="Permissions" description="How Claude handles tool approvals" {...settingProps('claude.permissionMode')}>
                  <Select
                    value={displayConfig.claude.permissionMode}
                    onChange={(e) => handleUpdate({ claude: { permissionMode: e.target.value as PermissionMode } })}
                  >
                    <option value="default">Default (Allowlist)</option>
                    <option value="acceptEdits">Accept Edits</option>
                    <option value="bypass-permissions">Bypass (Unsafe)</option>
                  </Select>
                </SettingRow>
                <SettingRow label="Max Concurrent Sessions" description="Limit how many agents can run at the same time" {...settingProps('claude.maxConcurrentSessions')}>
                  <input
                    type="number"
                    value={displayConfig.claude.maxConcurrentSessions}
                    onChange={(e) => handleUpdate({ claude: { maxConcurrentSessions: Number(e.target.value) } })}
                    min={1}
                    max={20}
                    className={inputClass}
                  />
                </SettingRow>
                <SettingRow label="When Max Sessions Reached" description="How new agent requests are handled when all slots are in use" {...settingProps('claude.queueOverflow')}>
                  <Select
                    value={displayConfig.claude.queueOverflow}
                    onChange={(e) => handleUpdate({ claude: { queueOverflow: e.target.value as 'queue' | 'reject' } })}
                  >
                    <option value="queue">Queue</option>
                    <option value="reject">Reject</option>
                  </Select>
                </SettingRow>
                <SettingRow label="CLI Path" description="Path to Claude CLI binary (auto-detected if empty)" {...settingProps('claude.cliPath')}>
                  <div className="relative">
                    <input
                      type="text"
                      value={displayConfig.claude.cliPath || ''}
                      onChange={(e) => handleUpdate({ claude: { cliPath: e.target.value || null } })}
                      placeholder={claudeInfo?.found ? (claudeInfo.path ?? undefined) : 'Not found — enter path manually'}
                      className={`${inputClass} pr-8 ${claudeInfo?.found ? 'placeholder-fg-muted' : 'placeholder-red-400/70'}`}
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
              </>
            )}

            {activeTab === 'git' && (
              <>
                <SettingRow label="Enable Worktrees" description="Create git worktrees for agent tasks" {...settingProps('git.worktreesEnabled')}>
                  <ToggleSwitch
                    checked={displayConfig.git.worktreesEnabled}
                    onChange={(v) => handleUpdate({ git: { worktreesEnabled: v } })}
                  />
                </SettingRow>
                <SettingRow label="Auto-cleanup" description="Remove worktrees when tasks complete" {...settingProps('git.autoCleanup')}>
                  <ToggleSwitch
                    checked={displayConfig.git.autoCleanup}
                    onChange={(v) => handleUpdate({ git: { autoCleanup: v } })}
                  />
                </SettingRow>
                <SettingRow label="Default Base Branch" description="Branch to create worktrees from" {...settingProps('git.defaultBaseBranch')}>
                  <BranchPicker
                    variant="input"
                    value={displayConfig.git.defaultBaseBranch}
                    defaultBranch="main"
                    onChange={(branch) => handleUpdate({ git: { defaultBaseBranch: branch } })}
                  />
                </SettingRow>
                <SettingRow label="Copy Files" description="Additional files copied into each worktree" {...settingProps('git.copyFiles')}>
                  <input
                    type="text"
                    value={displayConfig.git.copyFiles.join(', ')}
                    onChange={(e) => {
                      const files = e.target.value.split(',').map((f) => f.trim()).filter(Boolean);
                      handleUpdate({ git: { copyFiles: files } });
                    }}
                    placeholder=".env, .env.local"
                    className={`${inputClass} placeholder-fg-faint`}
                  />
                </SettingRow>
                <SettingRow label="Post-Worktree Script" description="Shell script to run after worktree creation" {...settingProps('git.initScript')}>
                  <input
                    type="text"
                    value={displayConfig.git.initScript || ''}
                    onChange={(e) => handleUpdate({ git: { initScript: e.target.value || null } })}
                    placeholder="npm install"
                    className={`${inputClass} placeholder-fg-faint`}
                  />
                </SettingRow>
              </>
            )}

            {activeTab === 'behavior' && (
              <>
                <SettingRow label="Skip Task Delete Confirmation" description="Delete tasks immediately without a confirmation dialog" {...settingProps('skipDeleteConfirm')}>
                  <ToggleSwitch
                    checked={displayConfig.skipDeleteConfirm}
                    onChange={(v) => handleUpdate({ skipDeleteConfirm: v })}
                  />
                </SettingRow>
                <SettingRow label="Auto-Focus Idle Sessions" description="Automatically switch the bottom panel to the most recently idle session" {...settingProps('autoFocusIdleSession')}>
                  <ToggleSwitch
                    checked={displayConfig.autoFocusIdleSession}
                    onChange={(v) => handleUpdate({ autoFocusIdleSession: v })}
                  />
                </SettingRow>
                <SettingRow label="Notify When Background Agents Go Idle" description="Show a desktop notification when an agent needs attention on a non-active project" {...settingProps('notifyIdleOnInactiveProject')}>
                  <ToggleSwitch
                    checked={displayConfig.notifyIdleOnInactiveProject}
                    onChange={(v) => handleUpdate({ notifyIdleOnInactiveProject: v })}
                  />
                </SettingRow>
                <SettingRow label="Launch All Projects on Startup" description="Start agents across all projects on launch, not just the current open one" {...settingProps('activateAllProjectsOnStartup')}>
                  <ToggleSwitch
                    checked={displayConfig.activateAllProjectsOnStartup}
                    onChange={(v) => handleUpdate({ activateAllProjectsOnStartup: v })}
                  />
                </SettingRow>
              </>
            )}

            {/* Reset all project overrides */}
            {isProjectScope && hasAnyOverrides && (
              <ResetOverridesFooter onReset={resetAllProjectOverrides} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helper: Setting Row ── */

function SettingRow({
  label,
  description,
  children,
  scope,
  globalOnly,
  isOverridden,
  onReset,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  scope?: 'global' | 'project';
  globalOnly?: boolean;
  isOverridden?: boolean;
  onReset?: () => void;
}) {
  const isProjectScope = scope === 'project';
  const isGlobalOnly = isProjectScope && globalOnly;

  return (
    <div className={`space-y-1.5 ${isGlobalOnly ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-fg-secondary">
            {isGlobalOnly && <Lock size={13} className="text-fg-faint flex-shrink-0" />}
            {label}
          </div>
          <div className="text-xs text-fg-faint">
            {description}
          </div>
        </div>
        {isOverridden && onReset && (
          <button
            onClick={onReset}
            title="Reset to global default"
            className="p-1 text-fg-faint hover:text-accent rounded transition-colors flex-shrink-0 mt-0.5"
            data-testid="setting-reset"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/* ── Helper: Custom Select ── */

function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className="appearance-none bg-surface-hover border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"
      >
        {children}
      </select>
      <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
    </div>
  );
}

/* ── Helper: Reset Overrides Footer ── */

function ResetOverridesFooter({ onReset }: { onReset: () => void }) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="pt-4 border-t border-edge">
      {showConfirm ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-muted">Reset all project overrides to global defaults?</span>
          <button
            onClick={() => { onReset(); setShowConfirm(false); }}
            className="text-xs text-red-400 hover:text-red-300 font-medium"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="text-xs text-fg-muted hover:text-fg-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowConfirm(true)}
          className="text-xs text-fg-muted hover:text-fg-secondary transition-colors"
        >
          Reset all project overrides
        </button>
      )}
    </div>
  );
}

/* ── Helper: Toggle Switch ── */

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-edge-input'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}
