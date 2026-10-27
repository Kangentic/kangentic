import { GitCommitHorizontal } from 'lucide-react';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../../i18n/translate';
import type { LocalizedText } from '../../../../../shared/i18n/text';
import type { GitTaskChangesEmptyReason } from '../../../../../shared/types';

/**
 * Why a completed task has no changes to show, as the one line under the icon.
 * Descriptors, resolved with `translateText` where they render. CommitGraphPanel
 * reads this record directly, so it resolves them too.
 */
export const EMPTY_REASON_COPY: Record<GitTaskChangesEmptyReason, LocalizedText> = {
  'no-commits': msg`No commits for this task`,
  'indexing-off': msg`Indexing is off, so no commits are linked`,
  'not-in-clone': msg`This task's commits are not in this clone`,
};

/**
 * A completed task's empty Changes, wherever its Changes show: the tab and the
 * detached window.
 */
export function CompletedChangesEmpty({ reason }: { reason: GitTaskChangesEmptyReason }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 p-4 text-center" data-testid={`completed-changes-empty-${reason}`}>
      <GitCommitHorizontal size={24} className="text-fg-disabled" />
      <span className="text-sm text-fg-muted">{translateText(EMPTY_REASON_COPY[reason])}</span>
    </div>
  );
}
