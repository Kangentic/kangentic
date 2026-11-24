import { useEffect, useRef, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { BaseDialog, DialogFooterActions } from '../BaseDialog';
import { BranchPicker } from '../BranchPicker';
import { Field, FIELD_CONTROL_CLASS } from '../../Field';
import { ToggleSwitch } from '../../settings/shared';
import { useConfigStore } from '../../../stores/config-store';
import { useBaseRefKind } from '../../../hooks/useBaseRefKind';
import { taskGitBase, type GitCreatePullRequestInput, type GitWorkState } from '../../../../shared/git-work-state';
import type { GitCheckout } from './useGitActions';
import { DraftTextField } from './DraftTextField';

interface CreatePullRequestDialogProps {
  checkout: GitCheckout;
  state: GitWorkState;
  /** The project's own base, for a checkout with no task or a base that is not a branch. */
  defaultBranch: string;
  canDraft: boolean;
  /** Creates it. True closes the dialog; false keeps it, with what was written. */
  onCreate: (input: GitCreatePullRequestInput) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Create a pull request from a checkout's branch. The branch it goes into sits in
 * the subtitle, where the sentence names it, and starts on the task's base.
 */
export function CreatePullRequestDialog({
  checkout, state, defaultBranch, canDraft, onCreate, onClose,
}: CreatePullRequestDialogProps) {
  const { t } = useLingui();
  const { target, projectId, task } = checkout;
  const taskTitle = task?.title ?? null;
  const baseBranch = task ? taskGitBase(task, '') : '';
  const [title, setTitle] = useState(taskTitle ?? '');
  const [body, setBody] = useState('');
  const [chosenBase, setChosenBase] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const asDraft = useConfigStore((store) => store.config.gitCreatePrAsDraft);
  const updateConfig = useConfigStore((store) => store.updateConfig);
  const closeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A tag or a commit cannot take a pull request.
  const taskBaseKind = useBaseRefKind(baseBranch, projectId, baseBranch.trim() !== '')?.kind ?? 'branch';
  const startingBase = taskBaseKind === 'branch' && baseBranch ? baseBranch : defaultBranch;
  const intoBranch = chosenBase || startingBase;
  const intoBranchRef = useRef(intoBranch);
  useEffect(() => { intoBranchRef.current = intoBranch; }, [intoBranch]);

  // With no task, the last commit says what the work is.
  useEffect(() => {
    if (taskTitle !== null) return;
    let cancelled = false;
    window.electronAPI.git.branchSummary({
      worktreePath: checkout.worktreePath ?? undefined, projectPath: checkout.projectPath, baseBranch: checkout.baseBranch,
    }).then((summary) => {
      if (!cancelled) setTitle((current) => current || (summary.lastCommit?.subject ?? ''));
    }, () => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, for the title the dialog opens on
  }, []);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const result = await window.electronAPI.git.draftText(
        target, { kind: 'pull-request-description', force: body.trim() !== '', baseBranch: intoBranch }, projectId,
      );
      // A draft of the diff against another base describes another pull request.
      if (mountedRef.current && result.drafted && intoBranchRef.current === intoBranch) setBody(result.text);
    } catch { // report-ok: main reports a rejected draft; the user writes the description
      return;
    } finally {
      if (mountedRef.current) setDrafting(false);
    }
  };

  const canCreate = title.trim() !== '' && !drafting && !creating;
  const create = async (): Promise<void> => {
    if (!canCreate) return;
    setCreating(true);
    const close = await onCreate({ title: title.trim(), body, baseBranch: intoBranch, draft: asDraft });
    if (!mountedRef.current) return;
    setCreating(false);
    if (close) closeRef.current?.();
  };

  const headBranch = state.pushTarget ?? state.branch ?? '';
  const draftLabel = t({ message: 'Draft PR', context: 'pull request state' });
  return (
    <BaseDialog
      onClose={onClose}
      closeRef={closeRef}
      title={t`Create pull request`}
      subtitle={(
        <span className="flex min-w-0 items-center gap-1.5">
          <Trans>
            <span className="min-w-0 truncate">{headBranch}</span> into
            {' '}
            <BranchPicker
              value={chosenBase}
              defaultBranch={startingBase}
              onChange={setChosenBase}
              variant="subtitle"
              projectId={projectId}
            />
          </Trans>
        </span>
      )}
      icon={<GitPullRequest size={16} className="text-fg-muted" />}
      className="w-[480px]"
      trapFocus
      testId="git-create-pr-dialog"
      save={{ onSave: () => void create(), disabled: !canCreate }}
      footer={(
        <DialogFooterActions
          onCancel={() => closeRef.current?.()}
          onConfirm={() => void create()}
          confirmLabel={t`Create pull request`}
          confirmDisabled={!canCreate}
          confirmTestId="git-create-pr-confirm"
          leading={(
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-fg-secondary">
              <ToggleSwitch
                checked={asDraft}
                onChange={(value) => void updateConfig({ gitCreatePrAsDraft: value })}
                ariaLabel={draftLabel}
                testId="git-create-pr-draft"
              />
              {draftLabel}
            </label>
          )}
        />
      )}
    >
      <div className="space-y-3">
        <Field label={t({ message: 'Title', context: 'pull request' })}>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={creating}
            className={FIELD_CONTROL_CLASS}
            data-testid="git-create-pr-title"
          />
        </Field>
        <DraftTextField
          label={t`Description`}
          value={body}
          onChange={setBody}
          placeholder={t({ message: 'Optional', context: 'pull request description' })}
          drafting={drafting}
          draftingLabel={t`Drafting a description...`}
          onDraft={canDraft ? () => void draft() : undefined}
          draftTip={t`Draft a description`}
          disabled={creating}
          testId="git-create-pr-body"
        />
      </div>
    </BaseDialog>
  );
}
