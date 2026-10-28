/**
 * What the document variant of MarkdownRenderer lets a README load or link to.
 *
 * A markdown file in the Changes panel carries raw HTML, and the renderer's own
 * origin is `file://` when packaged, so a URL written in the document must be
 * resolved before it is allowed near an element. These pin the places where
 * that resolution is the only thing between a document and the user's machine
 * or the app: an image path that climbs above the repo root, a protocol-relative
 * URL, a `file:` image, the tags and attributes the sanitizer removes, and a
 * GitHub alert written with CRLF line endings.
 *
 * markdown-document-render.test.ts pins the variant's happy paths; this file
 * holds the refusals. Each document renders alone, because an unclosed tag such
 * as `<svg>` changes how the HTML parser reads whatever follows it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Element, Root } from 'hast';
import { MarkdownRenderer, type MarkdownDocumentOptions } from '../../src/renderer/components/MarkdownRenderer';
import { loadDocumentPlugins } from '../../src/renderer/utils/markdown-document-plugins';
import { rehypeGithubAlerts } from '../../src/renderer/utils/markdown-document-pipeline';

function documentOptions(overrides: Partial<MarkdownDocumentOptions> = {}): MarkdownDocumentOptions {
  return {
    baseFilePath: 'README.md',
    colorScheme: 'dark',
    isFileListed: () => false,
    openFile: () => {},
    scrollToAnchor: () => {},
    loadImage: async () => null,
    highlight: async () => null,
    ...overrides,
  };
}

function renderDocument(content: string, options: MarkdownDocumentOptions = documentOptions()): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, { i18n }, createElement(MarkdownRenderer, { content, documentOptions: options })),
  );
}

beforeAll(async () => {
  // The variant renders on its first paint once the lazy pipeline has loaded.
  await loadDocumentPlugins();
});

describe('an image that names no repo file', () => {
  it('shows the alt text for a path that climbs above the repo root', () => {
    const markup = renderDocument('![Outside](../outside.png)');
    expect(markup).toContain('<span class="md-image-missing">Outside</span>');
    expect(markup).not.toContain('src="../outside.png"');
    expect(markup).not.toContain('outside.png');
  });

  it('shows the alt text for a path that climbs out of a nested folder past the root', () => {
    // From docs/guide.md, `../../x.png` is one level above the root.
    const markup = renderDocument('![Outside](../../x.png)', documentOptions({ baseFilePath: 'docs/guide.md' }));
    expect(markup).toContain('<span class="md-image-missing">Outside</span>');
    expect(markup).not.toContain('x.png');
  });

  it('shows the alt text for an HTML image whose path climbs above the repo root', () => {
    const markup = renderDocument('<img src="../outside.png" alt="Outside">');
    expect(markup).toContain('<span class="md-image-missing">Outside</span>');
    expect(markup).not.toContain('src="../outside.png"');
  });

  it('upgrades a protocol-relative HTML image to https', () => {
    const markup = renderDocument('<img src="//img.example.invalid/x.png" alt="Remote">');
    expect(markup).toContain('src="https://img.example.invalid/x.png"');
    expect(markup).not.toContain('src="//');
  });

  it('upgrades a protocol-relative markdown image to https', () => {
    const markup = renderDocument('![Remote](//img.example.invalid/x.png)');
    expect(markup).toContain('src="https://img.example.invalid/x.png"');
    expect(markup).not.toContain('src="//');
  });

  it('keeps an https image as written', () => {
    const markup = renderDocument('![Remote](https://img.example.invalid/x.png)');
    expect(markup).toContain('src="https://img.example.invalid/x.png"');
  });

  it('never renders a file: image, showing its alt text instead', () => {
    const markup = renderDocument('<img src="file:///etc/hosts" alt="Local">');
    expect(markup).not.toContain('file:');
    expect(markup).toContain('<span class="md-image-missing">Local</span>');
  });

  it('shows the alt text for an image with an empty src', () => {
    const markup = renderDocument('<img src="" alt="Empty">');
    expect(markup).toContain('<span class="md-image-missing">Empty</span>');
    expect(markup).not.toContain('<img');
  });
});

describe('an external link', () => {
  it('renders a protocol-relative HTML link as https', () => {
    const markup = renderDocument('<a href="//example.invalid/page">page</a>');
    expect(markup).toContain('href="https://example.invalid/page"');
    expect(markup).not.toContain('href="//');
  });

  it('renders a protocol-relative markdown link as https', () => {
    const markup = renderDocument('[page](//example.invalid/page)');
    expect(markup).toContain('href="https://example.invalid/page"');
    expect(markup).not.toContain('href="//');
  });

  it('keeps an https link as written', () => {
    expect(renderDocument('<a href="https://example.invalid/page">page</a>')).toContain('href="https://example.invalid/page"');
  });
});

interface StrippedCase {
  name: string;
  html: string;
  /** Text that must not appear anywhere in the markup. */
  absent: RegExp[];
  /** Text that must still appear, so the case cannot pass on an empty render. */
  present?: string[];
}

const STRIPPED_CASES: StrippedCase[] = [
  {
    name: 'a form and its action',
    html: '<form action="https://example.invalid">Submit</form>',
    absent: [/<form/i, /action/i, /example\.invalid/],
  },
  {
    name: 'an object element and its data',
    html: '<object data="x.swf">Fallback</object>',
    absent: [/<object/i, /\bdata=/i, /x\.swf/],
  },
  {
    name: 'an embed element',
    html: '<embed src="x.swf">',
    absent: [/<embed/i, /x\.swf/],
  },
  {
    name: 'a meta refresh',
    html: '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    absent: [/<meta/i, /http-?equiv/i, /refresh/i, /example\.invalid/],
  },
  {
    name: 'a base element',
    html: '<base href="https://example.invalid/">',
    absent: [/<base/i, /example\.invalid/],
  },
  {
    // The sanitizer's strip list holds only `script`, so a removed <style>
    // may leave its CSS behind as plain text. That text styles nothing; the
    // element is what must be gone.
    name: 'a style element',
    html: '<style>body{display:none}</style>',
    absent: [/<style/i],
  },
  {
    name: 'an svg element and its onload handler',
    html: '<svg onload="alert(1)"></svg>',
    absent: [/<svg/i, /onload/i, /alert/],
  },
  {
    name: 'a data: link',
    html: '<a href="data:text/html,hi">data</a>',
    absent: [/data:/i],
    present: ['data</a>'],
  },
  {
    name: 'a data: image',
    html: '<img src="data:image/png;base64,AAAA" alt="d">',
    absent: [/data:/i, /base64/i],
    present: ['<span class="md-image-missing">d</span>'],
  },
  {
    // Written with a src as well, so the image renders and spreads whatever
    // attributes the sanitizer let through. Without a src the renderer shows
    // the alt text and a surviving srcset would never reach the markup.
    name: 'a srcset on an image that renders',
    html: '<img src="https://example.invalid/a.png" srcset="https://example.invalid/b.png 2x" alt="s">',
    absent: [/srcset/i, /b\.png/],
    present: ['src="https://example.invalid/a.png"'],
  },
  {
    name: 'a srcset on an image with no src',
    html: '<img srcset="https://example.invalid/a.png 2x" alt="s">',
    absent: [/srcset/i, /a\.png/],
    present: ['<span class="md-image-missing">s</span>'],
  },
];

describe('what the sanitizer strips from a document', () => {
  it.each(STRIPPED_CASES)('removes $name', ({ html, absent, present = [] }) => {
    const markup = renderDocument(`Kept sentinel.\n\n${html}`);
    // The sentinel proves the document rendered at all, so an absence below is
    // the sanitizer's work and not an empty render.
    expect(markup).toContain('Kept sentinel.');
    for (const pattern of absent) {
      expect(markup).not.toMatch(pattern);
    }
    for (const text of present) {
      expect(markup).toContain(text);
    }
  });
});

describe('a GitHub alert written with CRLF line endings', () => {
  it('draws the alert and removes its marker', () => {
    const markup = renderDocument('> [!NOTE]\r\n> Text.');
    expect(markup).toContain('data-alert="note"');
    expect(markup).toContain('Text.');
    expect(markup).not.toContain('[!NOTE]');
    expect(markup).not.toContain('<blockquote>');
  });

  it('keeps every line of a first paragraph that continues past the marker', () => {
    const markup = renderDocument('> [!TIP]\r\n> First line.\r\n> Second line.');
    expect(markup).toContain('data-alert="tip"');
    expect(markup).toContain('First line.');
    expect(markup).toContain('Second line.');
    expect(markup).not.toContain('[!TIP]');
  });

  describe('the alert step on its own', () => {
    // The parser keeps the carriage return in the paragraph's text node today,
    // which is what makes the renders above exercise the CRLF pattern. This
    // drives the step with the text written out, so that pin holds even if a
    // parser upgrade starts normalizing line endings first.
    function blockquoteHolding(text: string): Root {
      const paragraph: Element = { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: text }] };
      const blockquote: Element = { type: 'element', tagName: 'blockquote', properties: {}, children: [paragraph] };
      return { type: 'root', children: [blockquote] };
    }

    function firstElement(tree: Root): Element {
      const first = tree.children[0];
      if (first.type !== 'element') throw new Error('The root has no element child');
      return first;
    }

    it('converts a marker that ends in a carriage return and line feed', () => {
      const tree = blockquoteHolding('[!NOTE]\r\nText.');
      rehypeGithubAlerts()(tree);
      const alert = firstElement(tree);
      expect(alert.tagName).toBe('div');
      expect(alert.properties).toEqual({ dataAlert: 'note' });
      const paragraph = alert.children[0];
      if (paragraph.type !== 'element') throw new Error('The alert lost its paragraph');
      expect(paragraph.children).toEqual([{ type: 'text', value: 'Text.' }]);
    });

    it('converts a marker that ends in a line feed', () => {
      const tree = blockquoteHolding('[!TIP]\nText.');
      rehypeGithubAlerts()(tree);
      expect(firstElement(tree).properties).toEqual({ dataAlert: 'tip' });
    });

    it('leaves a marker followed by text on the same line as a blockquote', () => {
      const tree = blockquoteHolding('[!NOTE] same line\r\nText.');
      rehypeGithubAlerts()(tree);
      expect(firstElement(tree).tagName).toBe('blockquote');
    });
  });
});
