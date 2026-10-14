import type { ColumnAutomation } from '../../shared/types';

/**
 * Whether a row carries a guard the runner applies: a Condition (either kind,
 * Agent evaluation or Text match), a Frequency limit. The runner is the only
 * place any is applied, so a caller that delivers a row itself
 * (`resolveColumnMessage`'s `guarded`) asks here, and the two can never
 * disagree about which rows are guarded.
 *
 * Its own module, with type imports only, so the transition engine's column
 * strategy can ask without importing the runner and its adapter registry.
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
export function needsAgentReply(automation: Pick<ColumnAutomation, 'condition' | 'final_line' | 'trigger' | 'config'>): boolean {
  return hasCondition(automation) || hasFinalLine(automation) || JSON.stringify(automation.config).includes('{{agentReply}}');
}

/** Whether a row carries any guard: either Condition kind or a Frequency limit. */
export function hasGuard(automation: Pick<ColumnAutomation, 'condition' | 'final_line' | 'trigger' | 'max_runs'>): boolean {
  return hasCondition(automation) || hasFinalLine(automation) || hasFrequencyLimit(automation);
}
