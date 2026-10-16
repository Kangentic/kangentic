import React from 'react';
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
  return (
    <ConfirmDialog
      title="Send to Backlog"
      message={<>
        <p>This will move &quot;{title}&quot; to the backlog and clean up its session and worktree.</p>
        <p className="text-fg-muted mt-1">You can move it back to the board later.</p>
      </>}
      confirmLabel="Send to Backlog"
      showDontAskAgain
      testId="send-to-backlog-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
