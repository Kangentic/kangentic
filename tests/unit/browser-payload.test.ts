/**
 * Unit tests for the pure helpers in src/main/ipc/handlers/browser-payload.ts.
 *
 * All functions are deterministic, have no I/O, and can be tested in Node
 * without Electron or a browser. The test runs in vitest against the compiled
 * TypeScript source via ts-node/esbuild transform.
 */

import { describe, it, expect } from 'vitest';
import {
  ANNOTATIONS_INLINE_LIMIT,
  buildAnnotationsPayload,
  buildPromptPayload,
  describeDrawing,
  pngWidth,
  formatAncestors,
  formatStyles,
  isMeaningfulStyle,
  isTrivialWrapper,
  isValidSessionId,
  isCrossDrivePath,
  validAnnotationInputs,
  SELECTION_INLINE_LIMIT,
} from '../../src/main/ipc/handlers/browser-payload';
import { escapeXml } from '../../src/main/agent/shared';
import type { BrowserAnnotationSendInput, BrowserCaptureInput, BrowserPickedElement } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeElement(overrides: Partial<BrowserPickedElement> = {}): BrowserPickedElement {
  return {
    selector: 'button.primary',
    tagName: 'BUTTON',
    id: undefined,
    classes: [],
    testId: undefined,
    ariaLabel: undefined,
    role: 'button',
    accessibleName: 'Submit',
    text: 'Submit',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    computedStyles: {},
    outerHTML: '<button class="primary">Submit</button>',
    ancestors: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<BrowserCaptureInput> = {}): BrowserCaptureInput {
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    taskId: 'task-1',
    cwd: '/projects/myapp',
    url: 'https://example.com',
    pngBase64: 'abc123',
    annotations: [],
    viewport: null,
    selectedText: '',
    note: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quote', () => {
    expect(escapeXml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('escapes all special chars in one string', () => {
    expect(escapeXml('<a href="x&y">z</a>')).toBe('&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// isMeaningfulStyle
// ---------------------------------------------------------------------------

describe('isMeaningfulStyle', () => {
  it('returns false for empty value', () => {
    expect(isMeaningfulStyle('color', '')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: width', () => {
    expect(isMeaningfulStyle('width', '100px')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: height', () => {
    expect(isMeaningfulStyle('height', '50px')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: display', () => {
    expect(isMeaningfulStyle('display', 'block')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "none"', () => {
    expect(isMeaningfulStyle('outline', 'none')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "auto"', () => {
    expect(isMeaningfulStyle('overflow', 'auto')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "0px"', () => {
    expect(isMeaningfulStyle('margin', '0px')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "1"', () => {
    expect(isMeaningfulStyle('font-weight', '1')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "transparent"', () => {
    expect(isMeaningfulStyle('background', 'transparent')).toBe(false);
  });

  it('returns false for four-zero box shorthand', () => {
    expect(isMeaningfulStyle('padding', '0px 0px 0px 0px')).toBe(false);
  });

  it('returns false for border starting with 0px', () => {
    expect(isMeaningfulStyle('border', '0px solid red')).toBe(false);
  });

  it('returns false for border exactly "0px"', () => {
    expect(isMeaningfulStyle('border', '0px')).toBe(false);
  });

  it('returns false for opacity: 1', () => {
    expect(isMeaningfulStyle('opacity', '1')).toBe(false);
  });

  it('returns true for meaningful color', () => {
    expect(isMeaningfulStyle('color', 'rgb(255, 0, 0)')).toBe(true);
  });

  it('returns true for non-trivial font-size', () => {
    expect(isMeaningfulStyle('font-size', '16px')).toBe(true);
  });

  it('returns true for border with non-zero width', () => {
    expect(isMeaningfulStyle('border', '1px solid black')).toBe(true);
  });

  it('returns true for opacity other than 1', () => {
    expect(isMeaningfulStyle('opacity', '0.5')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatStyles
// ---------------------------------------------------------------------------

describe('formatStyles', () => {
  it('returns ["(defaults)"] when all styles are default', () => {
    expect(formatStyles({ width: '100px', height: '50px' })).toEqual(['(defaults)']);
  });

  it('returns ["(defaults)"] for empty object', () => {
    expect(formatStyles({})).toEqual(['(defaults)']);
  });

  it('returns meaningful styles formatted as "key: value"', () => {
    const result = formatStyles({ color: 'red', width: '100px' });
    expect(result).toEqual(['color: red']);
  });

  it('includes multiple meaningful styles', () => {
    const result = formatStyles({ color: 'red', 'font-size': '16px' });
    expect(result).toContain('color: red');
    expect(result).toContain('font-size: 16px');
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatAncestors
// ---------------------------------------------------------------------------

describe('formatAncestors', () => {
  it('returns "(none)" for empty ancestors array', () => {
    expect(formatAncestors([])).toBe('(none)');
  });

  it('formats a single ancestor with tag only', () => {
    expect(formatAncestors([
      { tagName: 'DIV', classes: [] },
    ])).toBe('div');
  });

  it('includes id when present', () => {
    expect(formatAncestors([
      { tagName: 'SECTION', id: 'main', classes: [] },
    ])).toBe('section#main');
  });

  it('includes testId when present', () => {
    expect(formatAncestors([
      { tagName: 'DIV', testId: 'my-container', classes: [] },
    ])).toBe('div[data-testid="my-container"]');
  });

  it('includes up to 3 classes', () => {
    expect(formatAncestors([
      { tagName: 'DIV', classes: ['a', 'b', 'c', 'd'] },
    ])).toBe('div.a.b.c');
  });

  it('includes role when present', () => {
    expect(formatAncestors([
      { tagName: 'NAV', classes: [], role: 'navigation' },
    ])).toBe('nav[role="navigation"]');
  });

  it('joins multiple ancestors with " > "', () => {
    const result = formatAncestors([
      { tagName: 'MAIN', classes: [] },
      { tagName: 'DIV', id: 'sidebar', classes: [] },
    ]);
    expect(result).toBe('main > div#sidebar');
  });
});

// ---------------------------------------------------------------------------
// isTrivialWrapper
// ---------------------------------------------------------------------------

describe('isTrivialWrapper', () => {
  it('returns true for <tag>text</tag>', () => {
    expect(isTrivialWrapper('<button>Submit</button>')).toBe(true);
  });

  it('returns true for self-closing with no inner content', () => {
    expect(isTrivialWrapper('<input />')).toBe(true);
  });

  it('returns false when inner HTML contains a child element', () => {
    expect(isTrivialWrapper('<div><span>hello</span></div>')).toBe(false);
  });

  it('returns false for nested elements regardless of depth', () => {
    expect(isTrivialWrapper('<div><a href="#"><strong>text</strong></a></div>')).toBe(false);
  });

  it('returns true for whitespace-only inner content', () => {
    expect(isTrivialWrapper('<p>   </p>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAnnotationsPayload
// ---------------------------------------------------------------------------

function makeAnnotation(overrides: Partial<BrowserAnnotationSendInput> = {}): BrowserAnnotationSendInput {
  return {
    number: 1,
    note: 'Make this primary',
    url: 'https://example.com',
    onPage: true,
    inViewport: true,
    items: [{ id: 'item-1', kind: 'element', element: makeElement() }],
    captureId: null,
    ...overrides,
  };
}

const PATHS = {
  screenshot: '.kangentic\\sessions\\s\\captures\\capture-1.png',
  captures: new Map<string, string>(),
  details: '.kangentic/sessions/s/captures/annotations-1.xml',
};

describe('buildAnnotationsPayload', () => {
  it('opens with the instructions, then the screenshot, then one annotations block', () => {
    const { payload, detailsXml } = buildAnnotationsPayload(
      makeInput({ annotations: [makeAnnotation()], viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 640 } }),
      PATHS,
    );
    const lines = payload.split('\n');
    expect(lines[0]).toMatch(/^The user annotated this page\./);
    expect(payload).toContain('Screenshot: @.kangentic/sessions/s/captures/capture-1.png');
    expect(payload).toContain('<annotations url="https://example.com" viewport="1280x720" scroll="0,640">');
    expect(payload.indexOf('Screenshot:')).toBeLessThan(payload.indexOf('<annotations'));
    expect(payload.trimEnd().endsWith('</annotations>')).toBe(true);
    expect(detailsXml).toBeNull();
  });

  it('puts each note before what it points at, numbered as the badges are', () => {
    const { payload } = buildAnnotationsPayload(makeInput({
      annotations: [
        makeAnnotation({ number: 1, note: 'First' }),
        makeAnnotation({ number: 2, note: 'Second', items: [{ id: 'd', kind: 'drawing', strokes: [[{ x: 10, y: 20 }, { x: 40, y: 60 }]] }] }),
      ],
    }), PATHS);
    expect(payload).toContain('<annotation n="1">\n    <note>First</note>\n    <element ');
    expect(payload).toContain('<annotation n="2">\n    <note>Second</note>\n    <drawing strokes="1" box="10,20,30,40" start="10,20" />');
  });

  it('gives an element its identity as attributes and its selector as text, escaped', () => {
    const element = makeElement({ testId: 'save', selector: 'button[data-testid="save"]', classes: ['btn', 'primary'] });
    const { payload } = buildAnnotationsPayload(makeInput({
      annotations: [makeAnnotation({ items: [{ id: 'e', kind: 'element', element }] })],
    }), PATHS);
    expect(payload).toContain('<element role="button" name="Submit" tag="button" testid="save" rect="10,20,100,40">');
    expect(payload).toContain('<selector>button[data-testid=&quot;save&quot;]</selector>');
    expect(payload).toContain('<classes>btn primary</classes>');
  });

  it('repeats the url only for an annotation made on another page, and marks one whose element is gone', () => {
    const { payload } = buildAnnotationsPayload(makeInput({
      annotations: [makeAnnotation({ number: 3, url: 'https://example.com/billing', onPage: false, inViewport: false })],
    }), PATHS);
    expect(payload).toContain('<annotation n="3" url="https://example.com/billing" on_page="false">');
  });

  it('names a capture once for every annotation out of the screenshot that shares it', () => {
    const { payload } = buildAnnotationsPayload(makeInput({
      annotations: [
        makeAnnotation({ number: 1, inViewport: true, captureId: 'aaaaaaaaaaaaaaaa' }),
        makeAnnotation({ number: 2, inViewport: false, captureId: 'bbbbbbbbbbbbbbbb' }),
        makeAnnotation({ number: 3, inViewport: false, captureId: 'bbbbbbbbbbbbbbbb' }),
      ],
    }), { ...PATHS, captures: new Map([['bbbbbbbbbbbbbbbb', 'caps\\annotation-2.png']]) });
    const captureLines = payload.split('\n').filter((line) => line.includes('annotation-2.png'));
    expect(captureLines).toEqual(['Annotations 2, 3, captured before the page scrolled: @caps/annotation-2.png']);
    // In view: its own capture is never named.
    expect(payload).not.toContain('Annotation 1,');
  });

  it('says a capture was taken on another page when every annotation in it was', () => {
    const { payload } = buildAnnotationsPayload(makeInput({
      annotations: [makeAnnotation({ number: 4, url: 'https://example.com/other', inViewport: false, captureId: 'cccccccccccccccc' })],
    }), { ...PATHS, captures: new Map([['cccccccccccccccc', 'annotation-4.png']]) });
    expect(payload).toContain('Annotation 4, captured on another page: @annotation-4.png');
  });

  it('keeps every element detail inline while the paste fits', () => {
    const element = makeElement({ computedStyles: { color: 'red' }, ancestors: [{ tagName: 'FORM', classes: [] }] });
    const { payload, detailsXml } = buildAnnotationsPayload(makeInput({
      annotations: [makeAnnotation({ items: [{ id: 'e', kind: 'element', element }] })],
    }), PATHS);
    expect(payload).toContain('<styles>color: red</styles>');
    expect(payload).toContain('<ancestors>form</ancestors>');
    expect(detailsXml).toBeNull();
  });

  it('moves styles, ancestors and HTML to the details file past the limit, and never a note', () => {
    const bigHtml = `<div>${'<span>x</span>'.repeat(200)}</div>`;
    const annotations = Array.from({ length: 6 }, (_unused, index) => makeAnnotation({
      number: index + 1,
      note: `Note ${index + 1}`,
      items: [{ id: `e${index}`, kind: 'element', element: makeElement({ outerHTML: bigHtml, computedStyles: { color: 'red' } }) }],
    }));
    const { payload, detailsXml } = buildAnnotationsPayload(makeInput({ annotations }), PATHS);

    expect(payload.length).toBeLessThanOrEqual(ANNOTATIONS_INLINE_LIMIT);
    expect(payload).toContain('Full styles and HTML for every element: .kangentic/sessions/s/captures/annotations-1.xml');
    expect(payload).not.toContain('<outer_html>');
    expect(payload).not.toContain('<styles>');
    for (let index = 1; index <= 6; index += 1) expect(payload).toContain(`<note>Note ${index}</note>`);
    expect(payload).toContain('<selector>button.primary</selector>');

    expect(detailsXml).toContain('<outer_html>');
    expect(detailsXml).toContain('<styles>color: red</styles>');
    expect(detailsXml).toContain('<note>Note 6</note>');
  });

  it('reads the scale of the screenshot against the viewport from the PNG header', () => {
    // A 1920px-wide PNG header for a 1280px viewport: scale 1.5.
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(1920, 16);
    header.writeUInt32BE(1080, 20);
    const pngBase64 = header.toString('base64');
    expect(pngWidth(pngBase64)).toBe(1920);
    const { payload } = buildAnnotationsPayload(makeInput({
      pngBase64,
      annotations: [makeAnnotation()],
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    }), PATHS);
    expect(payload).toContain('scale="1.5"');
  });
});

describe('describeDrawing', () => {
  it('reports the stroke count, the box around every point, and the first point', () => {
    expect(describeDrawing([[{ x: 470, y: 280 }, { x: 250, y: 228 }], [{ x: 260, y: 240 }]])).toEqual({
      strokes: 2,
      box: '250,228,220,52',
      start: '470,280',
    });
  });

  it('reports nothing for a drawing with no points', () => {
    expect(describeDrawing([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPromptPayload
// ---------------------------------------------------------------------------

describe('buildPromptPayload', () => {
  it('uses default copy when note is empty', () => {
    const result = buildPromptPayload(makeInput({ note: '' }), 'relative/path.png');
    expect(result).toContain('Look at this browser capture and tell me what you see.');
  });

  it('uses custom note when provided', () => {
    const result = buildPromptPayload(makeInput({ note: 'Check the button styles.' }), 'path.png');
    expect(result).toContain('Check the button styles.');
    expect(result).not.toContain('Look at this browser capture');
  });

  it('trims whitespace from note before using it', () => {
    const result = buildPromptPayload(makeInput({ note: '  Is this correct?  ' }), 'path.png');
    expect(result).toContain('Is this correct?');
    expect(result).not.toContain('Look at this browser capture');
  });

  it('includes @-mention to the relative PNG path', () => {
    const result = buildPromptPayload(makeInput(), 'captures/capture-123.png');
    expect(result).toContain('Screenshot: @captures/capture-123.png');
  });

  it('converts backslash separators to forward slashes in PNG path', () => {
    // On Windows, relativePngPath may contain backslashes. The function must
    // POSIX-ify them so the @-mention works on all platforms.
    const windowsPath = '.kangentic\\sessions\\abc\\captures\\capture-1.png';
    const result = buildPromptPayload(makeInput(), windowsPath);
    expect(result).toContain('Screenshot: @.kangentic/sessions/abc/captures/capture-1.png');
    expect(result).not.toContain('\\');
  });

  it('wraps output in <browser_context> block', () => {
    const result = buildPromptPayload(makeInput(), 'path.png');
    expect(result).toContain('<browser_context>');
    expect(result).toContain('</browser_context>');
  });

  it('includes <url> inside browser_context', () => {
    const result = buildPromptPayload(makeInput({ url: 'https://example.com/page' }), 'p.png');
    expect(result).toContain('<url>https://example.com/page</url>');
  });

  it('omits <selected_text> when selectedText is empty', () => {
    const result = buildPromptPayload(makeInput({ selectedText: '' }), 'p.png');
    expect(result).not.toContain('<selected_text>');
  });

  it('includes inline <selected_text> when within SELECTION_INLINE_LIMIT', () => {
    const selection = 'a'.repeat(SELECTION_INLINE_LIMIT);
    const result = buildPromptPayload(makeInput({ selectedText: selection }), 'p.png');
    expect(result).toContain('<selected_text>');
    expect(result).not.toContain('truncated="true"');
  });

  it('truncates <selected_text> with truncated="true" when over limit', () => {
    const selection = 'x'.repeat(SELECTION_INLINE_LIMIT + 1);
    const result = buildPromptPayload(makeInput({ selectedText: selection }), 'p.png');
    expect(result).toContain('<selected_text truncated="true">');
    expect(result).toContain('...');
    // Content should be exactly SELECTION_INLINE_LIMIT chars from the original
    const expectedTruncated = 'x'.repeat(SELECTION_INLINE_LIMIT);
    expect(result).toContain(expectedTruncated);
  });

});

// ---------------------------------------------------------------------------
// isValidSessionId
// ---------------------------------------------------------------------------

describe('isValidSessionId', () => {
  it('accepts a well-formed UUID v4', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidSessionId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts mixed-case UUID', () => {
    expect(isValidSessionId('aaaaaaaa-BBBB-cccc-DDDD-eeeeeeeeeeee')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects path traversal attempt', () => {
    expect(isValidSessionId('../../../etc/passwd')).toBe(false);
  });

  it('rejects UUID with too few segments', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716')).toBe(false);
  });

  it('rejects UUID with wrong segment lengths', () => {
    expect(isValidSessionId('550e84-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects non-hex characters in UUID', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
  });

  it('rejects a plain string', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCrossDrivePath
// ---------------------------------------------------------------------------

describe('isCrossDrivePath', () => {
  it('returns true for Windows absolute path with drive letter and backslash', () => {
    expect(isCrossDrivePath('D:\\some\\path')).toBe(true);
  });

  it('returns true for Windows absolute path with drive letter and forward slash', () => {
    expect(isCrossDrivePath('D:/some/path')).toBe(true);
  });

  it('returns true for uppercase drive letter', () => {
    expect(isCrossDrivePath('C:\\Users\\dev\\file.png')).toBe(true);
  });

  it('returns false for a relative path starting with ..', () => {
    expect(isCrossDrivePath('../captures/file.png')).toBe(false);
  });

  it('returns false for a POSIX absolute path', () => {
    expect(isCrossDrivePath('/home/dev/captures/file.png')).toBe(false);
  });

  it('returns false for a plain relative path', () => {
    expect(isCrossDrivePath('captures/file.png')).toBe(false);
  });

  it('returns true for a UNC path', () => {
    expect(isCrossDrivePath('\\\\server\\share\\x')).toBe(true);
  });
});

describe('validAnnotationInputs', () => {
  it('keeps a well formed annotation and drops numbers that are not 1 to 100 integers', () => {
    const good = makeAnnotation({ number: 3 });
    const bad = [1.5, 0, -1, 101, '2', Number.NaN, Number.MAX_SAFE_INTEGER + 2].map((number) => ({ ...makeAnnotation(), number }));
    const kept = validAnnotationInputs([...bad, good, makeAnnotation({ number: 100 })]);
    expect(kept.map((annotation) => annotation.number)).toEqual([3, 100]);
  });

  it('drops an annotation with a malformed item or capture id, and non-array input', () => {
    const malformedItem = { ...makeAnnotation(), items: [{ id: 'x', kind: 'element' }] };
    const badCapture = { ...makeAnnotation(), captureId: '../x' };
    expect(validAnnotationInputs([malformedItem, badCapture, null, 'x'])).toEqual([]);
    expect(validAnnotationInputs('nope')).toEqual([]);
  });
});

describe('buildAnnotationsPayload edge cases', () => {
  it('keeps a paste that is long only for its notes whole, with no details file', () => {
    const longNote = 'word '.repeat(ANNOTATIONS_INLINE_LIMIT);
    const drawing = [{ id: 'd', kind: 'drawing' as const, strokes: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]] }];
    const { payload, detailsXml } = buildAnnotationsPayload(
      makeInput({ annotations: [makeAnnotation({ note: longNote, items: drawing })] }),
      PATHS,
    );
    expect(payload.length).toBeGreaterThan(ANNOTATIONS_INLINE_LIMIT);
    expect(detailsXml).toBeNull();
    expect(payload).not.toContain('Full styles and HTML');
  });

  it('emits the viewport but no scroll when the scroll offsets are not finite', () => {
    const { payload } = buildAnnotationsPayload(
      makeInput({ annotations: [makeAnnotation()], viewport: { width: 1280, height: 720, scrollX: Number.NaN, scrollY: Number.NaN } }),
      PATHS,
    );
    expect(payload).toContain('viewport="1280x720"');
    expect(payload).not.toContain('scroll=');
  });
});
