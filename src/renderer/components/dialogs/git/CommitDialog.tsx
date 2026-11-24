import { useEffect, useRef, useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { BaseDialog, DialogFooterActions } from '../BaseDialog';
import { ToggleSwitch } from '../../settings/shared';
import { useConfigStore } from '../../../stores/config-store';
import { commitFileCount, type GitActionTarget, type GitWorkState } from '../../../../shared/git-work-state';
import { DraftTextField } from './DraftTextField';

interface CommitDialogProps {
  target: GitActionTarget;
  projectId: string | null;
  state: GitWorkState;
  /** The Automation agent can draft the message. */
  canDraft: boolean;
  /** Runs the commit. True closes the dialog; false keeps it, with the message. */
  onCommit: (message: string, pushAfter: boolean) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Commit a checkout. The message is drafted as the dialog opens, and the user
 * edits it or not. With no Automation agent it opens on the task's title.
 */
export function CommitDialog({ target, projectId, state, canDraft, onCommit, onClose }: CommitDialogProps) {
  const { t } = useLingui();
  const [message, setMessage] = useState('');
  const [drafting, setDrafting] = useState(true);
  const [committing, setCommitting] = useState(false);
  const pushAfter = useConfigStore((store) => store.config.gitPushAfterCommit);
  const updateConfig = useConfigStore((store) => store.updateConfig);
  const closeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const draft = async (force: boolean): Promise<void> => {
    setDrafting(true);
    try {
      const result = await window.electronAPI.git.draftText(target, { kind: 'commit-message', force }, projectId);
      if (!mountedRef.current) return;
      // A forced draft that no agent could write keeps what is there. The opening one never replaces
      // what the user has typed, which they can while there is no agent to wait for.
      if (force && result.drafted) setMessage(result.text);
      else if (!force) setMessage((current) => current || result.text);
    } catch { // report-ok: main reports a rejected draft; the user writes the message
      return;
    } finally {
      if (mountedRef.current) setDrafting(false);
    }
  };
  const draftRef = useRef(draft);
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    void draftRef.current(false);
  }, []);

  const trimmed = message.trim();
  const waitingForDraft = drafting && canDraft;
  const canCommit = trimmed !== '' && !waitingForDraft && !committing;
  const commit = async (): Promise<void> => {
    if (!canCommit) return;
    setCommitting(true);
    const close = await onCommit(trimmed, pushAfter);
    if (!mountedRef.current) return;
    setCommitting(false);
    if (close) closeRef.current?.();
  };

  const fileCount = commitFileCount(state);
  const branch = state.branch ?? '';
  return (
    <BaseDialog
      onClose={onClose}
      closeRef={closeRef}
      title={t`Commit changes`}
      subtitle={t`${plural(fileCount, { one: '# file', other: '# files' })} on ${branch}`}
      icon={<GitCommitHorizontal size={16} className="text-fg-muted" />}
      className="w-[480px]"
      trapFocus
      testId="git-commit-dialog"
      save={{ onSave: () => void commit(), disabled: !canCommit }}
      footer={(
        <DialogFooterActions
          onCancel={() => closeRef.current?.()}
          onConfirm={() => void commit()}
          confirmLabel={t({ message: 'Commit', context: 'git action' })}
          confirmDisabled={!canCommit}
          confirmTestId="git-commit-confirm"
          leading={(
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-fg-secondary">
              <ToggleSwitch
                checked={pushAfter}
                onChange={(value) => void updateConfig({ gitPushAfterCommit: value })}
                ariaLabel={t`Push after committing`}
                testId="git-commit-push-after"
              />
              {t`Push after committing`}
            </label>
          )}
        />
      )}
    >
      <DraftTextField
        label={t({ message: 'Message', context: 'commit message' })}
        value={message}
        onChange={setMessage}
        drafting={waitingForDraft}
        draftingLabel={t`Drafting a message...`}
        onDraft={canDraft ? () => void draft(true) : undefined}
        draftTip={t`Draft again`}
        disabled={committing}
        testId="git-commit-message"
      />
    </BaseDialog>
  );
}
