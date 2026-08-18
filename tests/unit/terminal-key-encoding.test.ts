/**
 * Unit tests for `encodeTerminalKey`.
 *
 * These bytes go straight into the user's shell. The keystrokes reaching this
 * function are ones the user typed while an agent held focus in a Browser pane:
 * main intercepts them so they never reach the page, and this decides what the
 * terminal receives instead. A wrong sequence here is worse than a dropped one -
 * a stray escape sequence in a live shell is confusing and potentially
 * destructive - which is why anything unrecognized returns null.
 *
 * Tier: Unit (vitest, pure function).
 */
import { describe, it, expect } from 'vitest';
import { encodeTerminalKey, type TerminalKeyInput } from '../../src/shared/terminal-key-encoding';

function key(overrides: Partial<TerminalKeyInput> & { key: string }): TerminalKeyInput {
  return { control: false, alt: false, meta: false, shift: false, ...overrides };
}

describe('printable characters', () => {
  it.each(['a', 'Z', '1', ' ', '!', '/', '@'])('passes %s through unchanged', (character) => {
    expect(encodeTerminalKey(key({ key: character }))).toBe(character);
  });

  it('uses the shifted character the event already reports', () => {
    // `KeyboardEvent.key` is already 'A' for shift+a, so nothing here re-derives
    // case. Doing so would break every non-US layout.
    expect(encodeTerminalKey(key({ key: 'A', shift: true }))).toBe('A');
  });
});

describe('editing and navigation keys', () => {
  it.each([
    ['Enter', '\r'],
    ['Tab', '\t'],
    ['Backspace', '\x7f'],
    ['Escape', '\x1b'],
  ])('encodes %s', (name, expected) => {
    expect(encodeTerminalKey(key({ key: name }))).toBe(expected);
  });

  it.each([
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['ArrowRight', '\x1b[C'],
    ['ArrowLeft', '\x1b[D'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['Delete', '\x1b[3~'],
  ])('encodes %s as its CSI sequence', (name, expected) => {
    expect(encodeTerminalKey(key({ key: name }))).toBe(expected);
  });
});

describe('control chords are dropped, not encoded', () => {
  // The terminal owns Ctrl semantics and they are CONTEXTUAL in ways this
  // function cannot see: Ctrl+C copies when there is a selection and sends
  // SIGINT when there is not, and Ctrl+V pastes rather than sending 0x16
  // (literal-next), which would arm the next keystroke to be taken literally in
  // a live shell. Encoding them here would be a second implementation of
  // `terminal-clipboard.ts`'s rules, quietly diverging from it.
  it.each(['c', 'v', 'x', 'a', 'd', 'u', 'z'])('drops Ctrl+%s', (letter) => {
    expect(encodeTerminalKey(key({ key: letter, control: true }))).toBeNull();
  });

  it('drops a Ctrl chord on a named key', () => {
    expect(encodeTerminalKey(key({ key: 'ArrowLeft', control: true }))).toBeNull();
    expect(encodeTerminalKey(key({ key: 'F5', control: true }))).toBeNull();
  });

  it('drops Ctrl+Shift chords too', () => {
    expect(encodeTerminalKey(key({ key: 'C', control: true, shift: true }))).toBeNull();
  });
});

describe('what it refuses to encode', () => {
  it('drops every Meta chord', () => {
    // Cmd/Win chords are OS or app shortcuts and are never terminal input.
    expect(encodeTerminalKey(key({ key: 'c', meta: true }))).toBeNull();
    expect(encodeTerminalKey(key({ key: 'Tab', meta: true }))).toBeNull();
  });

  it('drops function keys and other named keys it has no mapping for', () => {
    // Returning null means "drop", which the caller prefers to guessing.
    for (const name of ['F1', 'F5', 'Insert', 'CapsLock', 'Shift', 'Control', 'Alt', 'Meta']) {
      expect(encodeTerminalKey(key({ key: name })), name).toBeNull();
    }
  });

  it('encodes Alt+letter as an ESC-prefixed meta sequence', () => {
    expect(encodeTerminalKey(key({ key: 'b', alt: true }))).toBe('\x1bb');
  });

  it('drops Alt chords on named keys', () => {
    expect(encodeTerminalKey(key({ key: 'ArrowLeft', alt: true }))).toBeNull();
  });

  it('drops an Alt chord whose key composed to a non-ASCII character', () => {
    // THE CROSS-PLATFORM CASE. macOS treats Option as a compose modifier, so
    // Option+a arrives as `key: 'å'` - the character the OS produced - while
    // Windows and Linux report `key: 'a'`. Emitting `\x1b` + 'å' is wrong under
    // either macOS terminal convention, so the composed form is dropped rather
    // than guessed at. Encoded as a property of the INPUT (is it ASCII) rather
    // than a `process.platform` branch, so the same code is right everywhere.
    expect(encodeTerminalKey(key({ key: 'å', alt: true }))).toBeNull();
    expect(encodeTerminalKey(key({ key: 'ø', alt: true }))).toBeNull();
    // The Windows/Linux form is unaffected.
    expect(encodeTerminalKey(key({ key: 'a', alt: true }))).toBe('\x1ba');
  });

  it('still types a non-ASCII character when no modifier is held', () => {
    // Dropping above is specific to the Alt path; ordinary international typing
    // during a drive must still reach the terminal.
    expect(encodeTerminalKey(key({ key: 'é' }))).toBe('é');
  });
});
