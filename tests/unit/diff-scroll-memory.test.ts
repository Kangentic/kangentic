/**
 * Unit tests for the Changes view diff scroll-memory helpers in
 * src/renderer/utils/diff-scroll-memory.ts.
 *
 * Covers key building, the in-memory save/get round-trip, and the pure
 * `resolveDiffScrollAction` decision matrix. The HMR preservation contract
 * (Pattern A) is enforced separately by tests/unit/hmr-resync.test.ts, which
 * scans for the dispose block; here we verify the runtime behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  makeDiffScrollKey,
  getSavedDiffScroll,
  saveDiffScroll,
  resolveDiffScrollAction,
  clampDiffScrollTop,
} from '../../src/renderer/utils/diff-scroll-memory';

describe('makeDiffScrollKey', () => {
  it('joins the scroll key and file path with a colon', () => {
    expect(makeDiffScrollKey('task-1', 'src/app.ts')).toBe('task-1:src/app.ts');
  });

  it('keeps different files under different keys for the same scroll key', () => {
    expect(makeDiffScrollKey('task-1', 'a.ts')).not.toBe(makeDiffScrollKey('task-1', 'b.ts'));
  });
});

describe('save/get round-trip', () => {
  it('returns undefined for an unvisited key', () => {
    expect(getSavedDiffScroll('never-visited-key')).toBeUndefined();
  });

  it('stores and reads back a saved position', () => {
    const key = makeDiffScrollKey('roundtrip-task', 'file.ts');
    saveDiffScroll(key, { scrollTop: 420, scrollLeft: 12 });
    expect(getSavedDiffScroll(key)).toEqual({ scrollTop: 420, scrollLeft: 12 });
  });

  it('overwrites a prior position for the same key', () => {
    const key = makeDiffScrollKey('overwrite-task', 'file.ts');
    saveDiffScroll(key, { scrollTop: 100, scrollLeft: 0 });
    saveDiffScroll(key, { scrollTop: 250, scrollLeft: 0 });
    expect(getSavedDiffScroll(key)?.scrollTop).toBe(250);
  });
});

describe('resolveDiffScrollAction', () => {
  it('restores a saved position regardless of line changes (revisit wins)', () => {
    const saved = { scrollTop: 300, scrollLeft: 5 };
    expect(resolveDiffScrollAction(saved, [{ modifiedStartLineNumber: 50 }])).toEqual({
      kind: 'restore',
      position: saved,
    });
  });

  it('restores a saved position even when the diff is not yet computed', () => {
    const saved = { scrollTop: 80, scrollLeft: 0 };
    expect(resolveDiffScrollAction(saved, null)).toEqual({ kind: 'restore', position: saved });
  });

  it('stays armed (returns null) when no saved position and the diff is not computed', () => {
    expect(resolveDiffScrollAction(undefined, null)).toBeNull();
  });

  it('reveals the first change centered on a first visit', () => {
    expect(
      resolveDiffScrollAction(undefined, [
        { modifiedStartLineNumber: 87 },
        { modifiedStartLineNumber: 140 },
      ]),
    ).toEqual({ kind: 'revealLineInCenter', lineNumber: 87 });
  });

  it('clamps a pure-deletion first hunk (modifiedStartLineNumber 0) to line 1', () => {
    expect(resolveDiffScrollAction(undefined, [{ modifiedStartLineNumber: 0 }])).toEqual({
      kind: 'revealLineInCenter',
      lineNumber: 1,
    });
  });

  it('scrolls to top when the diff computed but found no changes', () => {
    expect(resolveDiffScrollAction(undefined, [])).toEqual({ kind: 'scrollToTop' });
  });
});

describe('clampDiffScrollTop', () => {
  it('leaves a position the layout can reach untouched', () => {
    expect(clampDiffScrollTop(300, 2000, 500)).toBe(300);
  });

  it('saturates at the bottom when the saved position overshoots a shorter layout', () => {
    // The layout can scroll to 2000 - 500 = 1500; a position saved against a
    // taller layout must land there rather than past the end.
    expect(clampDiffScrollTop(4000, 2000, 500)).toBe(1500);
  });

  it('accepts a position exactly at the bottom', () => {
    expect(clampDiffScrollTop(1500, 2000, 500)).toBe(1500);
  });

  it('returns 0 when the content is shorter than the viewport', () => {
    expect(clampDiffScrollTop(800, 300, 500)).toBe(0);
  });

  it('returns 0 for an unlaid-out editor reporting zero dimensions', () => {
    expect(clampDiffScrollTop(800, 0, 0)).toBe(0);
  });

  it('floors a negative saved position at the top', () => {
    expect(clampDiffScrollTop(-40, 2000, 500)).toBe(0);
  });

  it('degrades to the top when any dimension is not finite', () => {
    expect(clampDiffScrollTop(Number.NaN, 2000, 500)).toBe(0);
    expect(clampDiffScrollTop(800, Number.NaN, 500)).toBe(0);
    expect(clampDiffScrollTop(800, 2000, Number.NaN)).toBe(0);
    expect(clampDiffScrollTop(Number.POSITIVE_INFINITY, 2000, 500)).toBe(0);
  });
});
