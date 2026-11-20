import type { ColumnAutomation, TextMatchSource } from '../../shared/types';
import { textMatchSourceOf } from '../../shared/final-line-match';
import { hasTaskFilter, matchesTaskFilter, type FilterableTaskFacts } from '../../shared/automation-filter';

/**
 * Whether a row carries a guard the runner applies: a Condition (either kind,
 * Agent evaluation or Text match), a Frequency limit. The runner is the only
 * place any is applied, so a caller that delivers a row itself
 * (`resolveColumnMessage`'s `guarded`) asks here, and the two can never
 * disagree about which rows are guarded.
 *
 * Its own module, importing only shared code, so the transition engine's
 * column strategy can ask without importing the runner and its adapter registry.
 */

/**
 * Whether a row has a Condition to check. A blank one is no Condition, and a
 * row read from somewhere that predates the column (an older fixture, a row
 * built by hand) has none, rather than an undefined one that reads as present.
 */
export function hasCondition(automation: Pick<ColumnAutomation, 'condition'>): boolean {
  return typeof automation.condition === 'string' && automation.condition.trim() !== '';
}

/**
 * Whether a row has a Text match to check. Turn end only: no other trigger has
 * a final message, and the repository never stores one elsewhere. Asked here
 * too, so a row built by hand on another trigger reads as having none rather
 * than as one the runner could never decide.
 */
export function hasFinalLine<Row extends Pick<ColumnAutomation, 'final_line' | 'trigger'>>(automation: Row): automation is Row & { final_line: string } {
  return automation.trigger === 'turn_end'
    && typeof automation.final_line === 'string'
    && automation.final_line.trim() !== '';
}

/** Whether a row has a Frequency limit. Any number is one: the runner counts runs against it. */
export function hasFrequencyLimit<Row extends Pick<ColumnAutomation, 'max_runs'>>(automation: Row): automation is Row & { max_runs: number } {
  return typeof automation.max_runs === 'number';
}

/**
 * Whether a turn-end row needs the agent's final message: to judge either
 * Condition kind, or to fill an `{{agentReply}}` in its config. The turn-end
 * pass and Run again both ask here, so neither reads the message (a retrieval
 * worker call of up to 15 s) for a row that never looks at it.
 */
export function needsAgentReply(
  automation: Pick<ColumnAutomation, 'condition' | 'final_line' | 'trigger' | 'config'> & { text_match_source?: TextMatchSource },
): boolean {
  return hasCondition(automation)
    || (hasFinalLine(automation) && textMatchSourceOf(automation) === 'agent')
    || JSON.stringify(automation.config).includes('{{agentReply}}');
}

export { textMatchSourceOf };

/**
 * Whether a row has a Text match on the user's message (#1078), and so needs
 * their messages in the turn. Read only then, since the read is a
 * retrieval worker call.
 */
export function hasUserTextMatch(
  automation: Pick<ColumnAutomation, 'final_line' | 'trigger'> & { text_match_source?: TextMatchSource | null },
): boolean {
  return hasFinalLine(automation) && textMatchSourceOf(automation) === 'user';
}

/** Whether a row carries any guard: a Condition line of any kind or a Frequency limit. */
export function hasGuard(
  automation: Pick<ColumnAutomation, 'condition' | 'final_line' | 'trigger' | 'max_runs'> & Partial<Pick<ColumnAutomation, 'filter'>>,
): boolean {
  return hasTaskFilter(automation) || hasCondition(automation) || hasFinalLine(automation) || hasFrequencyLimit(automation);
}

/**
 * Whether a row's Condition Task lines (Priority, Labels) let it run for this
 * task. A row with none matches every task. Checked before every other guard,
 * and a task it does not match leaves no run behind: the row is not for that
 * task at all, so there is nothing to report on it (#872).
 */
export function rowMatchesTaskFilter(
  automation: Partial<Pick<ColumnAutomation, 'filter'>>,
  task: FilterableTaskFacts,
): boolean {
  return matchesTaskFilter(automation.filter ?? null, task);
}
