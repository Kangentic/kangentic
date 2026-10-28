import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/runtime-macro';
import type { WorkflowSummary } from '../../../shared/types';

/**
 * The Workflows view's sentences that are built from counts and lists, outside
 * any one component. Each part is a whole message with its own plural, and the
 * parts that are clauses join through `Intl.ListFormat` in the session's
 * language (English reads "a, b, c"), so no word order or separator is fixed in
 * code. Resolved at call time, after the session's catalog loads.
 */

/** "9 tasks", or "1 task". */
export function tasksText(taskCount: number): string {
  return i18n._(msg`${plural({ taskCount }, { one: '# task', other: '# tasks' })}`);
}

/** "Stalled on #412", or "Stalled on 3 tasks". */
export function stalledLine(stalled: WorkflowSummary['stalledTasks']): string {
  if (stalled.length === 1) {
    const displayId = stalled[0].displayId;
    return i18n._(msg`Stalled on #${{ displayId }}`);
  }
  const stalledCount = stalled.length;
  return i18n._(msg`Stalled on ${plural({ stalledCount }, { one: '# task', other: '# tasks' })}`);
}

/** Each stalled task and why, for the stalled mark's tooltip. The reasons are whole sentences from main. */
export function stalledTip(stalled: WorkflowSummary['stalledTasks']): string {
  const entries = stalled.map((entry) => {
    const displayId = entry.displayId;
    const reason = entry.reason;
    return i18n._(msg`#${{ displayId }}: ${{ reason }}`);
  });
  // Unit narrow joins sentences with a space in English and with none where the script has no spaces.
  return new Intl.ListFormat(i18n.locale, { type: 'unit', style: 'narrow' }).format(entries);
}

/** "2 in progress, 1 queued, 3 blocked": only the counts above zero. */
export function countsLine(summary: Pick<WorkflowSummary, 'inProgressCount' | 'queuedCount' | 'blockedCount'>): string {
  const parts: string[] = [];
  const inProgressCount = summary.inProgressCount;
  const queuedCount = summary.queuedCount;
  const blockedCount = summary.blockedCount;
  if (inProgressCount > 0) parts.push(i18n._(msg`${{ inProgressCount }} in progress`));
  if (queuedCount > 0) parts.push(i18n._(msg`${{ queuedCount }} queued`));
  if (blockedCount > 0) parts.push(i18n._(msg`${{ blockedCount }} blocked`));
  return new Intl.ListFormat(i18n.locale, { type: 'unit', style: 'short' }).format(parts);
}

/** "2 of 9 done". */
export function progressText(doneCount: number, taskCount: number): string {
  return i18n._(msg`${{ doneCount }} of ${{ taskCount }} done`);
}

/** The progress bar's tip and name: "2 of 9 done. 1 in progress, 6 queued." */
export function progressBarTitle(progress: string, counts: string): string {
  return counts
    ? i18n._(msg`${{ progress }}. ${{ counts }}.`)
    : i18n._(msg`${{ progress }}.`);
}
