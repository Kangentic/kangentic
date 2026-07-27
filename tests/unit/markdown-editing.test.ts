/**
 * Unit coverage for the pure markdown-editing helpers behind DescriptionEditor's
 * list continuation, indent/outdent, bold/italic/link wrapping, and paste
 * heuristics. Each helper returns a range-replacement descriptor (or null,
 * meaning "let the browser do its native thing") rather than a full string,
 * so these tests assert on the descriptor shape directly.
 */
import { describe, it, expect } from 'vitest';
import {
  continueListOnEnter,
  indentListSelection,
  isSingleLineAbsoluteUrl,
  linkFromPastedUrl,
  linkSelection,
  shouldConvertPastedHtml,
  toggleWrap,
} from '../../src/renderer/utils/markdown-editing';

describe('continueListOnEnter', () => {
  it('continues an unordered dash item', () => {
    const value = '- a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('\n- ');
    expect(edit?.replaceStart).toBe(value.length);
    expect(edit?.replaceEnd).toBe(value.length);
    expect(edit?.selectionStart).toBe(value.length + edit!.insert.length);
  });

  it('continues an asterisk item', () => {
    const value = '* a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('\n* ');
  });

  it('continues an ordered item, incrementing the number and preserving the delimiter', () => {
    const value = '1. a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('\n2. ');
  });

  it('continues an ordered item using the ")" delimiter', () => {
    const value = '1) a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('\n2) ');
  });

  it('continues a checkbox item, resetting to unchecked', () => {
    const value = '- [x] a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('\n- [ ] ');
  });

  it('preserves nested indentation', () => {
    const value = '  - a';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('\n  - ');
  });

  it('splits mid-line content onto the continuation, at the caret rather than the line end', () => {
    const value = '- hello world';
    const caret = value.indexOf(' world'); // caret right before " world"
    const edit = continueListOnEnter(value, caret);

    expect(edit?.replaceStart).toBe(caret);
    expect(edit?.replaceEnd).toBe(caret);
    expect(edit?.insert).toBe('\n- ');
  });

  it('clears an empty unordered marker instead of nesting', () => {
    const value = '- ';
    const edit = continueListOnEnter(value, value.length);

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('');
    expect(edit?.replaceStart).toBe(0);
    expect(edit?.replaceEnd).toBe(value.length);
    expect(edit?.selectionStart).toBe(0);
    expect(edit?.selectionEnd).toBe(0);
  });

  it('clears an empty ordered marker instead of nesting', () => {
    const value = '1. ';
    const edit = continueListOnEnter(value, value.length);

    expect(edit?.insert).toBe('');
  });

  it('treats a marker with only trailing spaces as empty, judged by the whole line not the caret', () => {
    const value = '-    ';
    const edit = continueListOnEnter(value, 1); // caret parked right after the dash, mid-marker

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('');
    expect(edit?.replaceStart).toBe(0);
    expect(edit?.replaceEnd).toBe(value.length);
  });

  it('returns null for a line with no list marker', () => {
    const value = 'just some text';
    const edit = continueListOnEnter(value, value.length);

    expect(edit).toBeNull();
  });

  it('returns null for a marker with no trailing space', () => {
    const value = '-text';
    const edit = continueListOnEnter(value, value.length);

    expect(edit).toBeNull();
  });

  it('only considers the current line when the document has multiple lines', () => {
    const value = 'first line\n- second item';
    const caret = value.length;
    const edit = continueListOnEnter(value, caret);

    expect(edit?.insert).toBe('\n- ');
    expect(edit?.replaceStart).toBe(caret);
  });
});

describe('indentListSelection', () => {
  it('indents a single list line by two spaces', () => {
    const value = '- item';
    const edit = indentListSelection(value, 2, 2);

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('  - item');
    expect(edit?.replaceStart).toBe(0);
    expect(edit?.replaceEnd).toBe(value.length);
    expect(edit?.selectionStart).toBe(4);
    expect(edit?.selectionEnd).toBe(4);
  });

  it('returns null (native Tab / focus movement) outside a list', () => {
    const value = 'plain paragraph text';
    const edit = indentListSelection(value, 5, 5);

    expect(edit).toBeNull();
  });

  it('outdents a nested list line by up to two spaces', () => {
    const value = '  - item';
    const caret = value.length;
    const edit = indentListSelection(value, caret, caret, { outdent: true });

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('- item');
  });

  it('returns null outdenting at zero indent (nothing to remove)', () => {
    const value = '- item';
    const edit = indentListSelection(value, 2, 2, { outdent: true });

    expect(edit).toBeNull();
  });

  it('outdents a partial (one-space) indent by only what is there', () => {
    const value = ' - item';
    const caret = value.length;
    const edit = indentListSelection(value, caret, caret, { outdent: true });

    expect(edit?.insert).toBe('- item');
  });

  it('indents every line covered by a multi-line selection', () => {
    const value = '- one\n- two\n- three';
    const start = 0;
    const end = value.length;
    const edit = indentListSelection(value, start, end);

    expect(edit?.insert).toBe('  - one\n  - two\n  - three');
    expect(edit?.selectionStart).toBe(2);
    expect(edit?.selectionEnd).toBe(end + 6); // three lines shifted by 2 each
  });

  it('does not indent a genuinely empty line within the covered range', () => {
    const value = '- one\n\n- two';
    const edit = indentListSelection(value, 0, value.length);

    expect(edit?.insert).toBe('  - one\n\n  - two');
  });
});

describe('toggleWrap', () => {
  it('wraps a selection in bold markers', () => {
    const value = 'hello world';
    const edit = toggleWrap(value, 0, 5, '**');

    expect(edit.insert).toBe('**hello**');
    expect(edit.replaceStart).toBe(0);
    expect(edit.replaceEnd).toBe(5);
    expect(edit.selectionStart).toBe(2);
    expect(edit.selectionEnd).toBe(7);
  });

  it('unwraps an already-bolded selection', () => {
    const value = '**hello** world';
    const edit = toggleWrap(value, 2, 7, '**');

    expect(edit.insert).toBe('hello');
    expect(edit.replaceStart).toBe(0);
    expect(edit.replaceEnd).toBe(9);
    expect(edit.selectionStart).toBe(0);
    expect(edit.selectionEnd).toBe(5);
  });

  it('inserts an empty pair with the caret between them for a collapsed caret', () => {
    const value = 'hello world';
    const edit = toggleWrap(value, 5, 5, '_');

    expect(edit.insert).toBe('__');
    expect(edit.selectionStart).toBe(6);
    expect(edit.selectionEnd).toBe(6);
  });
});

describe('linkSelection', () => {
  it('wraps a selection as a link with the caret inside the parens', () => {
    const value = 'see docs';
    const edit = linkSelection(value, 4, 8); // "docs"

    expect(edit.insert).toBe('[docs]()');
    expect(edit.selectionStart).toBe(edit.selectionEnd);
    // Caret sits just before the closing paren.
    expect(edit.selectionStart).toBe(4 + edit.insert.length - 1);
  });

  it('gives an empty bracket pair with the caret inside the brackets for a collapsed caret', () => {
    const value = 'see here';
    const edit = linkSelection(value, 4, 4);

    expect(edit.insert).toBe('[]()');
    expect(edit.selectionStart).toBe(5);
    expect(edit.selectionEnd).toBe(5);
  });
});

describe('isSingleLineAbsoluteUrl', () => {
  it('accepts a plain https URL', () => {
    expect(isSingleLineAbsoluteUrl('https://example.com/path')).toBe(true);
  });

  it('accepts a URL with surrounding whitespace (trimmed)', () => {
    expect(isSingleLineAbsoluteUrl('  https://example.com  \n')).toBe(true);
  });

  it('rejects multi-word text', () => {
    expect(isSingleLineAbsoluteUrl('see https://example.com for details')).toBe(false);
  });

  it('rejects plain text with no scheme', () => {
    expect(isSingleLineAbsoluteUrl('example.com')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSingleLineAbsoluteUrl('   ')).toBe(false);
  });
});

describe('linkFromPastedUrl', () => {
  it('wraps the selected text as a link to the pasted URL', () => {
    const value = 'read the docs';
    const start = value.indexOf('docs');
    const end = start + 4;
    const edit = linkFromPastedUrl(value, start, end, 'https://example.com/docs');

    expect(edit).not.toBeNull();
    expect(edit?.insert).toBe('[docs](https://example.com/docs)');
    expect(edit?.replaceStart).toBe(start);
    expect(edit?.replaceEnd).toBe(end);
  });

  it('returns null for a collapsed caret', () => {
    const value = 'read the docs';
    const edit = linkFromPastedUrl(value, 5, 5, 'https://example.com');

    expect(edit).toBeNull();
  });

  it('returns null when the pasted text is not a URL', () => {
    const value = 'read the docs';
    const edit = linkFromPastedUrl(value, 9, 13, 'not a url');

    expect(edit).toBeNull();
  });
});

describe('shouldConvertPastedHtml', () => {
  it('converts a fragment with a link, matching a pasted GitHub issue', () => {
    const html = '<p>See <a href="https://example.com">the docs</a> for details.</p><ul><li>one</li></ul>';

    expect(shouldConvertPastedHtml(html)).toBe(true);
  });

  it('converts a fragment with a heading and a code block', () => {
    const html = '<h2>Title</h2><pre><code>const x = 1;</code></pre>';

    expect(shouldConvertPastedHtml(html)).toBe(true);
  });

  it('converts a fragment with a table', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr></table>';

    expect(shouldConvertPastedHtml(html)).toBe(true);
  });

  it('does not convert styled-but-structurally-plain text, matching a pasted VS Code selection', () => {
    const html = '<div><span style="color: #d4d4d4">const</span> <span style="color: #9cdcfe">x</span> = 1;</div>';

    expect(shouldConvertPastedHtml(html)).toBe(false);
  });

  it('converts uppercase tags, matching a pasted Word/Outlook fragment', () => {
    const html = '<P>See <A HREF="https://example.com">the docs</A> for details.</P>';

    expect(shouldConvertPastedHtml(html)).toBe(true);
  });

  it('does not false-positive on tags that merely start with a structural letter', () => {
    // <article>, <button>, <input>, and <iframe> each begin with a letter the
    // regex treats as structural (a, b, i) - the `\b` word boundary in
    // STRUCTURAL_HTML_TAG_RE is what keeps them from matching. None of these
    // tags lose anything if pasted as plain text, so a false positive here
    // would send ordinary rich content through turndown for no reason.
    expect(shouldConvertPastedHtml('<article>plain content</article>')).toBe(false);
    expect(shouldConvertPastedHtml('<button>Click</button>')).toBe(false);
    expect(shouldConvertPastedHtml('<input type="text" value="x">')).toBe(false);
    expect(shouldConvertPastedHtml('<iframe src="https://example.com"></iframe>')).toBe(false);
  });
});
