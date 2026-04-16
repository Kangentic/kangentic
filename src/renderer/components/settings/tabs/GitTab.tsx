import type { AppConfig } from '../../../../shared/types';
import { BranchPicker } from '../../dialogs/BranchPicker';
import { SettingRow, ToggleSwitch, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function GitTab({ config }: { config: AppConfig }) {
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
