import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown } from '../../src/main/import/azure-devops/azure-devops-importer';

describe('convertHtmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
  });

  it('returns empty string for null-like input', () => {
    expect(convertHtmlToMarkdown(null as unknown as string)).toBe('');
  });

  it('converts paragraphs', () => {
    expect(convertHtmlToMarkdown('<p>Hello world</p>')).toBe('Hello world');
  });

  it('converts bold text', () => {
    expect(convertHtmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(convertHtmlToMarkdown('<b>bold</b>')).toBe('**bold**');
  });

  it('converts italic text', () => {
    expect(convertHtmlToMarkdown('<em>italic</em>')).toBe('*italic*');
    expect(convertHtmlToMarkdown('<i>italic</i>')).toBe('*italic*');
  });

  it('converts links', () => {
    expect(convertHtmlToMarkdown('<a href="https://example.com">link text</a>')).toBe('[link text](https://example.com)');
  });

  it('converts images', () => {
    expect(convertHtmlToMarkdown('<img src="https://example.com/img.png" />')).toBe('![](https://example.com/img.png)');
  });

  it('converts images with alt text', () => {
    expect(convertHtmlToMarkdown('<img src="https://example.com/img.png" alt="screenshot" />')).toBe('![screenshot](https://example.com/img.png)');
  });

  it('converts headings h1 through h6', () => {
    expect(convertHtmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(convertHtmlToMarkdown('<h2>Subtitle</h2>')).toBe('## Subtitle');
    expect(convertHtmlToMarkdown('<h3>Section</h3>')).toBe('### Section');
    expect(convertHtmlToMarkdown('<h4>Subsection</h4>')).toBe('#### Subsection');
    expect(convertHtmlToMarkdown('<h5>Minor</h5>')).toBe('##### Minor');
    expect(convertHtmlToMarkdown('<h6>Smallest</h6>')).toBe('###### Smallest');
  });

  it('converts unordered lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
  });

  it('converts ordered lists', () => {
    const html = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain('1. First');
    expect(result).toContain('2. Second');
    expect(result).toContain('3. Third');
  });

  it('converts inline code', () => {
    expect(convertHtmlToMarkdown('<code>foo()</code>')).toBe('`foo()`');
  });

  it('converts code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain('```');
    expect(result).toContain('const x = 1;');
  });

  it('converts line breaks', () => {
    expect(convertHtmlToMarkdown('line1<br/>line2')).toBe('line1\nline2');
    expect(convertHtmlToMarkdown('line1<br>line2')).toBe('line1\nline2');
  });

  it('converts horizontal rules', () => {
    const result = convertHtmlToMarkdown('above<hr/>below');
    expect(result).toContain('---');
  });

  it('decodes HTML entities', () => {
    expect(convertHtmlToMarkdown('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
  });

  it('decodes numeric HTML entities', () => {
    expect(convertHtmlToMarkdown('&#169;')).toBe(String.fromCharCode(169));
  });

  it('strips unknown HTML tags', () => {
    expect(convertHtmlToMarkdown('<span class="custom">text</span>')).toBe('text');
  });

  it('handles nested formatting', () => {
    expect(convertHtmlToMarkdown('<p><strong>bold <em>and italic</em></strong></p>')).toBe('**bold *and italic***');
  });

  it('collapses excessive whitespace', () => {
    const html = '<p>A</p><p></p><p></p><p>B</p>';
    const result = convertHtmlToMarkdown(html);
    expect(result).not.toContain('\n\n\n');
  });

  it('handles a realistic Azure DevOps bug description', () => {
    const html = `<div>The following ticket:<br>
<ul><li><a href="https://dev.azure.com/OCC/_workitems/edit/462188">Bug 462188</a>: Legacy Wells have Missing Locations</li></ul>
Does <strong>NOT</strong> appear in the release notes.</div>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain('[Bug 462188](https://dev.azure.com/OCC/_workitems/edit/462188)');
    expect(result).toContain('**NOT**');
    expect(result).toContain('- [Bug 462188](https://dev.azure.com/OCC/_workitems/edit/462188): Legacy Wells have Missing Locations');
  });
});
