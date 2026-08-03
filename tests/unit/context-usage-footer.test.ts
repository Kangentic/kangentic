/**
 * Unit coverage for `ContextUsageFooter`'s `unknownLabel` prop, in isolation
 * from both consumers (TaskCard, MonitorCard). `ContextUsageFooter` is a
 * hookless function component, so - following the established pattern in
 * `panel-error-boundary.test.ts` / `dialog-form-primitives.test.ts` /
 * `activity-mark-render.test.ts` (this project's vitest config has no jsdom
 * environment and no @testing-library/react dependency) - it is called
 * directly as a plain function and its real `React.createElement` output
 * (`{ type, props }`) is walked without a renderer.
 *
 * What this closes: the component itself declares two behaviors in its own
 * JSDoc - (1) omitting `unknownLabel` keeps printing `{percent}%` even when
 * the window is unknown (the board's TaskCard behavior, load-bearing for
 * dnd-kit's per-card ResizeObserver re-measure during drag - see the comment
 * above TaskCard's call site), and (2) `unknownLabel` only replaces the label
 * when `windowKnown` is false (a known window's real percentage must never be
 * swapped for the placeholder). Neither was asserted against the component
 * directly before this file - only indirectly, through MonitorCard
 * (tests/ui/agent-monitor.spec.ts), which passes `unknownLabel="-"` on every
 * case and so cannot prove the omitted-prop default.
 *
 * The call-site question - does TaskCard actually omit `unknownLabel`? - is a
 * different risk (this file passing does not stop a future TaskCard edit from
 * adding the prop) and is covered separately by a case added to
 * tests/ui/task-card-context-window.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { ContextUsageFooter } from '../../src/renderer/components/board/ContextUsageFooter';

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

/** Depth-first search for the first element whose data-testid === testId. */
function findByTestId(node: unknown, testId: string): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    if (node.props['data-testid'] === testId) return node;
    return findByTestId(node.props.children, testId);
  }
  return null;
}

describe('ContextUsageFooter unknownLabel', () => {
  it('keeps printing the percent when unknownLabel is omitted, even with an unknown window (the board default)', () => {
    const output = ContextUsageFooter({
      modelName: 'Opus 5',
      percent: 0,
      windowKnown: false,
      testId: 'usage-bar',
    });
    const percentSpan = findByTestId(output, 'usage-bar-percent');
    if (!percentSpan) throw new Error('expected a usage-bar-percent span in the output');

    expect(collectText(percentSpan)).toBe('0%');
  });

  it('replaces the percent label with unknownLabel when the window is unknown', () => {
    const output = ContextUsageFooter({
      modelName: 'Claude',
      percent: 0,
      windowKnown: false,
      unknownLabel: '-',
      testId: 'usage-bar',
    });
    const percentSpan = findByTestId(output, 'usage-bar-percent');
    if (!percentSpan) throw new Error('expected a usage-bar-percent span in the output');

    expect(collectText(percentSpan)).toBe('-');
  });

  it('ignores unknownLabel when the window IS known, never masking a real percentage', () => {
    const output = ContextUsageFooter({
      modelName: 'Opus 5',
      percent: 62,
      windowKnown: true,
      unknownLabel: '-',
      testId: 'usage-bar',
    });
    const percentSpan = findByTestId(output, 'usage-bar-percent');
    if (!percentSpan) throw new Error('expected a usage-bar-percent span in the output');

    expect(collectText(percentSpan)).toBe('62%');
  });

  it('sets data-context-window to the literal string "unknown" only when windowKnown is false', () => {
    const knownOutput = ContextUsageFooter({ modelName: 'Opus 5', percent: 10, windowKnown: true });
    if (!isElementLike(knownOutput)) throw new Error('ContextUsageFooter did not return an element');
    // Not merely falsy/absent-looking: this is `undefined` in the React prop
    // graph pre-DOM-serialization (same trap activity-mark-render.test.ts
    // documents for `aria-hidden`), so assert the exact value.
    expect(knownOutput.props['data-context-window']).toBeUndefined();

    const unknownOutput = ContextUsageFooter({ modelName: 'Opus 5', percent: 10, windowKnown: false });
    if (!isElementLike(unknownOutput)) throw new Error('ContextUsageFooter did not return an element');
    expect(unknownOutput.props['data-context-window']).toBe('unknown');
  });
});
