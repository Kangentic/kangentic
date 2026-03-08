import React, { useEffect, useState } from 'react';
import { Bot, Check, CircleAlert, GitBranch, Globe, Palette, Shield, SlidersHorizontal, Terminal } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { SettingsPanelShell, SectionHeader, SettingRow, Select, ToggleSwitch, INPUT_CLASS } from './shared';
import type { SettingsTabDefinition } from './shared';
import type { AppConfig, DeepPartial, PermissionMode, ThemeMode } from '../../../shared/types';
import { NAMED_THEMES } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';

const APP_TABS: SettingsTabDefinition[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
  { id: 'privacy', label: 'Privacy', icon: Shield, separator: true },
];

export function AppSettingsPanel() {
  const globalConfig = useConfigStore((state) => state.globalConfig);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const claudeInfo = useConfigStore((state) => state.claudeInfo);
  const detectClaude = useConfigStore((state) => state.detectClaude);
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);

  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [pendingSyncPartial, setPendingSyncPartial] = useState<DeepPartial<AppConfig> | null>(null);

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells).catch(() => {});
    detectClaude();
  }, []);

  const handleClose = () => setSettingsOpen(false);

  /** Update an app-wide (non-default) setting. */
  const handleAppUpdate = (partial: DeepPartial<AppConfig>) => {
    updateConfig(partial);
  };

  /** Update a project-default setting -- may trigger sync modal. */
  const handleDefaultUpdate = (partial: DeepPartial<AppConfig>) => {
    setPendingSyncPartial(partial);
  };

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

  return (
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
    >
      {/* ── Appearance ── */}
      {activeTab === 'appearance' && (
        <SettingRow label="Theme" description="Color scheme for the interface">
          <Select
            value={displayConfig.theme}
            onChange={(event) => handleDefaultUpdate({ theme: event.target.value as ThemeMode })}
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
      )}

      {/* ── Terminal ── */}
      {activeTab === 'terminal' && (
        <>
          <SettingRow label="Shell" description="Terminal shell used for agent sessions">
            <Select
              value={displayConfig.terminal.shell || ''}
              onChange={(event) => handleDefaultUpdate({ terminal: { shell: event.target.value || null } })}
            >
              <option value="">Auto-detect</option>
              {shells.map((shell) => (
                <option key={shell.path} value={shell.path}>{shell.name}</option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow label="Font Size" description="Terminal text size in pixels">
            <input
              type="number"
              value={displayConfig.terminal.fontSize}
              onChange={(event) => handleDefaultUpdate({ terminal: { fontSize: Number(event.target.value) } })}
              min={8}
              max={32}
              className={INPUT_CLASS}
            />
          </SettingRow>
          <SettingRow label="Font Family" description="CSS font-family for the terminal">
            <input
              type="text"
              value={displayConfig.terminal.fontFamily}
              onChange={(event) => handleDefaultUpdate({ terminal: { fontFamily: event.target.value } })}
              className={INPUT_CLASS}
            />
          </SettingRow>
        </>
      )}

      {/* ── Agent ── */}
      {activeTab === 'agent' && (
        <>
          <SettingRow label="CLI Path" description="Path to Claude CLI binary (auto-detected if empty)">
            <div className="relative">
              <input
                type="text"
                value={globalConfig.claude.cliPath || ''}
                onChange={(event) => handleAppUpdate({ claude: { cliPath: event.target.value || null } })}
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
          <SettingRow label="Max Concurrent Sessions" description="Limit how many agents can run at the same time">
            <input
              type="number"
              value={globalConfig.claude.maxConcurrentSessions}
              onChange={(event) => handleAppUpdate({ claude: { maxConcurrentSessions: Number(event.target.value) } })}
              min={1}
              max={20}
              className={INPUT_CLASS}
            />
          </SettingRow>
          <SettingRow label="When Max Sessions Reached" description="How new agent requests are handled when all slots are in use">
            <Select
              value={globalConfig.claude.queueOverflow}
              onChange={(event) => handleAppUpdate({ claude: { queueOverflow: event.target.value as 'queue' | 'reject' } })}
            >
              <option value="queue">Queue</option>
              <option value="reject">Reject</option>
            </Select>
          </SettingRow>
          <SectionHeader label="Project Default" description="Default for new projects. Can optionally sync to existing projects." prominent />
          <SettingRow label="Permissions" description="How Claude handles tool approvals">
            <Select
              value={displayConfig.claude.permissionMode}
              onChange={(event) => handleDefaultUpdate({ claude: { permissionMode: event.target.value as PermissionMode } })}
            >
              <option value="default">Default (Allowlist)</option>
              <option value="acceptEdits">Accept Edits</option>
              <option value="bypass-permissions">Bypass (Unsafe)</option>
            </Select>
          </SettingRow>
        </>
      )}

      {/* ── Behavior ── */}
      {activeTab === 'behavior' && (
        <>
          <SettingRow label="Skip Task Delete Confirmation" description="Delete tasks immediately without a confirmation dialog">
            <ToggleSwitch
              checked={globalConfig.skipDeleteConfirm}
              onChange={(value) => handleAppUpdate({ skipDeleteConfirm: value })}
            />
          </SettingRow>
          <SettingRow label="Auto-Focus Idle Sessions" description="Automatically switch the bottom panel to the most recently idle session">
            <ToggleSwitch
              checked={globalConfig.autoFocusIdleSession}
              onChange={(value) => handleAppUpdate({ autoFocusIdleSession: value })}
            />
          </SettingRow>
          <SettingRow label="Desktop Notifications" description="Show native notifications when agents need attention on non-visible projects">
            <ToggleSwitch
              checked={globalConfig.notifyIdleOnInactiveProject}
              onChange={(value) => handleAppUpdate({ notifyIdleOnInactiveProject: value })}
            />
          </SettingRow>
          <SettingRow label="Launch All Projects on Startup" description="Start agents across all projects on launch, not just the current open one">
            <ToggleSwitch
              checked={globalConfig.activateAllProjectsOnStartup}
              onChange={(value) => handleAppUpdate({ activateAllProjectsOnStartup: value })}
            />
          </SettingRow>
        </>
      )}

      {/* ── Privacy ── */}
      {activeTab === 'privacy' && (
        <div className="space-y-3">
          <p className="text-sm text-fg-secondary leading-relaxed">
            Kangentic collects anonymous usage statistics to improve the product.
            No personal data is collected.
          </p>
          <p className="text-xs text-fg-muted leading-relaxed">
            Set <code className="text-fg-secondary font-mono">KANGENTIC_TELEMETRY=0</code> as
            an environment variable to opt out.
          </p>
        </div>
      )}

      {/* ── Git ── */}
      {activeTab === 'git' && (
        <>
          <SettingRow label="Enable Worktrees" description="Create git worktrees for agent tasks">
            <ToggleSwitch
              checked={displayConfig.git.worktreesEnabled}
              onChange={(value) => handleDefaultUpdate({ git: { worktreesEnabled: value } })}
            />
          </SettingRow>
          <SettingRow label="Auto-cleanup" description="Remove worktrees when tasks complete">
            <ToggleSwitch
              checked={displayConfig.git.autoCleanup}
              onChange={(value) => handleDefaultUpdate({ git: { autoCleanup: value } })}
            />
          </SettingRow>
          <SettingRow label="Default Base Branch" description="Branch to create worktrees from">
            <BranchPicker
              variant="input"
              value={displayConfig.git.defaultBaseBranch}
              defaultBranch="main"
              onChange={(branch) => handleDefaultUpdate({ git: { defaultBaseBranch: branch } })}
            />
          </SettingRow>
          <SettingRow label="Copy Files" description="Additional files copied into each worktree">
            <input
              type="text"
              value={displayConfig.git.copyFiles.join(', ')}
              onChange={(event) => {
                const files = event.target.value.split(',').map((file) => file.trim()).filter(Boolean);
                handleDefaultUpdate({ git: { copyFiles: files } });
              }}
              placeholder=".env, .env.local"
              className={`${INPUT_CLASS} placeholder-fg-faint`}
            />
          </SettingRow>
          <SettingRow label="Post-Worktree Script" description="Shell script to run after worktree creation">
            <input
              type="text"
              value={displayConfig.git.initScript || ''}
              onChange={(event) => handleDefaultUpdate({ git: { initScript: event.target.value || null } })}
              placeholder="npm install"
              className={`${INPUT_CLASS} placeholder-fg-faint`}
            />
          </SettingRow>
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
  );
}
