/**
 * Unit tests for src/renderer/components/board/ActivityReasonTooltip.tsx's
 * plain-text formatter. Covers the idle/permission duration enrichment
 * (`reason.since`, epoch ms) and pins that every other reason kind is
 * unaffected.
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

describe('ActivityReasonTooltip mark selection', () => {
  it('idle renders the agent-idle mark (matches the TaskCard idle indicator)', () => {
    const output = ActivityReasonTooltip({ reason: { kind: 'idle', since: Date.now() } });
    expect(markPropOfFirstChild(output)).toBe('agent-idle');
  });

  it('turn-active renders the agent-working mark (matches the TaskCard thinking indicator)', () => {
    const output = ActivityReasonTooltip({ reason: { kind: 'turn-active' } });
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
