/**
 * Pairs `DescriptionEditor`'s `markdown-on-control` class with the CSS rule
 * that consumes it. The two are wired together only by a bare string
 * ("markdown-on-control") shared across two unrelated files, so neither side
 * proves the pairing on its own: dropping the class from the preview div still
 * compiles and still passes `tests/unit/theme-contrast.test.ts` (which checks
 * token *values*, not which class applies which token), and so does deleting
 * or renaming the CSS selector.
 *
 * Without the class, the preview's rendered markdown falls back to the base
 * `.markdown-body` rule (`fg-muted`), which reads under WCAG AA against
 * `surface-control` in every theme (see the comment above the CSS rule and
 * `theme-contrast.test.ts`'s MUST_READ 'control value' entry for the same
 * pairing at `fg-tertiary`, which does clear AA). This test is the only thing
 * that would catch either half of the pairing silently breaking.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DESCRIPTION_EDITOR_PATH = path.join(REPO_ROOT, 'src/renderer/components/DescriptionEditor.tsx');
const INDEX_CSS_PATH = path.join(REPO_ROOT, 'src/renderer/index.css');
const MARKDOWN_RENDERER_PATH = path.join(REPO_ROOT, 'src/renderer/components/MarkdownRenderer.tsx');

describe('DescriptionEditor preview pane <-> .markdown-on-control CSS pairing', () => {
  it('applies markdown-on-control to the preview pane alongside bg-surface-control', () => {
    const source = fs.readFileSync(DESCRIPTION_EDITOR_PATH, 'utf-8');
    const match = source.match(/<div\s+className="([^"]*)"\s+data-testid="description-preview"/);
    expect(match, 'could not find the description-preview div in DescriptionEditor.tsx').not.toBeNull();

    const classNames = (match?.[1] ?? '').split(/\s+/).filter(Boolean);
    expect(classNames).toContain('markdown-on-control');
    // The class is meaningless without the fill it steps the text up against;
    // guard the pairing, not just the class's bare presence.
    expect(classNames).toContain('bg-surface-control');
  });

  it('index.css steps .markdown-on-control .markdown-body up to fg-tertiary', () => {
    const css = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');
    const normalized = css.replace(/\s+/g, ' ');
    expect(normalized).toContain('.markdown-on-control .markdown-body { color: var(--kng-fg-tertiary); }');
  });

  it('the un-scoped .markdown-body rule this override steps up from is still fg-muted', () => {
    // Anchors the "steps up FROM" half of the pairing: if the base rule ever
    // changed to something already AA-safe on surface-control, the override
    // (and this whole test) would no longer be guarding a real regression.
    const css = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');
    const normalized = css.replace(/\s+/g, ' ');
    expect(normalized).toContain('.markdown-body { color: var(--kng-fg-muted);');
  });

  it('MarkdownRenderer still renders its content inside a .markdown-body element', () => {
    // The CSS rule is a DESCENDANT selector (`.markdown-on-control
    // .markdown-body`), so the pairing also depends on MarkdownRenderer
    // actually emitting `.markdown-body` under the preview div. Without this,
    // the two assertions above could both stay green while the descendant
    // selector matches nothing and the preview silently falls back to
    // unstyled/inherited text color.
    const source = fs.readFileSync(MARKDOWN_RENDERER_PATH, 'utf-8');
    expect(source).toContain('className={`markdown-body');
  });
});
