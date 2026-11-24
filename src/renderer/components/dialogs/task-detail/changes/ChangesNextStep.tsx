import type { ReactNode } from 'react';
import { ArrowUp, GitCommitHorizontal, GitPullRequest, LoaderCircle } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { Tooltip } from '../../../Tooltip';
import type { GitActions } from '../../git/useGitActions';

/** The panel's muted action button. Never an accent fill, which read as the whole window's primary action. */
const BUTTON_CLASS = 'inline-flex h-[26px] flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-edge/50 bg-surface-hover/30 px-2.5 text-xs text-fg-secondary transition-colors hover:border-edge hover:bg-surface-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:border-edge/50 disabled:hover:bg-surface-hover/30 disabled:hover:text-fg-secondary';

/**
 * The line under the Changes panel's branch row: what this checkout needs next,
 * one step at a time, and the button that does it. Nothing to do draws nothing.
 */
export function ChangesNextStep({ git }: { git: GitActions }) {
  const { t } = useLingui();
  const { state, nextStep, busy, disabledReason, commitDisabledReason } = git;
  if (!state || nextStep === null) return null;

  const fileCount = state.uncommittedFileCount;
  const commitCount = state.unpushedCommitCount;
  let text: string;
  let label: string;
  let icon: ReactNode;
  let onClick: () => void;
  let reason = disabledReason;
  switch (nextStep) {
    case 'commit':
      text = t`${plural(fileCount, { one: '# changed file', other: '# changed files' })}`;
      label = t({ message: 'Commit', context: 'git action' });
      icon = <GitCommitHorizontal size={12} />;
      onClick = git.openCommit;
      reason = commitDisabledReason;
      break;
    case 'publish':
      text = t`Branch not published`;
      label = t`Publish branch`;
      icon = <ArrowUp size={12} />;
      onClick = git.push;
      break;
    case 'push':
      text = t`${plural(commitCount, { one: '# local commit', other: '# local commits' })}`;
      label = t({ message: 'Push', context: 'git action' });
      icon = <ArrowUp size={12} />;
      onClick = git.push;
      break;
    case 'create-pull-request':
      text = t`No pull request`;
      label = t`Create pull request`;
      icon = <GitPullRequest size={12} />;
      onClick = git.openCreatePullRequest;
      break;
  }

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-2 py-2" data-testid="changes-next-step" data-step={nextStep}>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{text}</span>
      <Tooltip label={reason ?? ''}>
        <button
          type="button"
          onClick={onClick}
          disabled={reason !== null}
          className={BUTTON_CLASS}
          data-testid="changes-next-step-button"
        >
          {busy !== null
            ? <LoaderCircle size={12} className="flex-shrink-0 animate-spin" aria-hidden="true" />
            : <span aria-hidden="true" className="flex flex-shrink-0 opacity-70">{icon}</span>}
          {label}
        </button>
      </Tooltip>
    </div>
  );
}
