/**
 * Exhaustiveness guard for EVENT_RENDERERS in ActivityLog.tsx.
 *
 * The dispatch table is `Partial<Record<EventType, EventRenderer>>`, which
 * provides no compile-time guarantee that every EventType is either rendered
 * or explicitly excluded. This test enforces that invariant at runtime:
 *
 *   Every value of EventType must either appear as a key in EVENT_RENDERERS
 *   (renderable) or be listed in NON_RENDERABLE_EVENT_TYPES (silently skipped).
 *
 * If someone adds a new EventType to src/shared/types.ts without updating
 * EVENT_RENDERERS or NON_RENDERABLE_EVENT_TYPES, this test fails with a clear
 * message identifying the unhandled type.
 *
 * Imports: only EventType (no React/DOM needed) + the two pure exports.
 * React and all renderer hooks are stubbed via vi.mock so the module loads
 * in the Node/vitest environment without a DOM.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventType } from '../../src/shared/types';

// Stub every renderer-specific import that ActivityLog.tsx pulls in.
// We never call any hooks or render any JSX - the stubs only need to be
// importable. The module-level EVENT_RENDERERS const and isRenderableEventType
// function are pure JavaScript and load fine once hooks are stubbed.
vi.mock('react', () => ({
  default: {},
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => undefined],
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    scrollToIndex: () => undefined,
  }),
}));

vi.mock('../../src/renderer/lib/datetime', () => ({
  formatTime: (ts: number) => String(ts),
}));

vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: () => ({}),
}));

vi.mock('../../src/renderer/components/settings/shared', () => ({
  Select: {},
}));

// NON_RENDERABLE_EVENT_TYPES is the authoritative list of event types that are
// intentionally excluded from the Activity tab. Update this list if new
// non-renderable types are added to EventType.
//
// Current rationale:
//   ToolEnd            - too noisy; tool start already shows the action.
//   BackgroundShellStart - internal plumbing; not meaningful to display.
//   BackgroundShellEnd   - internal plumbing; not meaningful to display.
const NON_RENDERABLE_EVENT_TYPES = new Set<string>([
  EventType.ToolEnd,
  EventType.BackgroundShellStart,
  EventType.BackgroundShellEnd,
]);

// Deferred import so vi.mock calls are hoisted before the import resolves.
let EVENT_RENDERERS: Partial<Record<string, unknown>>;
let isRenderableEventType: (type: string) => boolean;

beforeAll(async () => {
  const module = await import('../../src/renderer/components/terminal/ActivityLog');
  EVENT_RENDERERS = module.EVENT_RENDERERS as Partial<Record<string, unknown>>;
  isRenderableEventType = module.isRenderableEventType;
});

describe('ActivityLog EVENT_RENDERERS exhaustiveness', () => {
  it('every EventType value is either in EVENT_RENDERERS or in the non-renderable set', () => {
    const allEventTypeValues = Object.values(EventType) as string[];
    const unhandled: string[] = [];

    for (const eventTypeValue of allEventTypeValues) {
      const isRenderable = Object.hasOwn(EVENT_RENDERERS, eventTypeValue);
      const isExcluded = NON_RENDERABLE_EVENT_TYPES.has(eventTypeValue);
      if (!isRenderable && !isExcluded) {
        unhandled.push(eventTypeValue);
      }
    }

    expect(unhandled, [
      'These EventType values are neither in EVENT_RENDERERS nor in NON_RENDERABLE_EVENT_TYPES.',
      'Add a renderer to EVENT_RENDERERS in ActivityLog.tsx, or add the type to',
      'NON_RENDERABLE_EVENT_TYPES in this test file with a comment explaining why it is excluded.',
    ].join(' ')).toEqual([]);
  });

  it('EVENT_RENDERERS contains no unknown EventType keys', () => {
    // Catch stale keys - e.g. a type was renamed and the old key orphaned.
    const allEventTypeValues = new Set(Object.values(EventType) as string[]);
    const unknownKeys = Object.keys(EVENT_RENDERERS).filter(
      (key) => !allEventTypeValues.has(key),
    );
    expect(unknownKeys, [
      'EVENT_RENDERERS contains keys that are not valid EventType values.',
      'These are stale entries - remove them from the dispatch table in ActivityLog.tsx.',
    ].join(' ')).toEqual([]);
  });

  it('EVENT_RENDERERS contains exactly the renderable subset (not ToolEnd, BackgroundShellStart, BackgroundShellEnd)', () => {
    const rendererKeys = new Set(Object.keys(EVENT_RENDERERS));

    // Verify the non-renderable types are absent
    for (const excluded of NON_RENDERABLE_EVENT_TYPES) {
      expect(rendererKeys.has(excluded), `${excluded} should not be in EVENT_RENDERERS`).toBe(false);
    }

    // Verify all other types are present
    for (const eventTypeValue of Object.values(EventType) as string[]) {
      if (!NON_RENDERABLE_EVENT_TYPES.has(eventTypeValue)) {
        expect(rendererKeys.has(eventTypeValue), `${eventTypeValue} should be in EVENT_RENDERERS`).toBe(true);
      }
    }
  });
});

describe('isRenderableEventType', () => {
  it('returns true for every key in EVENT_RENDERERS', () => {
    for (const key of Object.keys(EVENT_RENDERERS)) {
      expect(isRenderableEventType(key), `isRenderableEventType('${key}') should be true`).toBe(true);
    }
  });

  it('returns false for ToolEnd', () => {
    expect(isRenderableEventType(EventType.ToolEnd)).toBe(false);
  });

  it('returns false for BackgroundShellStart', () => {
    expect(isRenderableEventType(EventType.BackgroundShellStart)).toBe(false);
  });

  it('returns false for BackgroundShellEnd', () => {
    expect(isRenderableEventType(EventType.BackgroundShellEnd)).toBe(false);
  });

  it('returns false for an unrecognized string', () => {
    expect(isRenderableEventType('not_a_real_event')).toBe(false);
  });
});
