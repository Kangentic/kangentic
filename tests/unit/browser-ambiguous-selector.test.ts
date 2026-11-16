/**
 * Pins `parseSelectorCandidates`, the check on what a page says about the
 * elements a selector matched (GitHub #820).
 *
 * The page is untrusted: a script can patch what the counting expression
 * calls, and the candidates it returns reach the agent's error envelope. So
 * every field is checked, an entry that cannot be retried (no string
 * `selector`, or one too long to retry) is dropped, any other wrong-typed
 * field reads as empty, every string field is clipped, and the list is cut to
 * AMBIGUOUS_CANDIDATE_LIMIT.
 *
 * Tier: unit. Pure function, no browser.
 */
import { describe, it, expect } from 'vitest';
import {
  AMBIGUOUS_CANDIDATE_LIMIT,
  AmbiguousSelectorError,
  CANDIDATE_FIELD_MAX_CHARS,
  CANDIDATE_SELECTOR_MAX_CHARS,
  ambiguousSelectorDetail,
  parseSelectorCandidates,
} from '../../src/main/browser/cdp/ambiguous-selector';

/** The shape buildActionableMatchesExpression returns for one candidate. */
function realCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    tag: 'button',
    text: 'Save',
    id: 'modal-save',
    role: 'button',
    ariaLabel: 'Save changes',
    name: 'save',
    inDialog: true,
    topmost: true,
    box: { x: 120, y: 340, width: 88, height: 32 },
    selector: 'html > body > div > dialog > button:nth-of-type(2)',
    ...overrides,
  };
}

describe('parseSelectorCandidates', () => {
  it('round-trips a well-formed entry unchanged', () => {
    const entry = realCandidate();
    expect(parseSelectorCandidates([entry])).toEqual([entry]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'button'],
    ['an object', { 0: realCandidate(), length: 1 }],
    ['a number', 3],
  ])('gives [] for %s', (_name, value) => {
    expect(parseSelectorCandidates(value)).toEqual([]);
  });

  it('drops an entry that is null, not an object, or has no string selector', () => {
    const kept = realCandidate({ index: 4 });
    const parsed = parseSelectorCandidates([
      null,
      'button',
      [],
      realCandidate({ selector: 7 }),
      kept,
    ]);
    expect(parsed).toEqual([kept]);
  });

  // A separate case, not more entries above: the list is cut to
  // AMBIGUOUS_CANDIDATE_LIMIT before entries are checked, so a sixth entry
  // would push `kept` out of the slice.
  it('drops an entry with a missing selector or a numeric entry', () => {
    expect(parseSelectorCandidates([42, realCandidate({ selector: undefined })])).toEqual([]);
  });

  it('reads wrong-typed fields as empty', () => {
    const [parsed] = parseSelectorCandidates([
      realCandidate({
        id: 12,
        role: {},
        ariaLabel: false,
        name: [],
        topmost: 'yes',
        inDialog: 'true',
        tag: 5,
        text: null,
        index: Number.NaN,
        box: undefined,
      }),
    ]);
    expect(parsed.id).toBeNull();
    expect(parsed.role).toBeNull();
    expect(parsed.ariaLabel).toBeNull();
    expect(parsed.name).toBeNull();
    expect(parsed.topmost).toBeNull();
    expect(parsed.inDialog).toBe(false);
    expect(parsed.tag).toBe('');
    expect(parsed.text).toBe('');
    expect(parsed.index).toBe(0);
    expect(parsed.box).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('reads a non-finite or non-numeric box value as zero', () => {
    const [parsed] = parseSelectorCandidates([
      realCandidate({ box: { x: Infinity, y: '5', width: 10, height: Number.NaN } }),
    ]);
    expect(parsed.box).toEqual({ x: 0, y: 0, width: 10, height: 0 });
  });

  it('keeps a false topmost as false, not null', () => {
    const [parsed] = parseSelectorCandidates([realCandidate({ topmost: false })]);
    expect(parsed.topmost).toBe(false);
  });

  it('cuts a long list to AMBIGUOUS_CANDIDATE_LIMIT', () => {
    const entries = Array.from({ length: AMBIGUOUS_CANDIDATE_LIMIT + 4 }, (_unused, index) =>
      realCandidate({ index, selector: `#item-${index}` }),
    );
    const parsed = parseSelectorCandidates(entries);
    expect(parsed).toHaveLength(AMBIGUOUS_CANDIDATE_LIMIT);
    expect(parsed.map((candidate) => candidate.index)).toEqual(
      Array.from({ length: AMBIGUOUS_CANDIDATE_LIMIT }, (_unused, index) => index),
    );
  });

  it('clips every described string field, so a page cannot inflate the error envelope', () => {
    const huge = 'x'.repeat(CANDIDATE_FIELD_MAX_CHARS * 50);
    const [parsed] = parseSelectorCandidates([
      realCandidate({ tag: huge, text: huge, id: huge, role: huge, ariaLabel: huge, name: huge }),
    ]);
    for (const field of [parsed.tag, parsed.text, parsed.id, parsed.role, parsed.ariaLabel, parsed.name]) {
      expect(field).toHaveLength(CANDIDATE_FIELD_MAX_CHARS);
    }
  });

  it('drops a candidate whose selector is too long to retry, rather than clipping it into a different selector', () => {
    const kept = realCandidate({ selector: `#${'a'.repeat(CANDIDATE_SELECTOR_MAX_CHARS - 1)}` });
    const tooLong = realCandidate({ selector: `#${'a'.repeat(CANDIDATE_SELECTOR_MAX_CHARS)}` });
    expect(parseSelectorCandidates([tooLong, kept])).toEqual([kept]);
  });
});

describe('ambiguousSelectorDetail', () => {
  it('points the agent at a candidate selector when there is one', () => {
    const [candidate] = parseSelectorCandidates([realCandidate()]);
    const detail = ambiguousSelectorDetail(new AmbiguousSelectorError('text="Save"', 2, [candidate]));
    expect(detail).toContain('2 visible elements match text="Save"');
    expect(detail).toContain('Retry with one candidate\'s selector');
    expect(detail).toContain('topmost: false');
  });

  it('never tells the agent to retry with a candidate when the refusal carries none', () => {
    const detail = ambiguousSelectorDetail(new AmbiguousSelectorError('#save', 3, []));
    expect(detail).toContain('3 visible elements match #save');
    expect(detail).not.toContain('candidate\'s selector');
    expect(detail).toContain('scope the selector to its container');
    expect(detail).toContain('strict: false');
  });
});
