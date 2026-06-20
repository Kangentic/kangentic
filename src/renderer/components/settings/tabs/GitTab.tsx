import type { AppConfig } from '../../../../shared/types';
import { BranchPicker } from '../../dialogs/BranchPicker';
import { SettingRow, SettingToggleRow, Select, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

/** Preset cadences for the background PR-state refresh timer. "off" disables the timer (the on-open sweep still runs). */
const PR_REFRESH_OPTIONS: { value: string; label: string }[] = [
  { value: '2', label: 'Every 2 minutes' },
  { value: '5', label: 'Every 5 minutes' },
  { value: '10', label: 'Every 10 minutes' },
  { value: '15', label: 'Every 15 minutes' },
  { value: 'off', label: 'Off' },
];

export function GitTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <>
      <SettingToggleRow
        {...settingProps('git.worktreesEnabled')}
        checked={config.git.worktreesEnabled}
        onChange={(value) => updateProject({ git: { worktreesEnabled: value } })}
      />
      <SettingToggleRow
        {...settingProps('git.autoCleanup')}
        checked={config.git.autoCleanup}
        onChange={(value) => updateProject({ git: { autoCleanup: value } })}
      />
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
      <SettingToggleRow
        {...settingProps('git.linkNodeModules')}
        checked={config.git.linkNodeModules}
        onChange={(value) => updateProject({ git: { linkNodeModules: value } })}
      />
      <SettingRow {...settingProps('git.prRefreshIntervalMinutes')}>
        <Select
          value={config.git.prRefreshIntervalMinutes == null ? 'off' : String(config.git.prRefreshIntervalMinutes)}
          onChange={(event) => {
            const raw = event.target.value;
            updateProject({ git: { prRefreshIntervalMinutes: raw === 'off' ? null : parseInt(raw, 10) } });
          }}
        >
          {PR_REFRESH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      </SettingRow>
    </>
  );
}
