import React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

/**
 * The app's Delete task confirm, one copy for every surface that deletes a
 * task from its menu (the board card, a Workflows canvas card, an Agent Monitor
 * row), so the
 * question and its Don't ask again never differ by where it was asked.
 */
export function DeleteTaskDialog({ title, onConfirm, onCancel }: {
  title: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const taskTitle = title;
  return (
    <ConfirmDialog
      title={t`Delete task`}
      message={<>
        <p><Trans>This will permanently delete "{taskTitle}" and its session data.</Trans></p>
        <p className="text-red-400 font-medium"><Trans>This action cannot be undone.</Trans></p>
      </>}
      confirmLabel={t`Delete`}
      variant="danger"
      showDontAskAgain
      testId="delete-task-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
