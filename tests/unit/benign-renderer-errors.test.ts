/**
 * Unit tests for isBenignRendererError and the BENIGN_RENDERER_ERRORS registry.
 *
 * The key coverage gap these tests close is the PASSTHROUGH branch of the monaco
 * error-funnel wrapper in src/renderer/monacoConfig.ts:
 *
 *   errorHandler.unexpectedErrorHandler = (error: unknown) => {
 *     if (isBenignRendererError(error)) return;  // swallow
 *     defaultUnexpectedErrorHandler(error);       // <-- THIS branch was untested
 *   };
 *
 * A test that only covers the swallow path cannot catch a future broadening of
 * the regex (or a logic inversion) that silently masks genuine errors. The
 * passthrough assertions below (returns false for non-benign inputs) fail
 * precisely when the predicate would mistakenly swallow a real error.
 *
 * isBenignRendererError is extracted from the inline logic that was previously
 * duplicated across monacoConfig.ts (with Error/string coercion) and the
 * collectPageErrors helper in tests/ui/helpers.ts. All three call sites now use
 * this single predicate, so this test covers the shared logic for all of them.
 */
import { describe, it, expect } from 'vitest';
import { isBenignRendererError, BENIGN_RENDERER_ERRORS } from '../../src/shared/benign-renderer-errors';

describe('isBenignRendererError', () => {
  describe('BENIGN branch - known disposable monaco message', () => {
    it('returns true for the known DiffEditor disposal Error object', () => {
      const error = new Error(
        'TextModel got disposed before DiffEditorWidget model got reset',
      );
      expect(isBenignRendererError(error)).toBe(true);
    });

    it('returns true for the known DiffEditor disposal message as a raw string', () => {
      // Covers the String(error) coercion path when monaco throws a non-Error value.
      expect(
        isBenignRendererError(
          'TextModel got disposed before DiffEditorWidget model got reset',
        ),
      ).toBe(true);
    });

    it('returns true when the known message appears as a substring', () => {
      // Monaco may prepend extra context; the regex is not anchored.
      const error = new Error(
        'BugIndicatingError: TextModel got disposed before DiffEditorWidget model got reset',
      );
      expect(isBenignRendererError(error)).toBe(true);
    });
  });

  describe('BENIGN branch - Monarch popping an empty state stack', () => {
    // Monaco tokenizes the VIEWPORT first, and a diff revealed at its first
    // hunk starts mid-file, so guessStartState tokenizes from a guessed state
    // and a closing token can appear with no matching opener. Every per-line
    // tokenizer call is wrapped by monaco's own safeTokenize, which routes the
    // throw to the funnel this list feeds - which is why suppressing it works.
    it('returns true for the ruby grammar message seen in the wild', () => {
      expect(
        isBenignRendererError(
          new Error('ruby: trying to pop an empty stack in rule: (unknown)'),
        ),
      ).toBe(true);
    });

    it('returns true for any language, since Monarch prefixes the language id', () => {
      // The pattern is deliberately not keyed to `ruby:` - the same upstream
      // grammar bug in another bundled language produces the same event under
      // a different prefix, and would otherwise slip through.
      for (const language of ['ruby', 'python', 'coffeescript', 'sql']) {
        expect(
          isBenignRendererError(
            new Error(`${language}: trying to pop an empty stack in rule: root`),
          ),
          language,
        ).toBe(true);
      }
    });

    it('returns true when a stack has been appended to the message', () => {
      // monaco's default unexpectedErrorHandler re-throws as
      // `message + '\n\n' + stack`, so anything escaping the funnel reaches
      // Sentry in this shape. An anchored pattern would silently miss it.
      expect(
        isBenignRendererError(
          'ruby: trying to pop an empty stack in rule: (unknown)\n\n    at kw.tokenizeHeuristically (index.js:1:1)',
        ),
      ).toBe(true);
    });

    it('does not swallow other Monarch or tokenizer errors', () => {
      // Deliberately narrow: broadening to all Monarch failures would mask
      // real grammar problems.
      expect(isBenignRendererError(new Error('ruby: invalid tokenizer rule'))).toBe(false);
      expect(isBenignRendererError(new Error('Unexpected token in tokenizer'))).toBe(false);
    });
  });

  describe('PASSTHROUGH branch - non-benign errors must not be swallowed', () => {
    it('returns false for a generic TypeError (Error object)', () => {
      // This is the load-bearing assertion for the coverage hole: a real error
      // must return false so the funnel delegates to defaultUnexpectedErrorHandler.
      const error = new Error(
        'TypeError: cannot read properties of undefined (reading "value")',
      );
      expect(isBenignRendererError(error)).toBe(false);
    });

    it('returns false for a ReferenceError (Error object)', () => {
      const error = new ReferenceError('window is not defined');
      expect(isBenignRendererError(error)).toBe(false);
    });

    it('returns false for an empty message Error', () => {
      expect(isBenignRendererError(new Error(''))).toBe(false);
    });

    it('returns false for an unrelated string', () => {
      expect(isBenignRendererError('Uncaught SyntaxError: Unexpected token')).toBe(false);
    });

    it('returns false for null coerced to string', () => {
      // String(null) === 'null' - must not match any pattern
      expect(isBenignRendererError(null)).toBe(false);
    });

    it('returns false for undefined coerced to string', () => {
      // String(undefined) === 'undefined' - must not match any pattern
      expect(isBenignRendererError(undefined)).toBe(false);
    });
  });

  describe('BENIGN_RENDERER_ERRORS registry shape', () => {
    it('is a non-empty array of RegExp instances', () => {
      expect(Array.isArray(BENIGN_RENDERER_ERRORS)).toBe(true);
      expect(BENIGN_RENDERER_ERRORS.length).toBeGreaterThan(0);
      for (const pattern of BENIGN_RENDERER_ERRORS) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    });

    it('keeps every pattern unanchored, so it still matches once a stack is appended', () => {
      // This array is now spread into Sentry's ignoreErrors as well as feeding
      // the monaco funnel. Monaco re-throws escaping errors as
      // `message + '\n\n' + stack`, so an anchored pattern would work at the
      // funnel and silently fail at Sentry - the worst of both. Anchoring is
      // therefore a mistake this list cannot afford to accept quietly.
      for (const pattern of BENIGN_RENDERER_ERRORS) {
        expect(pattern.source.startsWith('^'), `${pattern} must not be anchored at the start`).toBe(false);
        expect(pattern.source.endsWith('$'), `${pattern} must not be anchored at the end`).toBe(false);
      }
    });
  });
});
