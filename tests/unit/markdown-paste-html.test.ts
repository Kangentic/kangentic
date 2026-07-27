/**
 * Unit coverage for `convertHtmlToMarkdown`, the lazy turndown + GFM wrapper
 * behind DescriptionEditor's HTML-paste conversion. Runs in the default node
 * environment with no jsdom: turndown v7 bundles its own domino DOM parser
 * for Node, so this exercises the real conversion path the app uses.
 */
import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown } from '../../src/renderer/utils/markdown-paste-html';
import { shouldConvertPastedHtml } from '../../src/renderer/utils/markdown-editing';

/**
 * A real-shape `text/html` clipboard flavor, as Chromium hands one over after a
 * selection is copied out of a rendered GitHub issue: the injected `<meta>`, the
 * StartFragment/EndFragment markers, and the forge's own class / `dir` / inline
 * style noise wrapped around the content that actually matters. The synthetic
 * one-tag fragments below cannot catch a wrapper that defeats the
 * `shouldConvertPastedHtml` gate or throws the converter off, which is the whole
 * failure mode for a parser reading input from outside the TypeScript boundary.
 */
const GITHUB_ISSUE_CLIPBOARD_HTML = [
  "<meta charset='utf-8'>",
  '<!--StartFragment-->',
  '<div class="markdown-body" style="box-sizing: border-box;">',
  '<p dir="auto" style="margin-top: 0px; margin-bottom: 16px;">',
  'The <a href="https://example.com/docs" rel="nofollow">resolver</a> drops the ',
  '<code class="notranslate" style="padding: 0.2em 0.4em;">cwd</code> argument.',
  '</p>',
  '<ul dir="auto" style="padding-left: 2em; margin-bottom: 16px;">',
  '<li style="margin-top: 0.25em;">Reproduces on <strong>Windows</strong> only.</li>',
  '<li style="margin-top: 0.25em;">Not reproducible under CI.</li>',
  '</ul>',
  '</div>',
  '<!--EndFragment-->',
].join('');

describe('convertHtmlToMarkdown', () => {
  it('converts a real Chromium clipboard fragment copied from a rendered GitHub issue', async () => {
    // The gate runs first in DescriptionEditor.handlePaste; a wrapper that hid
    // the structural tags would silently downgrade the paste to plain text.
    expect(shouldConvertPastedHtml(GITHUB_ISSUE_CLIPBOARD_HTML)).toBe(true);

    const markdown = await convertHtmlToMarkdown(GITHUB_ISSUE_CLIPBOARD_HTML);

    expect(markdown).toContain('[resolver](https://example.com/docs)');
    expect(markdown).toContain('`cwd`');
    expect(markdown).toContain('**Windows**');
    expect(markdown).toContain('*   Reproduces on');
    expect(markdown).toContain('*   Not reproducible under CI.');
    // The clipboard scaffolding is stripped, not carried into the description.
    expect(markdown).not.toContain('StartFragment');
    expect(markdown).not.toContain('markdown-body');
    expect(markdown).not.toContain('box-sizing');
  });

  it('yields an empty string for a structural tag with no content', async () => {
    // Load-bearing for applyTextareaEdit's collapsed-caret guard: these clear
    // shouldConvertPastedHtml, so handlePaste preventDefaults and then has
    // nothing to insert. Without the guard the resulting empty edit reached
    // execCommand('delete'), which backspaces over the character before the
    // caret.
    for (const html of ['<strong></strong>', '<em></em>', '<pre></pre>', '<ul></ul>']) {
      expect(shouldConvertPastedHtml(html)).toBe(true);
      expect(await convertHtmlToMarkdown(html)).toBe('');
    }
  });

  it('converts a nested list', async () => {
    const html = '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>';
    const markdown = await convertHtmlToMarkdown(html);

    expect(markdown).toContain('*   one');
    expect(markdown).toContain('*   two');
    expect(markdown).toContain('nested');
  });

  it('converts a fenced code block', async () => {
    const html = '<pre><code>const x = 1;\nconsole.log(x);</code></pre>';
    const markdown = await convertHtmlToMarkdown(html);

    expect(markdown).toContain('```');
    expect(markdown).toContain('const x = 1;');
  });

  it('converts a GFM table', async () => {
    const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const markdown = await convertHtmlToMarkdown(html);

    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('| 1 | 2 |');
  });

  it('converts a link', async () => {
    const html = '<p>See <a href="https://example.com">the docs</a>.</p>';
    const markdown = await convertHtmlToMarkdown(html);

    expect(markdown).toContain('[the docs](https://example.com)');
  });

  it('reuses the cached service across calls (no crash on repeated use)', async () => {
    const first = await convertHtmlToMarkdown('<strong>a</strong>');
    const second = await convertHtmlToMarkdown('<em>b</em>');

    expect(first).toContain('a');
    expect(second).toContain('b');
  });
});
