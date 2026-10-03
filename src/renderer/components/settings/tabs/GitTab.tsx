import { GitBranch, GitFork, GitPullRequest } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { BranchPicker } from '../../dialogs/BranchPicker';
import { SettingTextInput, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardToggleRow, SettingTag } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useToastStore } from '../../../stores/toast-store';
import { describeIpcError } from '../../../lib/ipc-error';

/**
 * Three cards: Branches (where work starts and how current it stays),
 * Worktrees (the feature switch and everything that only matters with it on),
 * and Pull requests. Only Worktrees has a master switch. Branches and pull
 * requests work either way, so their cards have no switch and always show.
 */
export function GitTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  const worktreesEnabled = config.git.worktreesEnabled;
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<GitBranch size={16} />}
        label="Branches"
        description="Where new work starts, and how current it stays."
        searchIds={['git.defaultBaseBranch', 'git.autoFetch']}
      >
        <CardRow {...settingProps('git.defaultBaseBranch')}>
          <BranchPicker
            variant="input"
            value={config.git.defaultBaseBranch}
            defaultBranch="main"
            onChange={(branch) => {
              updateProject({ git: { defaultBaseBranch: branch } });
              // The project setting above is saved either way. The team file
              // refuses the write when it exists but cannot be read (merge
              // conflict markers, say), and that refusal has to reach the user.
              window.electronAPI.boardConfig.setDefaultBaseBranch(branch).catch((error: unknown) => {
                useToastStore.getState().addToast({
                  message: `Could not save the base branch to kangentic.json. ${describeIpcError(error)}`,
                  variant: 'error',
                });
              });
            }}
          />
        </CardRow>
        <CardToggleRow
          {...settingProps('git.autoFetch')}
          checked={config.git.autoFetch}
          onChange={(value) => updateProject({ git: { autoFetch: value } })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<GitFork size={16} />}
        {...settingProps('git.worktreesEnabled')}
        searchIds={['git.autoCleanup', 'git.linkNodeModules', 'git.copyFiles', 'git.initScript']}
        checked={worktreesEnabled}
        onChange={(value) => updateProject({ git: { worktreesEnabled: value } })}
      >
        {worktreesEnabled ? (
          <>
            <CardToggleRow
              {...settingProps('git.autoCleanup')}
              checked={config.git.autoCleanup}
              onChange={(value) => updateProject({ git: { autoCleanup: value } })}
            />
            <CardToggleRow
              {...settingProps('git.linkNodeModules')}
              checked={config.git.linkNodeModules}
              onChange={(value) => updateProject({ git: { linkNodeModules: value } })}
            />
            <CardRow {...settingProps('git.copyFiles')}>
              {/* The split/trim/filter runs at the COMMIT, not per keystroke: typing
                  ".env, .env.local" used to write a differently-shaped array per character. */}
              <SettingTextInput
                value={(config.git.copyFiles ?? []).join(', ')}
                onCommit={(nextCopyFiles) => {
                  const files = nextCopyFiles.split(',').map((file) => file.trim()).filter(Boolean);
                  updateProject({ git: { copyFiles: files } });
                }}
                placeholder=".env, .env.local"
                ariaLabel="Files to copy into a worktree"
                className="placeholder-fg-faint"
              />
            </CardRow>
            <CardRow {...settingProps('git.initScript')}>
              <SettingTextInput
                value={config.git.initScript || ''}
                onCommit={(nextInitScript) => updateProject({ git: { initScript: nextInitScript || null } })}
                placeholder="npm install"
                ariaLabel="Worktree init script"
                className="placeholder-fg-faint"
              />
            </CardRow>
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard
        icon={<GitPullRequest size={16} />}
        label="Pull requests"
        description="How linked PRs are kept up to date."
        searchIds={['git.prAutoRefresh', 'git.prBypassCountsAsReady']}
      >
        <CardToggleRow
          {...settingProps('git.prAutoRefresh')}
          checked={config.git.prAutoRefresh}
          onChange={(value) => updateProject({ git: { prAutoRefresh: value } })}
        />
        {/* GitHub only: Kangentic does not read Azure DevOps bypass
            permissions, and Azure PRs always get their branch policies
            checked, so this is the one readiness choice left. */}
        <CardToggleRow
          {...settingProps('git.prBypassCountsAsReady')}
          checked={config.git.prBypassCountsAsReady}
          onChange={(value) => updateProject({ git: { prBypassCountsAsReady: value } })}
          labelTrailing={<SettingTag>GitHub</SettingTag>}
        />
      </SettingsCard>
    </div>
  );
}
