/**
 * Unit coverage for AttachmentChips render output.
 *
 * The chip strip is pure DOM with no async behavior or refs, so we drive it
 * through `react-dom/server`'s renderToStaticMarkup — no jsdom dependency
 * required and no chance of the test masking render bugs by mocking too
 * aggressively. Click handlers are not exercised here (renderToStaticMarkup
 * does not run effects); their wiring is covered indirectly by the BrowserPane
 * E2E flow which calls clear() and clearPicked() on Send.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentChips } from '../../src/renderer/components/browser/AttachmentChips';
import type { BrowserPickedElement } from '../../src/shared/types';

function noop(): void {
  /* unused in render-only assertions */
}

function makePicked(overrides: Partial<BrowserPickedElement> = {}): BrowserPickedElement {
  return {
    selector: 'main > section > div > button.cta',
    tagName: 'button',
    classes: ['cta'],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    computedStyles: {},
    outerHTML: '<button class="cta">Click</button>',
    ancestors: [],
    ...overrides,
  };
}

function render(
  strokeCount: number,
  pickedElement: BrowserPickedElement | null,
): string {
  return renderToStaticMarkup(
    createElement(AttachmentChips, {
      strokeCount,
      pickedElement,
      onClearStrokes: noop,
      onClearPicked: noop,
    }),
  );
}

describe('AttachmentChips', () => {
  it('renders nothing when nothing is queued', () => {
    expect(render(0, null)).toBe('');
  });

  it('renders the strokes chip with singular and plural copy', () => {
    const single = render(1, null);
    expect(single).toContain('data-testid="chip-strokes"');
    expect(single).toContain('1 stroke');
    expect(single).not.toContain('1 strokes');

    const plural = render(3, null);
    expect(plural).toContain('3 strokes');
  });

  it('renders the picked chip when only an element is queued', () => {
    const html = render(0, makePicked());
    expect(html).toContain('data-testid="chip-picked"');
    expect(html).not.toContain('data-testid="chip-strokes"');
  });

  it('renders both chips together', () => {
    const html = render(2, makePicked());
    expect(html).toContain('data-testid="chip-strokes"');
    expect(html).toContain('data-testid="chip-picked"');
  });

  describe('picked element label preference', () => {
    it('prefers data-testid over id and role', () => {
      const html = render(0, makePicked({
        testId: 'submit-button',
        id: 'main-submit',
        role: 'button',
        accessibleName: 'Submit form',
      }));
      expect(html).toContain('[data-testid=&quot;submit-button&quot;]');
      // Other identifiers should not appear in the visible label.
      expect(html).not.toContain('#main-submit');
    });

    it('uses #id when there is no testId', () => {
      const html = render(0, makePicked({
        id: 'header-cta',
        role: 'button',
        accessibleName: 'Sign up',
      }));
      expect(html).toContain('#header-cta');
    });

    it('uses role + accessible name when neither testId nor id is set', () => {
      const html = render(0, makePicked({
        role: 'button',
        accessibleName: 'Sign up',
      }));
      // Short name (under the 22-char accessible-name truncation cap) keeps
      // the verbatim "role \"name\"" shape.
      expect(html).toContain('button &quot;Sign up&quot;');
    });

    it('truncates accessible names longer than 22 characters', () => {
      const html = render(0, makePicked({
        role: 'button',
        accessibleName: 'Subscribe to newsletter',
      }));
      // 22-char cap leaves 21 chars + ellipsis.
      expect(html).toContain('button &quot;Subscribe to newslett…&quot;');
    });

    it('falls back to selector tail when only a selector exists', () => {
      const html = render(0, makePicked({
        selector: 'body > div.app > main > footer > button.tiny',
      }));
      expect(html).toContain('button.tiny');
    });

    it('truncates long testid labels with an ellipsis', () => {
      const longId = 'a'.repeat(50);
      const html = render(0, makePicked({ testId: longId }));
      // Truncated to max=28 (so the slice keeps 27 chars and adds an ellipsis).
      const expectedHead = 'a'.repeat(27);
      expect(html).toContain(`[data-testid=&quot;${expectedHead}…&quot;]`);
      expect(html).not.toContain(`[data-testid=&quot;${'a'.repeat(28)}`);
    });
  });

  it('exposes the full selector as the picked chip\'s description, not a native title', () => {
    const selector = 'main > section.hero > button.primary';
    const html = render(0, makePicked({ selector }));
    // React HTML-escapes `>` to `&gt;` in attribute values. The chip's Tooltip shows the
    // whole value on hover and gives it to the chip as its accessible description.
    const escaped = selector.replace(/>/g, '&gt;');
    expect(html).toContain(`aria-description="${escaped}"`);
    expect(html).not.toContain('title=');
  });
});
