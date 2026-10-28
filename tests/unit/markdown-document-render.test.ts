/**
 * MarkdownRenderer's two shapes.
 *
 * The default renders agent and user prose (transcripts, task descriptions,
 * release notes, announcements), where an agent writing `<tag>` means the
 * text, so HTML must stay escaped there. The document variant renders a
 * repository file in the Changes panel the way GitHub shows it: GitHub's
 * sanitized HTML subset, heading ids, alerts.
 *
 * These pin the escaping, which surface may opt into the variant, and the
 * sanitizer schema, which is the part a dependency bump could quietly change.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { MarkdownRenderer, type MarkdownDocumentOptions } from '../../src/renderer/components/MarkdownRenderer';
import { loadDocumentPlugins } from '../../src/renderer/utils/markdown-document-plugins';
import { anchorElementIds } from '../../src/renderer/utils/markdown-repo-link';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The header block of a translated README, the shape GitHub READMEs use. */
const README_HEADER = `<!-- readme-translation source-blob=0123456789abcdef -->
<p align="center">
  <a href="https://example.com"><img src="https://example.com/logo.png" alt="Logo" width="96" /></a>
</p>

<h1 align="center">Sample</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.example.com/license.svg" alt="License" /></a>
  <a href="README.de.md">Deutsch</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://example.com/board-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="https://example.com/board-light.png" />
  <source media="(min-width: 600px)" srcset="https://example.com/board-wide.png" />
  <img src="https://example.com/board-dark.png" alt="The board" width="900" />
</picture>
`;

function documentOptions(overrides: Partial<MarkdownDocumentOptions> = {}): MarkdownDocumentOptions {
  return {
    baseFilePath: 'README.cs.md',
    colorScheme: 'dark',
    isFileListed: (filePath) => filePath === 'README.de.md',
    openFile: () => {},
    scrollToAnchor: () => {},
    loadImage: async () => null,
    highlight: async () => null,
    ...overrides,
  };
}

function render(content: string, options?: MarkdownDocumentOptions): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, { i18n }, createElement(MarkdownRenderer, { content, documentOptions: options })),
  );
}

beforeAll(async () => {
  // The variant renders on its first paint once the lazy pipeline has loaded.
  await loadDocumentPlugins();
});

describe('the default MarkdownRenderer', () => {
  it('shows HTML as text, comments included', () => {
    const markup = render(README_HEADER);
    expect(markup).toContain('&lt;p align=&quot;center&quot;&gt;');
    expect(markup).toContain('&lt;!-- readme-translation');
    expect(markup).not.toContain('<p align="center">');
    expect(markup).not.toContain('<picture>');
  });

  it('is the only shape any surface but the Changes panel preview renders', () => {
    const optingIn: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(entryPath);
        else if (entry.name.endsWith('.tsx') && /\bdocumentOptions=/.test(fs.readFileSync(entryPath, 'utf8'))) {
          optingIn.push(path.relative(REPO_ROOT, entryPath).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src/renderer'));
    expect(optingIn).toEqual(['src/renderer/components/dialogs/task-detail/changes/DiffViewer.tsx']);
  });
});

describe('the document variant', () => {
  it('keeps the README header GitHub draws', () => {
    const markup = render(README_HEADER, documentOptions());
    expect(markup).toContain('<p align="center">');
    expect(markup).toContain('<h1 align="center"');
    expect(markup).toContain('width="96"');
    expect(markup).toContain('<picture>');
    expect(markup).toContain('width="900"');
    // A media query that is not a color scheme is left to the browser.
    expect(markup).toContain('<source srcSet="https://example.com/board-wide.png" media="(min-width: 600px)"/>');
  });

  it('drops HTML comments', () => {
    expect(render(README_HEADER, documentOptions())).not.toContain('readme-translation');
  });

  it('picks the <picture> source for the app\'s theme, not the OS\'s', () => {
    const dark = render(README_HEADER, documentOptions({ colorScheme: 'dark' }));
    expect(dark).toContain('<source srcSet="https://example.com/board-dark.png"/>');
    expect(dark).not.toContain('board-light.png');
    const light = render(README_HEADER, documentOptions({ colorScheme: 'light' }));
    expect(light).toContain('<source srcSet="https://example.com/board-light.png"/>');
    expect(light).not.toContain('srcSet="https://example.com/board-dark.png"');
  });

  it('turns a link to a listed file into a link and one to any other file into inert text', () => {
    const markup = render(README_HEADER, documentOptions());
    expect(markup).toContain('<a href="README.de.md">Deutsch</a>');
    expect(markup).not.toContain('href="LICENSE"');
    expect(markup).toMatch(/<span class="md-link-unlisted"[^>]*data-testid="markdown-link-unlisted"[^>]*><img[^>]*alt="License"/);
  });

  it('strips what GitHub strips', () => {
    const markup = render([
      '<script>alert(1)</script>',
      '<img src="x.png" onerror="alert(2)" alt="x">',
      '<p style="color: red">styled</p>',
      '<a href="https://example.com" title="A native tip">titled</a>',
      '<a href="javascript:alert(3)">bad</a>',
      '<iframe src="https://example.com"></iframe>',
    ].join('\n\n'), documentOptions());
    expect(markup).not.toContain('alert(1)');
    expect(markup).not.toContain('onerror');
    expect(markup).not.toContain('style=');
    expect(markup).not.toContain('title=');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('<iframe');
    // No native tooltips in the renderer (.claude/rules/one-tooltip.md).
    expect(markup).toContain('<a href="https://example.com">titled</a>');
  });

  it('keeps only the http(s) candidates of an absolute <source> srcset', () => {
    const markup = render([
      '<picture>',
      '  <source media="(min-width: 600px)" srcset="file:///etc/hosts 1x, https://example.com/wide.png 2x" />',
      '  <source media="(min-width: 300px)" srcset="file:///etc/hosts" />',
      '  <img src="https://example.com/narrow.png" alt="Board" />',
      '</picture>',
    ].join('\n'), documentOptions());
    expect(markup).not.toContain('file:');
    expect(markup).toContain('srcSet="https://example.com/wide.png 2x"');
    expect(markup).not.toContain('min-width: 300px');
  });

  it('gives a heading GitHub\'s id, with the sanitizer\'s prefix', () => {
    expect(render('## Install guide', documentOptions())).toContain('<h2 id="user-content-install-guide">Install guide</h2>');
  });

  it('prefixes an id written in HTML the same way', () => {
    expect(render('<a name="top" id="top"></a>', documentOptions())).toContain('id="user-content-top"');
  });

  it('gives a footnote GitHub\'s ids, prefixed once, and a link the anchor handler can follow', () => {
    const markup = render('A claim.[^source]\n\n[^source]: Where it came from.', documentOptions());
    // remark-rehype and the sanitizer both prefix ids; only the sanitizer may.
    expect(markup).not.toContain('user-content-user-content-');
    expect(markup).toContain('id="user-content-fn-source"');
    expect(markup).toContain('id="user-content-fnref-source"');
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(anchors.length).toBe(2);
    for (const anchor of anchors) {
      expect(anchorElementIds(anchor).some((id) => markup.includes(`id="${id}"`))).toBe(true);
    }
  });

  it('keeps a fenced block\'s language class for the highlighter', () => {
    expect(render('```ts\nconst answer = 42;\n```', documentOptions())).toContain('<code class="language-ts">');
  });

  it('keeps <details> and <summary>', () => {
    const markup = render('<details><summary>More</summary>\n\nHidden text.\n\n</details>', documentOptions());
    expect(markup).toContain('<details><summary>More</summary>');
  });

  it('renders a relative image without a request until its bytes arrive', () => {
    const markup = render('![Board](docs/images/board.png)', documentOptions());
    expect(markup).toContain('<img alt="Board"/>');
  });

  it('shows the alt text of a relative file that is not an image', () => {
    expect(render('![Spec](docs/spec.pdf)', documentOptions())).toContain('<span class="md-image-missing">Spec</span>');
  });
});

describe('GitHub alerts in the document variant', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('draws [!%s] as an alert', (marker) => {
    const markup = render(`> [!${marker}]\n> Read this first.`, documentOptions());
    const kind = marker.toLowerCase();
    expect(markup).toContain(`<div class="markdown-alert markdown-alert-${kind}" data-alert="${kind}">`);
    expect(markup).toContain('Read this first.');
    expect(markup).not.toContain(`[!${marker}]`);
    expect(markup).not.toContain('<blockquote>');
  });

  it('reads the marker in any case, and drops a marker paragraph left empty', () => {
    const markup = render('> [!warning]\n>\n> Careful.', documentOptions());
    expect(markup).toContain('data-alert="warning"');
    expect(markup).not.toContain('<p></p>');
  });

  it('leaves a blockquote alone when the marker shares its line', () => {
    const markup = render('> [!NOTE] not an alert', documentOptions());
    expect(markup).toContain('<blockquote>');
    expect(markup).not.toContain('data-alert');
  });

  it('never lets a document write its own alert', () => {
    const markup = render('<div data-alert="note">Pretend</div>', documentOptions());
    expect(markup).not.toContain('data-alert');
    expect(markup).not.toContain('markdown-alert');
  });

  it('leaves an unknown marker as a blockquote', () => {
    expect(render('> [!DANGER]\n> Text.', documentOptions())).toContain('<blockquote>');
  });
});
