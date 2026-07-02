import { describe, it, expect } from 'vitest';
import { cleanSelection } from '../../src/renderer/utils/terminal-clipboard';

// Characterization tests locking the legacy string-based `cleanSelection`. This
// feature adds a buffer-aware cleaner (`cleanSelectionLines`, covered in
// terminal-blocks.test.ts) and leaves `cleanSelection` byte-identical as the
// fallback path. A parallel worktree is fixing a bug in this same clipboard
// module; these tests fail loudly if its semantics drift here unintentionally.
describe('cleanSelection (legacy string cleaner)', () => {
  it('leaves distinct lines as-is', () => {
    expect(cleanSelection('hello\nworld', 80)).toBe('hello\nworld');
  });

  it('trims trailing whitespace per line', () => {
    expect(cleanSelection('abc   \ndef  ', 80)).toBe('abc\ndef');
  });

  it('joins a line that fills exactly cols with the next (soft-wrap heuristic)', () => {
    expect(cleanSelection('12345\n678', 5)).toBe('12345678');
  });

  it('does not join when a line is shorter than cols', () => {
    expect(cleanSelection('1234\n678', 5)).toBe('1234\n678');
  });

  it('trims leading and trailing blank lines', () => {
    expect(cleanSelection('\n\nhello\n\n', 80)).toBe('hello');
  });
});
