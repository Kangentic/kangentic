/**
 * Unit coverage for `src/renderer/utils/text-target.ts` - the mechanism that
 * gets text into a React-controlled input without a keyboard event.
 *
 * Only the PURE half is pinned here. This project runs its unit tier without
 * jsdom (see `use-terminal-font-race.test.ts`), so `writeTextTarget`,
 * `submitTextTarget`, and the DOM half of `applyBytesToTextTarget` are covered
 * at the UI tier instead (`tests/ui/dictation-note-input.spec.ts`), against a
 * real React-controlled input where the native-setter trick either works or
 * visibly does not. The three functions below are the decisions - which element
 * is eligible, what the field's next value is, and what an intercepted
 * keystroke means - and each is easy to get subtly wrong and impossible to see
 * going wrong at runtime.
 *
 * `isTextTarget` is deliberately typed over a structural candidate rather than
 * `Element` precisely so it can be exercised here.
 */
import { describe, it, expect } from 'vitest';
import {
  TEXT_TARGET_DENY_ATTRIBUTE,
  composeTextTargetValue,
  decodeBytesForTextTarget,
  isContentEditableTarget,
  isTextTarget,
  mayAutoSubmit,
} from '../../src/renderer/utils/text-target';

interface Candidate {
  tagName?: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  isContentEditable?: boolean;
  classList?: { contains: (token: string) => boolean };
  closest?: (selector: string) => unknown;
}

/** An ordinary enabled text input, which is now all it takes to qualify. */
function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    tagName: 'INPUT',
    type: 'text',
    disabled: false,
    readOnly: false,
    classList: { contains: () => false },
    closest: () => null,
    ...overrides,
  };
}

describe('isTextTarget - allow by default', () => {
  it('accepts an ordinary text input with no marker at all', () => {
    // The inversion. Dictation works wherever the user can type, so a plain
    // field - a new-task title, a rename box - qualifies on its own. Requiring
    // an opt-in marker meant every new field silently did nothing.
    expect(isTextTarget(makeCandidate())).toBe(true);
  });

  it('accepts an input with no type attribute (which defaults to text)', () => {
    expect(isTextTarget(makeCandidate({ type: '' }))).toBe(true);
  });

  it('accepts a textarea, whose type is meaningless', () => {
    expect(isTextTarget(makeCandidate({ tagName: 'TEXTAREA', type: undefined }))).toBe(true);
  });

  it('accepts the other prose-carrying input types', () => {
    for (const type of ['search', 'url', 'email', 'tel']) {
      expect(isTextTarget(makeCandidate({ type })), type).toBe(true);
    }
  });
});

describe('isTextTarget - the structural exclusions', () => {
  it('rejects xterm\'s hidden helper textarea', () => {
    // THE case that allow-by-default creates, and the most damaging one. It is a
    // real <textarea>, so a bare tag check matches it - and a terminal already
    // has its own delivery path (PTY bytes). Treating it as a DOM target would
    // write the transcript into a hidden element xterm clears on the next
    // keystroke: the words vanish and the shell never sees them.
    const helper = makeCandidate({
      tagName: 'TEXTAREA',
      type: undefined,
      classList: { contains: (token) => token === 'xterm-helper-textarea' },
    });
    expect(isTextTarget(helper)).toBe(false);
  });

  it('rejects a password field', () => {
    expect(isTextTarget(makeCandidate({ type: 'password' }))).toBe(false);
  });

  it('rejects input types that do not hold prose', () => {
    for (const type of ['checkbox', 'number', 'date', 'color', 'range', 'file', 'submit']) {
      expect(isTextTarget(makeCandidate({ type })), type).toBe(false);
    }
  });

  it('rejects a disabled or read-only field', () => {
    // Writing there produces a value the user can see but the app will never
    // accept, which reads as the feature being broken.
    expect(isTextTarget(makeCandidate({ disabled: true }))).toBe(false);
    expect(isTextTarget(makeCandidate({ readOnly: true }))).toBe(false);
  });

  it('rejects a field carrying the opt-out, or nested under one', () => {
    // `closest` covers both the field itself and any ancestor, so a whole
    // subtree can be excluded with one attribute.
    const optedOut = makeCandidate({
      closest: (selector) => (selector === `[${TEXT_TARGET_DENY_ATTRIBUTE}]` ? {} : null),
    });
    expect(isTextTarget(optedOut)).toBe(false);
  });

  it('rejects an element that is not an input at all', () => {
    expect(isTextTarget(makeCandidate({ tagName: 'DIV', type: undefined }))).toBe(false);
    expect(isTextTarget(makeCandidate({ tagName: 'SELECT', type: undefined }))).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isTextTarget(null)).toBe(false);
    expect(isTextTarget(undefined)).toBe(false);
  });

  it('tolerates a candidate with no classList or closest accessor', () => {
    // Both are optional-chained, so a minimal object still classifies rather
    // than throwing.
    expect(isTextTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
  });
});

describe('isTextTarget - rich text', () => {
  it('accepts a contenteditable host', () => {
    // A rich-text editor is somewhere the user types, so it is a target - but it
    // has no tagName or type the input checks would recognise, which is why it
    // is classified before them.
    const editor = makeCandidate({ tagName: 'DIV', type: undefined, isContentEditable: true });
    expect(isTextTarget(editor)).toBe(true);
    expect(isContentEditableTarget(editor)).toBe(true);
  });

  it('honours the opt-out on a contenteditable too', () => {
    const optedOut = makeCandidate({
      tagName: 'DIV',
      type: undefined,
      isContentEditable: true,
      closest: (selector) => (selector === `[${TEXT_TARGET_DENY_ATTRIBUTE}]` ? {} : null),
    });
    expect(isContentEditableTarget(optedOut)).toBe(false);
    expect(isTextTarget(optedOut)).toBe(false);
  });

  it('does not classify an ordinary div as rich text', () => {
    expect(isContentEditableTarget(makeCandidate({ tagName: 'DIV', type: undefined }))).toBe(false);
  });
});

describe('mayAutoSubmit', () => {
  /** A form containing `fieldCount` text-carrying fields. */
  function inFormWith(fieldCount: number): Candidate {
    return makeCandidate({
      closest: (selector: string) => (selector === 'form'
        ? { querySelectorAll: () => ({ length: fieldCount }) }
        : null),
    });
  }

  it('allows a field in NO form - it can only submit itself', () => {
    // The board search box, and the Browser pane's note input.
    expect(mayAutoSubmit(makeCandidate())).toBe(true);
  });

  it('allows a form with a single text input', () => {
    // The Browser pane's URL bar: a standalone box wearing a form. Enter
    // navigates, which is the one scoped thing the user expects.
    expect(mayAutoSubmit(inFormWith(1))).toBe(true);
  });

  it('REFUSES a form with more than one text input', () => {
    // THE case. Dictating a title into the New Task dialog would otherwise
    // create the task the instant the user let go of the key, with the rest of
    // the form still empty. Refusing only downgrades release to "insert and
    // leave it"; the words still land.
    expect(mayAutoSubmit(inFormWith(2))).toBe(false);
    expect(mayAutoSubmit(inFormWith(7))).toBe(false);
  });

  it('allows an empty form, and a candidate that cannot look upward', () => {
    // Degrading to "allowed" is right for both: a form with no fields has
    // nothing to commit, and a candidate with no `closest` is a test stub or a
    // detached node, neither of which is a multi-field dialog.
    expect(mayAutoSubmit(inFormWith(0))).toBe(true);
    expect(mayAutoSubmit({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(mayAutoSubmit(null)).toBe(true);
  });
});

describe('composeTextTargetValue', () => {
  it('inserts at a collapsed caret in the middle of existing text', () => {
    expect(composeTextTargetValue({
      baseValue: 'why is  misaligned?',
      anchorStart: 7,
      anchorEnd: 7,
      text: 'this',
    })).toEqual({ value: 'why is this misaligned?', caret: 11 });
  });

  it('REPLACES the anchored span rather than appending, so a revised partial does not stutter', () => {
    // The whole reason the anchor is captured once. Three successive partials
    // from the same session must leave one sentence, not three.
    const anchor = { baseValue: 'note: ', anchorStart: 6, anchorEnd: 6 };
    const first = composeTextTargetValue({ ...anchor, text: 'Fix' });
    const second = composeTextTargetValue({ ...anchor, text: 'Fix the' });
    const third = composeTextTargetValue({ ...anchor, text: 'Fix the spacing' });
    expect(first.value).toBe('note: Fix');
    expect(second.value).toBe('note: Fix the');
    expect(third.value).toBe('note: Fix the spacing');
    expect(third.caret).toBe('note: Fix the spacing'.length);
  });

  it('replaces a live selection, the way typing over it would have', () => {
    expect(composeTextTargetValue({
      baseValue: 'keep DROP keep',
      anchorStart: 5,
      anchorEnd: 9,
      text: 'new',
    })).toEqual({ value: 'keep new keep', caret: 8 });
  });

  it('appends at the end and inserts at the start', () => {
    expect(composeTextTargetValue({ baseValue: 'tail', anchorStart: 4, anchorEnd: 4, text: 'X' }))
      .toEqual({ value: 'tailX', caret: 5 });
    expect(composeTextTargetValue({ baseValue: 'tail', anchorStart: 0, anchorEnd: 0, text: 'X' }))
      .toEqual({ value: 'Xtail', caret: 1 });
  });

  it('erases back to the base value when the text is empty (the clear path)', () => {
    expect(composeTextTargetValue({ baseValue: 'a b', anchorStart: 2, anchorEnd: 2, text: '' }))
      .toEqual({ value: 'a b', caret: 2 });
  });

  it('clamps an out-of-range anchor instead of throwing or truncating', () => {
    // A stale anchor (the field was edited by something else mid-session) must
    // degrade to an append, not corrupt the value.
    expect(composeTextTargetValue({ baseValue: 'abc', anchorStart: 99, anchorEnd: 99, text: 'X' }))
      .toEqual({ value: 'abcX', caret: 4 });
    expect(composeTextTargetValue({ baseValue: 'abc', anchorStart: -5, anchorEnd: -1, text: 'X' }))
      .toEqual({ value: 'Xabc', caret: 1 });
  });

  it('treats an inverted anchor as collapsed at its start', () => {
    expect(composeTextTargetValue({ baseValue: 'abcdef', anchorStart: 4, anchorEnd: 1, text: 'X' }))
      .toEqual({ value: 'abcdXef', caret: 5 });
  });
});

describe('decodeBytesForTextTarget', () => {
  it('inserts a printable character', () => {
    expect(decodeBytesForTextTarget('a')).toEqual({ kind: 'insert', text: 'a' });
    expect(decodeBytesForTextTarget('A')).toEqual({ kind: 'insert', text: 'A' });
    expect(decodeBytesForTextTarget(' ')).toEqual({ kind: 'insert', text: ' ' });
    expect(decodeBytesForTextTarget('!')).toEqual({ kind: 'insert', text: '!' });
    expect(decodeBytesForTextTarget('e')).toEqual({ kind: 'insert', text: 'e' });
  });

  it('deletes backward on DEL, which is what Backspace encodes to', () => {
    expect(decodeBytesForTextTarget('\x7f')).toEqual({ kind: 'deleteBackward' });
    expect(decodeBytesForTextTarget('\b')).toEqual({ kind: 'deleteBackward' });
  });

  it('DROPS Enter', () => {
    // Deliberate, and the one case worth stating on its own. Enter in the note
    // input sends the capture and the note to the agent; firing that off a
    // keystroke the user aimed at a web page would post a half-written note with
    // a screenshot attached and no way to take it back.
    expect(decodeBytesForTextTarget('\r')).toBeNull();
    expect(decodeBytesForTextTarget('\n')).toBeNull();
  });

  it('drops tab, escape, and the CSI navigation sequences', () => {
    expect(decodeBytesForTextTarget('\t')).toBeNull();
    expect(decodeBytesForTextTarget('\x1b')).toBeNull();
    expect(decodeBytesForTextTarget('\x1b[A')).toBeNull();
    expect(decodeBytesForTextTarget('\x1b[3~')).toBeNull();
    expect(decodeBytesForTextTarget('\x1ba')).toBeNull();
  });

  it('drops the empty string and any multi-character payload', () => {
    expect(decodeBytesForTextTarget('')).toBeNull();
    expect(decodeBytesForTextTarget('ab')).toBeNull();
  });
});
