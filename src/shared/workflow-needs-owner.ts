import { finalMatchLine, normalizeForMatch } from './final-line-match';

/**
 * The line a workflow task's agent ends its reply with when only the owner
 * can settle what it is stuck on. The workflow engine owns it, so it works on
 * any board: no column has to declare a Text match for it.
 *
 * The step check decides only whether the agent stalled. Whether a stall needs
 * the owner is the agent's own call (owner's decision, 2026-10-31): the unblock
 * nudge, and the `<workflow>` block every workflow task starts with, tell it to
 * end on this line for a change from the plan, something the owner must weigh
 * in on, or a decision between options, and to act otherwise. A reply that ends
 * on it is the one way a workflow task stops and notifies the owner.
 *
 * Matched in code against the reply's last line (`final-line-match.ts` picks
 * it): case and markdown marks are forgiven, so `**Needs owner:** keep the old
 * export?` matches. The label ends at a colon or a spaced dash, or ends the
 * line, so a last sentence that only starts with the words ("Needs owner
 * sign-off is not required here.") is not the line.
 *
 * Every reader takes the line from here: the nudge
 * (`workflow-recovery.ts`), the `<workflow>` block (`prompt-xml.ts`) and the
 * matcher below. `tests/unit/workflow-needs-owner.test.ts` pins them together.
 */

/** The line as an agent is told to write it. */
export const WORKFLOW_NEEDS_OWNER_LINE = 'Needs owner: <the question>';

/**
 * The label and what ends it: a colon, a dash with space around it, or the end
 * of the line. Markdown marks and spacing may sit inside and around it
 * (`**Needs owner:**`, `Needs-owner:`).
 */
const NEEDS_OWNER_LABEL_PATTERN = /needs[\s*_`~-]*owner[\s*_`~]*(?::|\s-+\s|[.!?\s*_`~]*$)/i;

/**
 * What the agent asks the owner, when its reply ends on the line: the text
 * after the label, as written. An empty string when the line names no
 * question. Null when the reply does not end on the line.
 */
export function needsOwnerQuestion(reply: string | null | undefined): string | null {
  const line = finalMatchLine(reply);
  if (line === null) return null;
  const label = NEEDS_OWNER_LABEL_PATTERN.exec(line);
  // The line starts with the label: only marks (a list marker, emphasis) before it.
  if (!label || normalizeForMatch(line.slice(0, label.index)) !== '') return null;
  // Drop the marks after the label, and keep the question as the agent wrote it.
  const afterLabel = line.slice(label.index + label[0].length);
  const question = afterLabel.replace(/^[\s:*_`~.,;-]+/, '').replace(/[\s*_`~]+$/, '');
  return normalizeForMatch(question) === '' ? '' : question;
}
