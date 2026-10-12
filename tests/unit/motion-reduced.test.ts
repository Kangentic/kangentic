/**
 * Unit tests for `motionReduced()`, the one answer to "is motion off right now"
 * that KanbanBoard's card fly, the workflow canvas and links overlay, and the
 * Knowledge Graph scene all read at the moment a motion would start.
 *
 * The helper has four answers, in this order:
 *   1. no `document` at all (a unit test of a scene module): motion is off
 *   2. `.no-motion` on `<html>` (Settings > Performance > Animations): off
 *   3. no `window.matchMedia`, and no class: motion is on
 *   4. `matchMedia('(prefers-reduced-motion: reduce)')` matching: off
 *
 * The unit tier runs in node, so the globals the helper reads are stubbed and
 * restored in afterEach. `window` has to be stubbed for the cases that get past
 * the document check: in node a bare `window` is a ReferenceError, not undefined.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { motionReduced } from '../../src/renderer/utils/motion-reduced';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A document whose `<html>` element carries exactly these classes. */
function stubDocumentWithRootClasses(rootClassNames: string[]): void {
  const classNames = new Set(rootClassNames);
  vi.stubGlobal('document', {
    documentElement: {
      classList: { contains: (className: string) => classNames.has(className) },
    },
  });
}

/** A window whose `matchMedia` answers `matches` for any query, and records the queries. */
function stubWindowWithMatchMedia(matches: boolean) {
  const matchMedia = vi.fn((_query: string) => ({ matches }));
  vi.stubGlobal('window', { matchMedia });
  return matchMedia;
}

describe('motionReduced', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports motion off when there is no document', () => {
    vi.stubGlobal('document', undefined);
    // Even a window that would say "motion is fine" cannot override a missing document.
    stubWindowWithMatchMedia(false);

    expect(motionReduced()).toBe(true);
  });

  it('reports motion off when the root element carries the no-motion class', () => {
    stubDocumentWithRootClasses(['dark', 'no-motion']);
    // The system says motion is fine, so only the class can make this true.
    const matchMedia = stubWindowWithMatchMedia(false);

    expect(motionReduced()).toBe(true);
    // The class decides on its own, without consulting the system preference.
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it('reports motion on when matchMedia is missing and the root element has no no-motion class', () => {
    stubDocumentWithRootClasses(['dark']);
    vi.stubGlobal('window', {});

    expect(motionReduced()).toBe(false);
  });

  it('reports motion off when the system asks for reduced motion', () => {
    stubDocumentWithRootClasses([]);
    const matchMedia = stubWindowWithMatchMedia(true);

    expect(motionReduced()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
  });

  it('reports motion on when the system does not ask for reduced motion', () => {
    stubDocumentWithRootClasses([]);
    const matchMedia = stubWindowWithMatchMedia(false);

    expect(motionReduced()).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
  });
});
