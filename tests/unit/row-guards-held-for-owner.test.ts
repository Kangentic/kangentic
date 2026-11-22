/**
 * `heldForOwner` (#1162): which turn-end rows a reply ending on `Needs owner:`
 * holds back. A row is held only when its type talks to an agent (asked of the
 * manifest) and it has no Agent evaluation and no Text match. A Frequency limit
 * and Task lines do not count, and a blank Condition or Text match is no guard.
 * Each case below fails if the matching clause of the predicate is removed.
 */
import { describe, it, expect } from 'vitest';
import { heldForOwner } from '../../src/main/automations/row-guards';
import type { ColumnAutomation } from '../../src/shared/types';

type Row = Pick<ColumnAutomation, 'type' | 'condition' | 'final_line' | 'trigger'> & Partial<Pick<ColumnAutomation, 'max_runs' | 'filter'>>;

function row(overrides: Partial<Row> = {}): Row {
  return { type: 'send_message', condition: null, final_line: null, trigger: 'turn_end', ...overrides };
}

describe('heldForOwner', () => {
  const cases: Array<{ name: string; automation: Row; held: boolean }> = [
    { name: 'holds an unguarded send_message row', automation: row(), held: true },
    { name: 'still holds a send_message row with a Frequency limit', automation: row({ max_runs: 3 }), held: true },
    { name: 'still holds a send_message row with a task filter', automation: row({ filter: { priorities: [1], labels: null } }), held: true },
    { name: 'does not hold a send_message row with an Agent evaluation', automation: row({ condition: 'The agent is waiting.' }), held: false },
    { name: 'does not hold a send_message row with a Text match', automation: row({ final_line: 'Needs owner*' }), held: false },
    { name: 'holds a send_message row with a blank Condition', automation: row({ condition: '' }), held: true },
    { name: 'holds a send_message row with a whitespace Condition', automation: row({ condition: '   ' }), held: true },
    { name: 'holds a send_message row with a blank Text match', automation: row({ final_line: '' }), held: true },
    { name: 'holds a send_message row with a whitespace Text match', automation: row({ final_line: '  \t ' }), held: true },
    { name: 'does not hold an unguarded move_to_column row', automation: row({ type: 'move_to_column' }), held: false },
    { name: 'does not hold an unguarded notify row', automation: row({ type: 'notify' }), held: false },
    { name: 'does not hold an unguarded webhook row', automation: row({ type: 'webhook' }), held: false },
    { name: 'does not hold an unguarded run_script row', automation: row({ type: 'run_script' }), held: false },
    // Not a manifest type: the migration renames it to send_message.
    { name: 'does not hold the retired send_command type', automation: row({ type: 'send_command' as ColumnAutomation['type'] }), held: false },
  ];

  it.each(cases)('$name', ({ automation, held }) => {
    expect(heldForOwner(automation)).toBe(held);
  });
});
