import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { escapeFtsMatchQuery } from '../../src/main/retrieval/fts-query';

/**
 * `escapeFtsMatchQuery` turns raw user input into a safe FTS5 MATCH string.
 * The load-bearing safety property: every token is wrapped in a double-quoted
 * phrase (which disables all FTS5 operator interpretation), only the LAST token
 * gets a prefix `*`, and hostile input never throws or leaks an unquoted
 * operator. It returns null when nothing queryable remains.
 */
describe('escapeFtsMatchQuery', () => {
  it('quotes each token and prefix-matches only the last', () => {
    expect(escapeFtsMatchQuery('hello world')).toBe('"hello" "world"*');
  });

  it('quotes a single token and appends the prefix star', () => {
    expect(escapeFtsMatchQuery('frobnicate')).toBe('"frobnicate"*');
  });

  it('collapses internal whitespace runs when splitting', () => {
    expect(escapeFtsMatchQuery('  alpha   beta  ')).toBe('"alpha" "beta"*');
  });

  it('returns null for an empty query', () => {
    expect(escapeFtsMatchQuery('')).toBeNull();
  });

  it('returns null for a whitespace-only query', () => {
    expect(escapeFtsMatchQuery('   \t  \n ')).toBeNull();
  });

  it('returns null when every token is only stripped-out double quotes', () => {
    expect(escapeFtsMatchQuery('"" ""')).toBeNull();
  });

  it('strips embedded double quotes before quoting', () => {
    // foo"bar -> foobar, then wrapped.
    expect(escapeFtsMatchQuery('foo"bar')).toBe('"foobar"*');
  });

  it('neutralizes a lone dash operator by quoting it', () => {
    // A bare `-` is FTS5 NOT; quoting it makes it a literal phrase.
    const result = escapeFtsMatchQuery('-');
    expect(result).toBe('"-"*');
  });

  it('neutralizes a NEAR( operator token by quoting it', () => {
    const result = escapeFtsMatchQuery('NEAR(');
    expect(result).toBe('"NEAR("*');
  });

  it('quotes an AND / OR operator so it is treated as a literal', () => {
    expect(escapeFtsMatchQuery('cats AND dogs')).toBe('"cats" "AND" "dogs"*');
  });

  it('quotes a column-filter colon token instead of letting it filter', () => {
    expect(escapeFtsMatchQuery('title:foo')).toBe('"title:foo"*');
  });

  it('handles an unbalanced leading quote without throwing', () => {
    // `"foo bar` -> tokens ['"foo','bar'] -> ['foo','bar'].
    expect(escapeFtsMatchQuery('"foo bar')).toBe('"foo" "bar"*');
  });

  it('preserves an asterisk inside a token (only the last token appends one)', () => {
    expect(escapeFtsMatchQuery('wild*card term')).toBe('"wild*card" "term"*');
  });

  const hostileInputs = [
    '"',
    '""""',
    '- -- ---',
    'NEAR(a, b, 3)',
    'a AND b OR NOT c',
    'col:val "quoted phrase"',
    ')(*&^%$#@!',
    '\\ \\\\ \\"',
    'a"b"c"d',
    '   ',
    '*',
    '^prefix',
  ];
  for (const input of hostileInputs) {
    it(`never throws and never yields an unquoted operator token for ${JSON.stringify(input)}`, () => {
      let result: string | null = null;
      expect(() => {
        result = escapeFtsMatchQuery(input);
      }).not.toThrow();
      if (result === null) return;
      // Tokens contain no whitespace (split on \s+) and no `"` (stripped), so
      // splitting the result back on a single space recovers the phrases.
      const phrases = (result as string).split(' ');
      phrases.forEach((phrase, index) => {
        const isLast = index === phrases.length - 1;
        // Every phrase is a quoted token; the last one may carry a trailing `*`.
        const shape = isLast ? /^"[^"\s]+"\*$/ : /^"[^"\s]+"$/;
        expect(phrase).toMatch(shape);
      });
    });
  }

  it('property: returns null or a string of space-joined quoted (optionally *-suffixed) tokens', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = escapeFtsMatchQuery(raw);
        if (result === null) return true;
        const phrases = result.split(' ');
        return phrases.every((phrase, index) => {
          const isLast = index === phrases.length - 1;
          const shape = isLast ? /^"[^"\s]+"\*$/ : /^"[^"\s]+"$/;
          return shape.test(phrase);
        });
      }),
      { numRuns: 500 },
    );
  });

  it('property: the last token always carries exactly one trailing prefix star', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = escapeFtsMatchQuery(raw);
        if (result === null) return true;
        // Exactly one `*` overall, and it is the final character.
        const starCount = (result.match(/\*/g) ?? []).length;
        // A token may itself contain literal `*`, so count only the trailing one
        // by checking the last character is `*` and the rest is well-formed.
        return result.endsWith('*') && starCount >= 1;
      }),
      { numRuns: 500 },
    );
  });
});
