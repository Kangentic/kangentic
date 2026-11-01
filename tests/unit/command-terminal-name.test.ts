import { describe, it, expect } from 'vitest';
import {
  COMMAND_TERMINAL_BASE_TITLE,
  COMMAND_TERMINAL_NAME_MAX_LENGTH,
  commandTerminalSlotNumber,
  commandTerminalTitle,
  normalizeCommandTerminalName,
} from '../../src/shared/command-terminal-name';

/**
 * A user's rename is normalized in ONE place: main stores what this returns,
 * and the name field asks it whether a commit changed anything, so the two can
 * never disagree about what "Command Terminal 2" or a blank entry means.
 */
describe('normalizeCommandTerminalName', () => {
  it('puts the name on one line and trims it', () => {
    expect(normalizeCommandTerminalName('  Fix\n the   parser\t ', 'slot-1')).toBe('Fix the parser');
  });

  it('cuts it to the cap, and trims what the cut leaves', () => {
    expect(normalizeCommandTerminalName('a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH + 10), 'slot-1')).toHaveLength(COMMAND_TERMINAL_NAME_MAX_LENGTH);
    const endsInSpaceAtCut = `${'a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 1)} b`;
    expect(normalizeCommandTerminalName(endsInSpaceAtCut, 'slot-1')).toBe('a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 1));
  });

  it('never keeps half of an emoji the cut lands inside', () => {
    const emojiAtCut = `${'a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 1)}\u{1F600}`;
    expect(normalizeCommandTerminalName(emojiAtCut, 'slot-1')).toBe('a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 1));
    const emojiBeforeCut = `${'a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 2)}\u{1F600}b`;
    expect(normalizeCommandTerminalName(emojiBeforeCut, 'slot-1')).toBe(`${'a'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH - 2)}\u{1F600}`);
  });

  it('clears for an empty entry, null, and the slot\'s own title', () => {
    expect(normalizeCommandTerminalName('   ', 'slot-2')).toBeNull();
    expect(normalizeCommandTerminalName(null, 'slot-2')).toBeNull();
    expect(normalizeCommandTerminalName(' Command  Terminal 2 ', 'slot-2')).toBeNull();
  });

  it('keeps another slot\'s title as a real name', () => {
    expect(normalizeCommandTerminalName('Command Terminal 3', 'slot-2')).toBe('Command Terminal 3');
  });
});

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
