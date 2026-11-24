import { ArrowUp, GitCommitHorizontal, GitPullRequestCreate } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { KebabMenuItem } from '../../KebabMenu';
import type { GitActions } from './useGitActions';

/** The git actions that apply now, as menu items, for the task window and the Command Terminal alike. */
export function GitMenuItems({ git, close }: { git: GitActions; close: () => void }) {
  const { t } = useLingui();
  const { available, disabledReason, commitDisabledReason } = git;
  return (
    <>
      {available.commit && (
        <KebabMenuItem
          icon={<GitCommitHorizontal size={14} />}
          label={t`Commit...`}
          onClick={() => { close(); git.openCommit(); }}
          disabled={commitDisabledReason !== null}
          disabledReason={commitDisabledReason}
          data-testid="kebab-git-commit"
        />
      )}
      {available.push && (
        <KebabMenuItem
          icon={<ArrowUp size={14} />}
          label={available.push === 'publish' ? t`Publish branch` : t({ message: 'Push', context: 'git action' })}
          onClick={() => { close(); git.push(); }}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          data-testid="kebab-git-push"
        />
      )}
      {available.createPullRequest && (
        <KebabMenuItem
          icon={<GitPullRequestCreate size={14} />}
          label={t`Create pull request...`}
          onClick={() => { close(); git.openCreatePullRequest(); }}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          data-testid="kebab-git-create-pr"
        />
      )}
    </>
  );
}
