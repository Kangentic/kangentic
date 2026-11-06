import { finalMatchLine, normalizeForMatch } from './final-line-match';

/**
 * The line a workflow task's agent ends its reply with when it has decided the
 * task needs no change at all and nothing is left on its branch. The workflow
 * engine owns it, so it works in any column, for any agent, on any board, with
 * nothing to configure (owner's decision, 2026-11-05).
 *
 * The agent says it, and Kangentic checks it. An empty branch alone cannot
 * decide this: a task can reach a review column with its work not yet built,
 * and "empty means Done" would close it with nothing in it. An agent's word
 * alone cannot either, or it could skip review on real code. So the branch must
 * have no commits ahead of its base and a clean worktree (`workflow-step.ts`).
 * With both, the card goes straight to Done past the rest of its route.
 *
 * A question for the owner stays the `Needs owner:` line. This one ends the task.
 *
 * Matched in code against the reply's last line (`final-line-match.ts` picks
 * it): case and markdown marks are forgiven, as for `Needs owner:`. Stricter
 * than that line in one way: the reason is required. A review that passes can
 * end on the words "No changes needed.", and a card must never go to Done on a
 * sentence that was about something else.
 *
 * Every reader takes the line from here: the nudge (`workflow-recovery.ts`), the
 * `<workflow>` block (`prompt-xml.ts`) and the matcher below.
 * `tests/unit/workflow-no-changes.test.ts` pins them together.
 */

/** The line as an agent is told to write it. */
export const WORKFLOW_NO_CHANGES_LINE = 'No changes needed: <why>';

/**
 * The label and what ends it: a colon, or a dash with space around it. Markdown
 * marks and spacing may sit inside and around it (`**No changes needed:**`).
 */
const NO_CHANGES_LABEL_PATTERN = /no[\s*_`~-]+changes?[\s*_`~-]+needed[\s*_`~]*(?::|\s-+\s)/i;

/**
 * Why the agent says no change is needed, when its reply ends on the line: the
 * text after the label, as written. Null when the reply does not end on the
 * line, or the line gives no reason.
 */
export function noChangesReason(reply: string | null | undefined): string | null {
  const line = finalMatchLine(reply);
  if (line === null) return null;
  const label = NO_CHANGES_LABEL_PATTERN.exec(line);
  // The line starts with the label: only marks (a list marker, emphasis) before it.
  if (!label || normalizeForMatch(line.slice(0, label.index)) !== '') return null;
  const afterLabel = line.slice(label.index + label[0].length);
  const reason = afterLabel.replace(/^[\s:*_`~,;-]+/, '').replace(/[\s*_`~]+$/, '');
  return normalizeForMatch(reason) === '' ? null : reason;
}
