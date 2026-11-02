import { CircleStop, GitBranch, GitFork, GitPullRequest } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import { BranchPicker } from '../../dialogs/BranchPicker';
import { SettingTextInput, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardToggleRow, SettingTag } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { useToastStore } from '../../../stores/toast-store';
import { describeIpcError, asSentence } from '../../../lib/ipc-error';

/**
 * Four cards: Branches (where work starts and how current it stays), Worktrees
 * (the feature switch and everything that only matters with it on), Leftover
 * processes (the project's Stop script), and Pull requests. Only Worktrees has a
 * master switch. The others work either way, so they have no switch and always
 * show.
 */
export function GitTab({ config }: { config: AppConfig }) {
  const { t } = useLingui();
  const updateProject = useScopedUpdate('project');
  const worktreesEnabled = config.git.worktreesEnabled;
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<GitBranch size={16} />}
        label={t`Branches`}
        description={t`Where new work starts, and how current it stays.`}
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
                  title: t`Couldn't save base branch`,
                  message: asSentence(describeIpcError(error)),
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
        searchIds={['git.autoCleanup', 'git.linkNodeModules', 'git.copyFiles', 'git.initScript', 'git.holdPromptForInitScript']}
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
                // i18n-ok: example file names
                placeholder=".env, .env.local"
                ariaLabel={t`Files to copy into a worktree`}
                className="placeholder-fg-faint"
              />
            </CardRow>
            <CardRow {...settingProps('git.initScript')}>
              <SettingTextInput
                value={config.git.initScript || ''}
                onCommit={(nextInitScript) => updateProject({ git: { initScript: nextInitScript || null } })}
                // i18n-ok: an example shell command
                placeholder="npm install"
                ariaLabel={t`Worktree init script`}
                className="placeholder-fg-faint"
              />
            </CardRow>
            {config.git.initScript?.trim() ? (
              <CardToggleRow
                {...settingProps('git.holdPromptForInitScript')}
                checked={config.git.holdPromptForInitScript}
                onChange={(value) => updateProject({ git: { holdPromptForInitScript: value } })}
              />
            ) : null}
          </>
        ) : null}
      </SettingsCard>

      {/* Not in the Worktrees card: the script also runs in the project folder
          for a task with no worktree, so a project with worktrees off needs it. */}
      <SettingsCard
        icon={<CircleStop size={16} />}
        label={t`Leftover processes`}
        description={t`How this project stops what a task leaves running.`}
        searchIds={['git.stopScript']}
      >
        <CardRow {...settingProps('git.stopScript')}>
          <SettingTextInput
            value={config.git.stopScript || ''}
            onCommit={(nextStopScript) => {
              // Saved in kangentic.json alone, so the row reads it back from there.
              window.electronAPI.boardConfig.setStopScript(nextStopScript || null).then(
                () => useConfigStore.getState().loadConfig(),
                (error: unknown) => {
                  useToastStore.getState().addToast({
                    title: t`Couldn't save Stop script`,
                    message: asSentence(describeIpcError(error)),
                    variant: 'error',
                  });
                },
              );
            }}
            // i18n-ok: an example shell command
            placeholder="npm run stop"
            ariaLabel={t`Stop script`}
            className="placeholder-fg-faint"
          />
        </CardRow>
      </SettingsCard>

      <SettingsCard
        icon={<GitPullRequest size={16} />}
        label={t`Pull requests`}
        description={t`How linked PRs are kept up to date.`}
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
          // i18n-ok: product name
          labelTrailing={<SettingTag>GitHub</SettingTag>}
        />
      </SettingsCard>
    </div>
  );
}
