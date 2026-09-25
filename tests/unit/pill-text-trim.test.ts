/**
 * Unit coverage for `Pill`'s `trimTextChildren`, which wraps a bare text child
 * in a cap-height-trimmed span (`[text-box:trim-both_cap_alphabetic]`) so a
 * pill's `items-center` centers the ink rather than the font's content area.
 *
 * The behavior worth pinning is the merging rule, per the header comment on
 * `trimTextChildren` in Pill.tsx: CONSECUTIVE text runs (e.g. `{count} items`,
 * which JSX compiles to two children, a number and a string literal) must
 * collapse into exactly ONE span. Two spans would be two flex items with the
 * pill's `gap` wedged between the count and its noun. Whitespace-only runs
 * pass through unwrapped (a flex container drops them anyway), and element
 * children are left untouched.
 *
 * `Pill` itself is `React.memo(React.forwardRef(function Pill(props, ref) {
 * ... }))` and has no hooks in its body, so - following the
 * `dialog-form-primitives.test.ts` / `panel-error-boundary.test.ts` pattern
 * (this project's vitest config has no jsdom and no @testing-library/react) -
 * the real render function is reached through `.type.render` and called
 * directly as a plain function. `React.createElement`'s output (`{ type,
 * props }`) is then walked without a renderer. This exercises the actual
 * `trimTextChildren` implementation, not a hand-rolled mirror of its logic.
 *
 * `React.Children.toArray` (called once, over the whole children array, at
 * the top of `trimTextChildren`) clones every child to assign it a fresh key
 * - including element children - so an identity assertion against the
 * original element object would fail for a reason unrelated to the behavior
 * under test. Assertions below check `type` and carried-over props instead.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Pill } from '../../src/renderer/components/Pill';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isElementLike(node)) return collectText(node.props.children);
  return '';
}

type PillRenderProps = { children?: React.ReactNode };

/** Reaches the real render function through memo(forwardRef)'s wrapper shape. */
const renderPill = (Pill as unknown as {
  type: { render: (props: PillRenderProps, ref: null) => ElementLike };
}).type.render;

/** `React.createElement`'s children arg collapses to a single value, so this
 * is the exact array `trimTextChildren` returned. */
function childrenOf(output: ElementLike): unknown[] {
  const children = output.props.children;
  return Array.isArray(children) ? children : [children];
}

describe('Pill trimTextChildren', () => {
  it('merges consecutive text runs ({count} items) into exactly one trimmed span', () => {
    // JSX `{count} items` compiles to two children: a number and a string
    // literal. If this regressed to wrapping each child individually, the
    // pill's `gap` would render a visible space between "3" and "items".
    const output = renderPill({ children: [3, ' items'] }, null);
    const children = childrenOf(output);

    expect(children).toHaveLength(1);
    const [span] = children;
    expect(isElementLike(span)).toBe(true);
    expect(collectText(span)).toBe('3 items');
    expect(typeof (span as ElementLike).props.className).toBe('string');
    expect((span as ElementLike).props.className as string).toContain('text-box:trim-both');
  });

  it('wraps a single text child the same way', () => {
    const output = renderPill({ children: 'Label' }, null);
    const children = childrenOf(output);

    expect(children).toHaveLength(1);
    expect(isElementLike(children[0])).toBe(true);
    expect(collectText(children[0])).toBe('Label');
  });

  it('passes a whitespace-only run through unwrapped', () => {
    const output = renderPill({ children: ['  '] }, null);
    const children = childrenOf(output);

    expect(children).toHaveLength(1);
    // Not trimmed into a span - a flex container drops a bare whitespace
    // string on its own, so wrapping it would be pointless work.
    expect(isElementLike(children[0])).toBe(false);
    expect(children[0]).toBe('  ');
  });

  it('leaves an element child untouched and still wraps an adjacent text run into its own span', () => {
    const icon = React.createElement('svg', { 'data-testid': 'icon' });
    const output = renderPill({ children: [icon, 'Label'] }, null);
    const children = childrenOf(output);

    expect(children).toHaveLength(2);

    // The element survives as an element (React.Children.toArray re-keys it,
    // so check shape rather than reference identity).
    const [first, second] = children;
    expect(isElementLike(first)).toBe(true);
    expect((first as ElementLike).type).toBe('svg');
    expect((first as ElementLike).props['data-testid']).toBe('icon');

    // The text run next to it still gets its own trimmed span.
    expect(isElementLike(second)).toBe(true);
    expect(collectText(second)).toBe('Label');
    expect((second as ElementLike).props.className as string).toContain('text-box:trim-both');
  });

  it('does not merge text runs that are separated by an element child', () => {
    const icon = React.createElement('svg');
    const output = renderPill({ children: ['Before', icon, 'After'] }, null);
    const children = childrenOf(output);

    // Two spans (one per side of the element), not one merged run.
    expect(children).toHaveLength(3);
    expect(collectText(children[0])).toBe('Before');
    expect((children[1] as ElementLike).type).toBe('svg');
    expect(collectText(children[2])).toBe('After');
  });
});
