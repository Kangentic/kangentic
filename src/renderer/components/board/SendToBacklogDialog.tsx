import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

/**
 * The app's Send to Backlog confirm, one copy for every surface that sends a
 * task to the backlog from its menu (the board card, a task detail window, an
 * Agent Monitor row), so the question and its Don't ask again never differ by
 * where it was asked. The sibling of `DeleteTaskDialog`.
 */
export function SendToBacklogDialog({ title, onConfirm, onCancel }: {
  title: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const taskTitle = title;
  return (
    <ConfirmDialog
      title={t`Send to Backlog`}
      message={<>
        <p><Trans>This will move "{taskTitle}" to the backlog and clean up its session and worktree.</Trans></p>
        <p className="text-fg-muted mt-1"><Trans>You can move it back to the board later.</Trans></p>
      </>}
      confirmLabel={t`Send to Backlog`}
      showDontAskAgain
      testId="send-to-backlog-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
