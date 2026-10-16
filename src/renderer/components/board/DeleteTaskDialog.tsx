import React from 'react';
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
  return (
    <ConfirmDialog
      title="Delete task"
      message={<>
        <p>This will permanently delete &quot;{title}&quot; and its session data.</p>
        <p className="text-red-400 font-medium">This action cannot be undone.</p>
      </>}
      confirmLabel="Delete"
      variant="danger"
      showDontAskAgain
      testId="delete-task-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
