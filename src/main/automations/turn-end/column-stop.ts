import { automationMovesTask } from '../../../shared/automation-manifest';
import { matchFinalLine, matchUserMessage, type UserMessageRead } from '../../../shared/final-line-match';
import type { ColumnAutomation } from '../../../shared/types';
import { needsOwnerQuestion } from '../../../shared/workflow-needs-owner';
import type { AutomationRunRepository } from '../../db/repositories/automation-run-repository';
import { frequencyLimitReason } from '../automation-runner';
import type { ConditionCheckOutcome } from '../condition-check/condition-check';
import { hasCondition, hasFinalLine, hasUserTextMatch, textMatchSourceOf } from '../row-guards';

/**
 * Has the board stopped this card? Asked at the end of a turn-end pass in a
 * column with rows, once nothing is left to act: no row moved the task or
 * messaged the agent. The answer is what `agent-stopped` is drawn from
 * (`stopped-mark.ts`), and it knows nothing about any board: only a row's own
 * Frequency, Text match and Condition, and what the agent said.
 *
 * In order, with one model call at most:
 *
 * 1. Free, in code. A spent row that moves the task and would have run: it has
 *    no guard, or its Text match meets the reply. Or a reply that ends on
 *    `Needs owner:`.
 * 2. One call on the Automation agent: each spent move row's own Condition,
 *    plus the built-in question below. A check answers no when the facts do not
 *    say, so only a card we know is stopped wears the mark.
 * 3. With no Automation agent, step 1 alone, and no record of the gap: it would
 *    be written at every turn end of every board that has none.
 *
 * A workflow task never comes here. Its agent classifies itself with
 * `Needs owner:` (owner's decision, 2026-10-31), and recovery still nudges a
 * spent row, so a verdict here would stop recovery or show the mark while it
 * tries.
 */

/** The check's row id for the built-in question, which names no column automation. */
export const NEEDS_A_PERSON_CHECK_ID = 'column-stop-check';

/**
 * What the Automation agent is asked of the reply. Any words count, in any
 * language: "Blocked", "Needs owner", "Can't continue until you sign in".
 *
 * Measured with `scripts/eval-condition-check.mjs` at Haiku low, three runs each
 * (2026-11-05), on 54 real turn endings from this repo's board plus 24 written
 * ones, German, Japanese and Spanish among them. A false positive puts the mark
 * on a healthy card, so the bar was none: 0 of 168 negative answers said yes,
 * across finished reports with long follow-up lists, review tables that read
 * "blocked", `Verdict: Blocked` over steps an agent can do, and optional offers.
 * 64 of 66 positive answers said yes. The 2 misses were one run each on two
 * replies, and a miss leaves the envelope. About $0.0005 a call.
 *
 * Those are final labels, not first ones. This wording first disagreed with six
 * replies labelled negative from their last lines alone. Read whole, five say a
 * person must act and were relabelled positive. The sixth files "a decision from
 * you" under later, and was left out as ambiguous. The wording itself never
 * changed. So the corpus has no case of it being shown wrong, and a reply that
 * only mentions a person's step in passing can still read as a stop.
 */
export const NEEDS_A_PERSON_CONDITION = 'The agent says it cannot go on with this work until a person does something only a person can do, such as '
  + 'signing in, granting access, approving a change or making a decision between options, and it has stopped to wait for that. '
  + 'A report of what it did, a table or list that mentions something blocked, steps it can do itself, a progress note, or an optional offer '
  + 'or question at the end of finished work does not count.';

/** Why a `reply` stop ended at a turn that said nothing to judge. */
const NO_MESSAGE_REASON = 'The agent\'s last turn ended with no message.';

/** Answers the step 2 question for a spent row's Conditions and, when asked, the built-in one. */
export type ColumnStopCheck = (conditionRows: ColumnAutomation[], askNeedsAPerson: boolean) => Promise<ConditionCheckOutcome>;

export interface JudgeColumnStopInput {
  taskId: string;
  swimlaneId: string;
  /** The column's turn-end rows the column can run, spent ones included. */
  rows: readonly ColumnAutomation[];
  runs: AutomationRunRepository;
  visitStartedAt: string | null;
  readReply: () => Promise<string | null>;
  /**
   * The user's last message in the turn, for a spent row whose Text match is
   * on it (#1078). Absent, such a row reads as not met (fail closed).
   */
  readUserMessage?: () => Promise<UserMessageRead>;
  check: ColumnStopCheck;
  /** Whether the turn this judges is still the task's latest, in this column. */
  stillCurrent: () => boolean;
}

/** A row that moves the task and has run its limit on it, with the runner's reason. */
interface SpentMoveRow {
  row: ColumnAutomation;
  limitReason: string;
}

function spentMoveRows(input: JudgeColumnStopInput): SpentMoveRow[] {
  return input.rows.flatMap((row) => {
    const limitReason = automationMovesTask(row.type) ? frequencyLimitReason(row, input.runs, input.taskId) : null;
    return limitReason === null ? [] : [{ row, limitReason }];
  });
}

function spentReason({ row, limitReason }: SpentMoveRow): string {
  return `"${row.name}" would have moved the card. ${limitReason}`;
}

/** Record a stop from what the agent said, unless the visit already stands on one. */
function recordReplyStop(input: JudgeColumnStopInput, alreadyStopped: boolean, reason: string, backgroundCallId?: string | null): void {
  if (alreadyStopped) return;
  input.runs.recordColumnStop({ taskId: input.taskId, swimlaneId: input.swimlaneId, cause: 'reply', reason, backgroundCallId });
}

/** A `reply` stop the agent's newest turn no longer bears out. */
function clearReplyStop(input: JudgeColumnStopInput, stopped: boolean, reason: string, backgroundCallId?: string | null): void {
  if (!stopped) return;
  input.runs.recordColumnStopCleared({ taskId: input.taskId, swimlaneId: input.swimlaneId, reason, backgroundCallId });
}

/**
 * Write what this turn means for the card's stop. A spent row's stop is sticky
 * for the visit, since only a person's move starts that count over. A stop from
 * the agent's words is replaced by the next turn's answer, so a person who
 * settles it in the column clears the mark. A turn that wrote no message clears
 * it too, since only a card we know is stopped wears the mark, though a failed
 * read looks the same here. A check that could not answer judged nothing, and
 * changes nothing.
 */
export async function judgeColumnStop(input: JudgeColumnStopInput): Promise<void> {
  const current = input.runs.columnStop(input.taskId, input.swimlaneId, input.visitStartedAt);
  if (current?.cause === 'spent-row' || !input.stillCurrent()) return;

  const reply = await input.readReply();
  if (!input.stillCurrent()) return;
  const spent = spentMoveRows(input);
  // A spent row on the user's message would have run when their message
  // matches. Read only if such a row is spent, and unreadable is no match.
  const userMessage = spent.some(({ row }) => hasUserTextMatch(row)) && input.readUserMessage
    ? await input.readUserMessage()
    : { readable: false as const };
  if (!input.stillCurrent()) return;
  const textMatchMet = (row: ColumnAutomation & { final_line: string }): boolean => (textMatchSourceOf(row) === 'user'
    ? matchUserMessage(row.final_line, userMessage).met
    : matchFinalLine(row.final_line, reply).met);
  const wouldHaveRun = spent.find(({ row }) => !hasCondition(row) && (!hasFinalLine(row) || textMatchMet(row)));
  if (wouldHaveRun) {
    input.runs.recordColumnStop({ taskId: input.taskId, swimlaneId: input.swimlaneId, cause: 'spent-row', reason: spentReason(wouldHaveRun) });
    return;
  }
  const ownerQuestion = needsOwnerQuestion(reply);
  if (ownerQuestion !== null) {
    recordReplyStop(input, current !== null, ownerQuestion || 'The agent asked for its owner.');
    return;
  }

  const conditionRows = spent.map(({ row }) => row).filter(hasCondition);
  const askNeedsAPerson = Boolean(reply?.trim());
  if (conditionRows.length === 0 && !askNeedsAPerson) {
    clearReplyStop(input, current !== null, NO_MESSAGE_REASON);
    return;
  }
  const outcome = await input.check(conditionRows, askNeedsAPerson);
  if (!input.stillCurrent()) return;
  if (!outcome.ok) {
    // With no Automation agent, step 1 is the whole answer, and it said no.
    if (outcome.cause === 'unavailable') clearReplyStop(input, current !== null, 'The agent\'s last message does not end on Needs owner, and no Automation agent is set up to ask.');
    return;
  }
  const metRow = spent.find(({ row }) => outcome.answers.get(row.id)?.met === true);
  if (metRow) {
    input.runs.recordColumnStop({
      taskId: input.taskId,
      swimlaneId: input.swimlaneId,
      cause: 'spent-row',
      reason: spentReason(metRow),
      backgroundCallId: outcome.callId,
    });
    return;
  }
  const answer = outcome.answers.get(NEEDS_A_PERSON_CHECK_ID);
  if (!answer) {
    // A turn with no message asked the Conditions alone.
    if (!askNeedsAPerson) clearReplyStop(input, current !== null, NO_MESSAGE_REASON);
    return;
  }
  if (answer.met) recordReplyStop(input, current !== null, answer.reason ?? 'The agent cannot continue until a person acts.', answer.callId);
  else clearReplyStop(input, current !== null, answer.reason ?? 'The agent can continue.', answer.callId);
}
