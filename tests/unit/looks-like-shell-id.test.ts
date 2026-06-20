/**
 * Boundary tests for `looksLikeShellId`, the heuristic that decides whether a
 * `background_shell_start` is tracked by identity (named set) or anonymously
 * (count). It gates Fix f85166e6's named-shell reclaim path: a value that
 * wrongly passes would feed command strings into the named set (distinct
 * commands accumulating forever, identical commands colliding); a value that
 * wrongly fails would drop a real shell id into the anonymous count and lose
 * the per-shell quiescence reclaim.
 *
 * Positives are the real captured shell ids the replay fixtures use
 * (`bx6k8r2cr`, `beg7osflu`, `bash_1`). Negatives are the command-string
 * fallbacks the Claude PreToolUse directive emits when `tool_input.shell_id`
 * is absent (the case the gate exists to reject).
 */
import { describe, it, expect } from 'vitest';
import { looksLikeShellId } from '../../src/main/activity-engine/background-shell/looks-like-shell-id';

describe('looksLikeShellId', () => {
  describe('accepts real shell ids (named tracking)', () => {
    // The first three are real ids from tests/fixtures/replay (sanitized real
    // captures): session-012/014 use `bx6k8r2cr`, the worktree-install shell is
    // `beg7osflu`, the idle-hint suite uses `bash_1`. The rest are synthetic
    // boundary cases that exercise the accepted character set.
    it.each(['bx6k8r2cr', 'beg7osflu', 'bash_1', 'shell', 'a', '0', 'Bash-1', 'a_b-c1'])(
      'accepts %j',
      (value) => {
        expect(looksLikeShellId(value)).toBe(true);
      },
    );

    it('accepts a value of exactly 64 chars (upper boundary, inclusive)', () => {
      const sixtyFour = 'a'.repeat(64);
      expect(sixtyFour).toHaveLength(64);
      expect(looksLikeShellId(sixtyFour)).toBe(true);
    });
  });

  describe('rejects command-string fallbacks (anonymous tracking)', () => {
    // The directive's `command` fallback for a missing shell_id: these must
    // NOT enter the named set.
    it.each([
      'npm run build',
      'npx playwright test --project=electron',
      'npm install',
      'bash -lc "echo hi"',
    ])('rejects command string %j', (value) => {
      expect(looksLikeShellId(value)).toBe(false);
    });

    it.each([
      ['contains a space', 'bx6 k8r'],
      ['contains a slash', 'a/b'],
      ['contains a backslash', 'a\\b'],
      ['contains a dot', 'a.b'],
      ['contains a colon', 'a:b'],
      ['contains a semicolon', 'a;b'],
      ['contains parentheses', 'tool(input)'],
      ['contains a pipe', 'a|b'],
    ])('rejects when it %s (%j)', (_label, value) => {
      expect(looksLikeShellId(value)).toBe(false);
    });
  });

  describe('rejects out-of-range and non-string input', () => {
    it('rejects the empty string', () => {
      expect(looksLikeShellId('')).toBe(false);
    });

    it('rejects a value of 65 chars (one past the upper boundary)', () => {
      const sixtyFive = 'a'.repeat(65);
      expect(sixtyFive).toHaveLength(65);
      expect(looksLikeShellId(sixtyFive)).toBe(false);
    });

    it('rejects undefined (no shell_id captured)', () => {
      expect(looksLikeShellId(undefined)).toBe(false);
    });
  });
});
