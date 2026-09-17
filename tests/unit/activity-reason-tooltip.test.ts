/**
 * Unit tests for src/renderer/components/board/ActivityReasonTooltip.tsx's
 * plain-text formatter. Covers the idle/permission duration enrichment
 * (`reason.since`, epoch ms) and pins that every other reason kind is
 * unaffected. Also covers the `ActivityReasonTooltip` component's `now` prop:
 * the rendered duration is measured against the caller-supplied `now`, not
 * against the wall clock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatActivityReasonText,
  ActivityReasonTooltip,
} from '../../src/renderer/components/board/ActivityReasonTooltip';
import { ActivityMark } from '../../src/renderer/components/ActivityMark';
import type { ActivityReason } from '../../src/shared/types';

afterEach(() => {
  vi.useRealTimers();
});

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'props' in node;
}

/**
 * `ActivityReasonTooltip` renders unrendered (no reconciler in this project's vitest config -
 * see activity-mark-render.test.ts for the established rationale), so the returned element's
 * first child is the raw <ActivityMark mark="..." /> element, not yet invoked. The mark NAME
 * this picks is exactly the branch-selection logic under test, so read it straight off that
 * child's props instead of invoking through to the rendered <svg>'s data-mark (which would
 * only re-prove what activity-mark-render.test.ts already covers for ActivityMark itself).
 */
function markPropOfFirstChild(output: unknown): string {
  if (!isElementLike(output)) throw new Error('ActivityReasonTooltip did not return an element');
  const children = output.props.children;
  const markElement = Array.isArray(children) ? children[0] : children;
  if (!isElementLike(markElement)) {
    throw new Error('expected the first child to be an <ActivityMark /> element');
  }
  expect(markElement.type).toBe(ActivityMark);
  return markElement.props.mark as string;
}

/**
 * Reads the rendered text of `ActivityReasonTooltip`'s second child, the
 * `<span>` that holds the label (icon + duration for idle/permission). JSX
 * interpolation splits a literal-plus-expression body into a children array
 * (e.g. `['Idle for ', '12m 34s']`), so this flattens and joins whatever
 * shape that child's children take before returning the plain string.
 */
function textOfSecondChild(output: unknown): string {
  if (!isElementLike(output)) throw new Error('ActivityReasonTooltip did not return an element');
  const outerChildren = output.props.children;
  if (!Array.isArray(outerChildren) || outerChildren.length < 2) {
    throw new Error('expected at least two children on the outer element');
  }
  const labelElement = outerChildren[1];
  if (!isElementLike(labelElement)) {
    throw new Error('expected the second child to be a <span> element');
  }
  const labelChildren = labelElement.props.children;
  const parts = Array.isArray(labelChildren) ? labelChildren : [labelChildren];
  return parts.join('');
}

describe('ActivityReasonTooltip mark selection', () => {
  it('idle renders the agent-idle mark (matches the TaskCard idle indicator)', () => {
    const now = Date.now();
    const output = ActivityReasonTooltip({ reason: { kind: 'idle', since: now }, now });
    expect(markPropOfFirstChild(output)).toBe('agent-idle');
  });

  it('turn-active renders the agent-working mark (matches the TaskCard thinking indicator)', () => {
    const output = ActivityReasonTooltip({ reason: { kind: 'turn-active' }, now: Date.now() });
    expect(markPropOfFirstChild(output)).toBe('agent-working');
  });
});

describe('formatActivityReasonText', () => {
  it('idle includes elapsed wait time computed from reason.since', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:12:34Z'));
    const since = new Date('2026-07-22T00:00:00Z').getTime();
    expect(formatActivityReasonText({ kind: 'idle', since })).toBe('Idle for 12m 34s');
  });

  it('permission includes elapsed wait time computed from reason.since', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T01:30:00Z'));
    const since = new Date('2026-07-22T00:00:00Z').getTime();
    expect(formatActivityReasonText({ kind: 'permission', since })).toBe('Awaiting permission for 1h 30m');
  });

  it('every other reason kind is unaffected by the since field', () => {
    expect(formatActivityReasonText({ kind: 'tool', pendingCount: 1, currentTool: 'Bash' })).toBe('Running Bash');
    expect(formatActivityReasonText({ kind: 'tool', pendingCount: 2, currentTool: null })).toBe('2 tools in flight');
    expect(formatActivityReasonText({ kind: 'subagent', depth: 1 })).toBe('1 subagent active');
    expect(formatActivityReasonText({ kind: 'background-shell', count: 1, ids: [] })).toBe('1 background shell');
    expect(formatActivityReasonText({ kind: 'turn-active' })).toBe('Thinking');
  });

  it('idle at the very start of a park reads "Idle for 0s", not a blank or negative duration', () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-22T00:00:00Z');
    vi.setSystemTime(now);
    const reason: ActivityReason = { kind: 'idle', since: now.getTime() };
    expect(formatActivityReasonText(reason)).toBe('Idle for 0s');
  });
});

describe('ActivityReasonTooltip duration follows the now prop', () => {
  // Deliberately far from the real wall clock: a component that reverted to
  // reading Date.now() internally would render a duration in the decades,
  // not the minutes/hours asserted below, so the failure is unambiguous.
  const since = new Date('2026-01-01T00:00:00Z').getTime();

  it('idle measures elapsed time against the now prop, not the wall clock', () => {
    const firstOutput = ActivityReasonTooltip({
      reason: { kind: 'idle', since },
      now: since + 12 * 60_000 + 34_000,
    });
    expect(textOfSecondChild(firstOutput)).toBe('Idle for 12m 34s');

    const secondOutput = ActivityReasonTooltip({
      reason: { kind: 'idle', since },
      now: since + 90 * 60_000,
    });
    expect(textOfSecondChild(secondOutput)).toBe('Idle for 1h 30m');
  });

  it('permission measures elapsed time against the now prop, not the wall clock', () => {
    const firstOutput = ActivityReasonTooltip({
      reason: { kind: 'permission', since },
      now: since + 12 * 60_000 + 34_000,
    });
    expect(textOfSecondChild(firstOutput)).toBe('Awaiting permission for 12m 34s');

    const secondOutput = ActivityReasonTooltip({
      reason: { kind: 'permission', since },
      now: since + 90 * 60_000,
    });
    expect(textOfSecondChild(secondOutput)).toBe('Awaiting permission for 1h 30m');
  });
});
