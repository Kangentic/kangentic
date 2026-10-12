import type { ColumnAutomation } from '../../shared/types';

/**
 * Whether a row carries a guard the runner applies: a Condition, a Frequency
 * limit. The runner is the only place either is applied, so a caller that
 * delivers a row itself (`resolveColumnMessage`'s `guarded`) asks here, and the
 * two can never disagree about which rows are guarded.
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

/** Whether a row has a Frequency limit. Any number is one: the runner counts runs against it. */
export function hasFrequencyLimit<Row extends Pick<ColumnAutomation, 'max_runs'>>(automation: Row): automation is Row & { max_runs: number } {
  return typeof automation.max_runs === 'number';
}
