import { describe, it, expect } from 'vitest';
import {
  COMMAND_TERMINAL_BASE_TITLE,
  commandTerminalSlotNumber,
  commandTerminalTitle,
} from '../../src/shared/command-terminal-name';

/**
 * The Command Terminal's name is rendered by TWO processes: the renderer draws
 * the window's title bar, and main writes the Agent Monitor row's title. This
 * module exists so they cannot disagree, which is the whole point of the tests
 * below being about FORMAT rather than about either call site.
 */
describe('commandTerminalTitle', () => {
  it('numbers a terminal by its durable window slot', () => {
    expect(commandTerminalTitle('slot-1')).toBe('Command Terminal 1');
    expect(commandTerminalTitle('slot-2')).toBe('Command Terminal 2');
    expect(commandTerminalTitle('slot-10')).toBe('Command Terminal 10');
  });

  it('numbers unconditionally, including a lone terminal', () => {
    // Deliberate: a conditional number would rename a window the user is looking
    // at whenever a SIBLING opened or closed. Slot-1 alone still reads "1".
    expect(commandTerminalTitle('slot-1')).toBe('Command Terminal 1');
  });

  it('keeps numbers stable across a sparse slot set', () => {
    // Closing slot 2 of 3 must leave "1" and "3", not renumber the survivors.
    expect(['slot-1', 'slot-3'].map(commandTerminalTitle)).toEqual([
      'Command Terminal 1',
      'Command Terminal 3',
    ]);
  });

  it('falls back to the bare title when no slot is known', () => {
    // Main learns the slot from the renderer at spawn, so a session spawned
    // without one is real, not defensive padding. It must not print "NaN".
    for (const slot of [null, undefined, '', 'slot-', 'slot-abc', 'not-a-slot']) {
      expect(commandTerminalTitle(slot)).toBe(COMMAND_TERMINAL_BASE_TITLE);
    }
  });
});

describe('commandTerminalSlotNumber', () => {
  it('parses a slot id, and reports null for anything else', () => {
    expect(commandTerminalSlotNumber('slot-7')).toBe(7);
    expect(commandTerminalSlotNumber('slot-abc')).toBeNull();
    expect(commandTerminalSlotNumber(null)).toBeNull();
  });

  it('is the single parser, so ordering and titling cannot drift apart', () => {
    // command-window-reconcile.ts sorts slots through this same function; a
    // second regex there is how the two would disagree about what a slot id is.
    const slots = ['slot-10', 'slot-2', 'slot-1'];
    const sorted = [...slots].sort(
      (left, right) => (commandTerminalSlotNumber(left) ?? Infinity) - (commandTerminalSlotNumber(right) ?? Infinity),
    );
    expect(sorted).toEqual(['slot-1', 'slot-2', 'slot-10']);
  });
});
