/**
 * How the Changes panel's markdown preview resolves a link or an image path in
 * a repository file: GitHub's rules, relative to the file's own folder.
 */
import { describe, it, expect } from 'vitest';
import { anchorElementIds, resolveMarkdownHref, resolveRepoAssetPath } from '../../src/renderer/utils/markdown-repo-link';

describe('resolveMarkdownHref', () => {
  it('resolves a sibling file against the markdown file at the repo root', () => {
    expect(resolveMarkdownHref('README.de.md', 'README.cs.md')).toEqual({ kind: 'file', path: 'README.de.md', anchor: null });
  });

  it('resolves against the markdown file\'s own folder', () => {
    expect(resolveMarkdownHref('setup.md', 'docs/guide/README.md')).toEqual({ kind: 'file', path: 'docs/guide/setup.md', anchor: null });
    expect(resolveMarkdownHref('./setup.md', 'docs/guide/README.md')).toEqual({ kind: 'file', path: 'docs/guide/setup.md', anchor: null });
  });

  it('resolves `..` itself, since main refuses a path that still carries one', () => {
    expect(resolveMarkdownHref('../../LICENSE', 'docs/guide/README.md')).toEqual({ kind: 'file', path: 'LICENSE', anchor: null });
  });

  it('reads a path starting with / from the repo root', () => {
    expect(resolveMarkdownHref('/docs/index.md', 'docs/guide/README.md')).toEqual({ kind: 'file', path: 'docs/index.md', anchor: null });
  });

  it('refuses a path that climbs above the repo root', () => {
    expect(resolveMarkdownHref('../outside.md', 'README.md')).toEqual({ kind: 'none' });
  });

  it('keeps a file link\'s anchor and drops its query', () => {
    expect(resolveMarkdownHref('setup.md?plain=1#first-run', 'docs/README.md')).toEqual({ kind: 'file', path: 'docs/setup.md', anchor: 'first-run' });
  });

  it('decodes percent-encoded paths and anchors', () => {
    expect(resolveMarkdownHref('my%20notes.md#co-to-d%C4%9Bl%C3%A1', 'README.md')).toEqual({ kind: 'file', path: 'my notes.md', anchor: 'co-to-dělá' });
  });

  it('reads `#section` as an anchor in the same file', () => {
    expect(resolveMarkdownHref('#install', 'docs/README.md')).toEqual({ kind: 'anchor', anchor: 'install' });
  });

  it('hands http, https and mailto to the OS, and nothing else', () => {
    expect(resolveMarkdownHref('https://example.com/x', 'README.md')).toEqual({ kind: 'external', url: 'https://example.com/x' });
    expect(resolveMarkdownHref('mailto:dev@example.com', 'README.md')).toEqual({ kind: 'external', url: 'mailto:dev@example.com' });
    expect(resolveMarkdownHref('//example.com/x', 'README.md')).toEqual({ kind: 'external', url: 'https://example.com/x' });
    expect(resolveMarkdownHref('javascript:alert(1)', 'README.md')).toEqual({ kind: 'none' });
    expect(resolveMarkdownHref('file:///etc/passwd', 'README.md')).toEqual({ kind: 'none' });
    expect(resolveMarkdownHref('C:/Windows/notepad.exe', 'README.md')).toEqual({ kind: 'none' });
  });

  it('treats an empty href as no target', () => {
    expect(resolveMarkdownHref('', 'README.md')).toEqual({ kind: 'none' });
    expect(resolveMarkdownHref(undefined, 'README.md')).toEqual({ kind: 'none' });
  });
});

describe('resolveRepoAssetPath', () => {
  it('resolves a relative image against the markdown file\'s folder', () => {
    expect(resolveRepoAssetPath('images/board.png', 'docs/README.md')).toBe('docs/images/board.png');
    expect(resolveRepoAssetPath('../assets/logo.svg', 'docs/README.md')).toBe('assets/logo.svg');
    expect(resolveRepoAssetPath('/docs/images/x.png?raw=true', 'README.md')).toBe('docs/images/x.png');
  });

  it('returns null for anything that is not a repo file', () => {
    expect(resolveRepoAssetPath('https://example.com/logo.png', 'README.md')).toBeNull();
    expect(resolveRepoAssetPath('data:image/png;base64,AAAA', 'README.md')).toBeNull();
    expect(resolveRepoAssetPath('//example.com/logo.png', 'README.md')).toBeNull();
    expect(resolveRepoAssetPath('../logo.png', 'README.md')).toBeNull();
    expect(resolveRepoAssetPath('', 'README.md')).toBeNull();
  });
});

describe('anchorElementIds', () => {
  it('tries the sanitizer\'s prefixed id first, then the id as written', () => {
    expect(anchorElementIds('install')).toEqual(['user-content-install', 'install']);
  });

  it('also tries a link written in another case lowered, as GitHub slugs are', () => {
    expect(anchorElementIds('Install')).toEqual(['user-content-Install', 'Install', 'user-content-install', 'install']);
  });
});
