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
  });
});
