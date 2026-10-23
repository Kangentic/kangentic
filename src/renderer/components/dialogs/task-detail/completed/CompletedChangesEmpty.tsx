import { GitCommitHorizontal } from 'lucide-react';
import type { GitTaskChangesEmptyReason } from '../../../../../shared/types';

/** Why a completed task has no changes to show, as the one line under the icon. */
export const EMPTY_REASON_COPY: Record<GitTaskChangesEmptyReason, string> = {
  'no-commits': 'No commits for this task',
  'indexing-off': 'Indexing is off, so no commits are linked',
  'not-in-clone': 'This task\'s commits are not in this clone',
};

/**
 * A completed task's empty Changes, wherever its Changes show: the tab and the
 * detached window.
 */
export function CompletedChangesEmpty({ reason }: { reason: GitTaskChangesEmptyReason }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 p-4 text-center" data-testid={`completed-changes-empty-${reason}`}>
      <GitCommitHorizontal size={24} className="text-fg-disabled" />
      <span className="text-sm text-fg-muted">{EMPTY_REASON_COPY[reason]}</span>
    </div>
  );
}
