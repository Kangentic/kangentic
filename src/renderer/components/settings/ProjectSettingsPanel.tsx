import React, { useEffect, useState } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { BranchPicker } from '../dialogs/BranchPicker';
import { SettingsPanelShell, SectionHeader, SettingRow, Select, ToggleSwitch, ResetOverridesFooter, INPUT_CLASS } from './shared';
import type { AppConfig, DeepPartial, PermissionMode } from '../../../shared/types';
import { deepMergeConfig } from '../../../shared/object-utils';

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

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells).catch(() => {});
  }, []);

  const handleClose = () => setProjectSettingsOpen(false);

  const displayConfig = projectOverrides
    ? deepMergeConfig(globalConfig, projectOverrides as Record<string, unknown>)
    : globalConfig;

  const handleUpdate = (partial: DeepPartial<AppConfig>) => {
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

  return (
    <SettingsPanelShell title="Settings" subtitle={projectSettingsProjectName || undefined} onClose={handleClose}>
      {/* ── Terminal ── */}
      <SectionHeader label="Terminal" />
      <SettingRow
        label="Shell"
        description="Terminal shell used for agent sessions"
        isOverridden={isOverridden('terminal.shell')}
        onReset={() => removeProjectOverride('terminal.shell')}
        inheritedHint={defaultHint(globalConfig.terminal.shell)}
      >
        <Select
          value={displayConfig.terminal.shell || ''}
          onChange={(event) => handleUpdate({ terminal: { shell: event.target.value || null } })}
        >
          <option value="">Auto-detect</option>
          {shells.map((shell) => (
            <option key={shell.path} value={shell.path}>{shell.name}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        label="Font Size"
        description="Terminal text size in pixels"
        isOverridden={isOverridden('terminal.fontSize')}
        onReset={() => removeProjectOverride('terminal.fontSize')}
        inheritedHint={defaultHint(globalConfig.terminal.fontSize)}
      >
        <input
          type="number"
          value={displayConfig.terminal.fontSize}
          onChange={(event) => handleUpdate({ terminal: { fontSize: Number(event.target.value) } })}
          min={8}
          max={32}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow
        label="Font Family"
        description="CSS font-family for the terminal"
        isOverridden={isOverridden('terminal.fontFamily')}
        onReset={() => removeProjectOverride('terminal.fontFamily')}
        inheritedHint={defaultHint(globalConfig.terminal.fontFamily)}
      >
        <input
          type="text"
          value={displayConfig.terminal.fontFamily}
          onChange={(event) => handleUpdate({ terminal: { fontFamily: event.target.value } })}
          className={INPUT_CLASS}
        />
      </SettingRow>

      {/* ── Agent ── */}
      <SectionHeader label="Agent" />
      <SettingRow
        label="Permissions"
        description="How Claude handles tool approvals"
        isOverridden={isOverridden('claude.permissionMode')}
        onReset={() => removeProjectOverride('claude.permissionMode')}
        inheritedHint={defaultHint(globalConfig.claude.permissionMode)}
      >
        <Select
          value={displayConfig.claude.permissionMode}
          onChange={(event) => handleUpdate({ claude: { permissionMode: event.target.value as PermissionMode } })}
        >
          <option value="default">Default (Allowlist)</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="bypass-permissions">Bypass (Unsafe)</option>
        </Select>
      </SettingRow>

      {/* ── Git ── */}
      <SectionHeader label="Git" />
      <SettingRow
        label="Enable Worktrees"
        description="Create git worktrees for agent tasks"
        isOverridden={isOverridden('git.worktreesEnabled')}
        onReset={() => removeProjectOverride('git.worktreesEnabled')}
        inheritedHint={defaultHint(globalConfig.git.worktreesEnabled)}
      >
        <ToggleSwitch
          checked={displayConfig.git.worktreesEnabled}
          onChange={(value) => handleUpdate({ git: { worktreesEnabled: value } })}
        />
      </SettingRow>
      <SettingRow
        label="Auto-cleanup"
        description="Remove worktrees when tasks complete"
        isOverridden={isOverridden('git.autoCleanup')}
        onReset={() => removeProjectOverride('git.autoCleanup')}
        inheritedHint={defaultHint(globalConfig.git.autoCleanup)}
      >
        <ToggleSwitch
          checked={displayConfig.git.autoCleanup}
          onChange={(value) => handleUpdate({ git: { autoCleanup: value } })}
        />
      </SettingRow>
      <SettingRow
        label="Default Base Branch"
        description="Branch to create worktrees from"
        isOverridden={isOverridden('git.defaultBaseBranch')}
        onReset={() => removeProjectOverride('git.defaultBaseBranch')}
        inheritedHint={defaultHint(globalConfig.git.defaultBaseBranch)}
      >
        <BranchPicker
          variant="input"
          value={displayConfig.git.defaultBaseBranch}
          defaultBranch="main"
          onChange={(branch) => handleUpdate({ git: { defaultBaseBranch: branch } })}
        />
      </SettingRow>
      <SettingRow
        label="Copy Files"
        description="Additional files copied into each worktree"
        isOverridden={isOverridden('git.copyFiles')}
        onReset={() => removeProjectOverride('git.copyFiles')}
        inheritedHint={defaultHint(globalConfig.git.copyFiles)}
      >
        <input
          type="text"
          value={displayConfig.git.copyFiles.join(', ')}
          onChange={(event) => {
            const files = event.target.value.split(',').map((file) => file.trim()).filter(Boolean);
            handleUpdate({ git: { copyFiles: files } });
          }}
          placeholder=".env, .env.local"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow
        label="Post-Worktree Script"
        description="Shell script to run after worktree creation"
        isOverridden={isOverridden('git.initScript')}
        onReset={() => removeProjectOverride('git.initScript')}
        inheritedHint={defaultHint(globalConfig.git.initScript)}
      >
        <input
          type="text"
          value={displayConfig.git.initScript || ''}
          onChange={(event) => handleUpdate({ git: { initScript: event.target.value || null } })}
          placeholder="npm install"
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>

      {/* Reset all */}
      {hasAnyOverrides && (
        <ResetOverridesFooter onReset={resetAllProjectOverrides} />
      )}
    </SettingsPanelShell>
  );
}
