/**
 * Unit coverage for snapshotDiffViewer
 * (src/renderer/components/dialogs/task-detail/changes/diff-viewer-snapshot.ts),
 * the reader DiffViewer registers with the monaco error funnel for Sentry
 * DESKTOP-19.
 *
 * It runs inside monaco's own catch block, on an editor whose view model just
 * threw, so the load-bearing property is that one failing read is recorded and
 * never costs the rest of the snapshot. The original editor's
 * getVisibleRanges() is the read most likely to throw the same error, and that
 * failure is what names the side that threw. No jsdom here (see
 * panel-error-boundary.test.ts), so the editors are structural fakes.
 */
import { describe, it, expect } from 'vitest';
import {
  snapshotDiffViewer,
  type DiffViewerSnapshotState,
  type SnapshotDiffEditor,
} from '../../src/renderer/components/dialogs/task-detail/changes/diff-viewer-snapshot';

interface FakeSideOptions {
  lineCount: number | null;
  scrollTop: number;
  visibleRanges: () => Array<{ startLineNumber: number; endLineNumber: number }>;
  foldedRegionCount?: number;
  /** False makes `getDomNode().closest(...)` find no `.monaco-diff-editor` root. */
  hasDiffRoot?: boolean;
  /** Collects the selector each DOM probe was called with. */
  recordedSelectors?: { closest: string[]; querySelectorAll: string[] };
}

function fakeSide(options: FakeSideOptions) {
  const diffRoot = {
    querySelectorAll: (selector: string) => {
      options.recordedSelectors?.querySelectorAll.push(selector);
      return { length: options.foldedRegionCount ?? 0 };
    },
  };
  return {
    getModel: () => (options.lineCount === null ? null : { getLineCount: () => options.lineCount }),
    getScrollTop: () => options.scrollTop,
    getScrollHeight: () => 27000,
    getLayoutInfo: () => ({ height: 528 }),
    getVisibleRanges: options.visibleRanges,
    getDomNode: () => ({
      closest: (selector: string) => {
        options.recordedSelectors?.closest.push(selector);
        return options.hasDiffRoot === false ? null : diffRoot;
      },
    }),
  };
}

function fakeDiffEditor(
  original: ReturnType<typeof fakeSide>,
  modified: ReturnType<typeof fakeSide>,
  lineChanges: unknown[] | null = [{}, {}],
) {
  return {
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified,
    getLineChanges: () => lineChanges,
  } as unknown as SnapshotDiffEditor;
}

const STATE: DiffViewerSnapshotState = {
  viewMode: 'split',
  language: 'typescript',
  hideUnchangedRegions: true,
  foldReenablePending: false,
  foldReenableInProgress: true,
  contentMatches: true,
};

describe('snapshotDiffViewer', () => {
  it('records every field as a flat primitive', () => {
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({ lineCount: 1500, scrollTop: 100, visibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }] }),
        fakeSide({
          lineCount: 3000,
          scrollTop: 200,
          foldedRegionCount: 2,
          visibleRanges: () => [
            { startLineNumber: 1, endLineNumber: 5 },
            { startLineNumber: 2900, endLineNumber: 2930 },
          ],
        }),
      ),
      STATE,
    );

    expect(snapshot).toEqual({
      view_mode: 'split',
      language: 'typescript',
      hide_unchanged_regions: true,
      fold_reenable_pending: false,
      fold_reenable_in_progress: true,
      content_matches: true,
      line_change_count: 2,
      folded_region_count: 2,
      original_line_count: 1500,
      original_scroll_top: 100,
      original_scroll_height: 27000,
      original_viewport_height: 528,
      original_visible_ranges: '1-10',
      modified_line_count: 3000,
      modified_scroll_top: 200,
      modified_scroll_height: 27000,
      modified_viewport_height: 528,
      modified_visible_ranges: '1-5,2900-2930',
    });
    for (const value of Object.values(snapshot)) {
      expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
    }
  });

  it('records a read that throws the same error and keeps every other field', () => {
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({
          lineCount: 1500,
          scrollTop: 26982,
          visibleRanges: () => {
            throw new Error('Illegal value for lineNumber');
          },
        }),
        fakeSide({ lineCount: 3000, scrollTop: 26982, visibleRanges: () => [{ startLineNumber: 1480, endLineNumber: 1509 }] }),
      ),
      STATE,
    );

    expect(snapshot.original_visible_ranges).toBe('threw: Illegal value for lineNumber');
    expect(snapshot.original_line_count).toBe(1500);
    expect(snapshot.original_scroll_top).toBe(26982);
    expect(snapshot.modified_visible_ranges).toBe('1480-1509');
  });

  it('reads null line counts when a side has no model', () => {
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({ lineCount: null, scrollTop: 0, visibleRanges: () => [] }),
        fakeSide({ lineCount: null, scrollTop: 0, visibleRanges: () => [] }),
      ),
      STATE,
    );

    expect(snapshot.original_line_count).toBeNull();
    expect(snapshot.modified_line_count).toBeNull();
    expect(snapshot.original_visible_ranges).toBe('');
  });

  it('scopes the folded-region probe to this editor root, not the whole document', () => {
    const recordedSelectors = { closest: [] as string[], querySelectorAll: [] as string[] };
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [] }),
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [], foldedRegionCount: 4, recordedSelectors }),
      ),
      STATE,
    );

    expect(recordedSelectors.closest).toEqual(['.monaco-diff-editor']);
    expect(recordedSelectors.querySelectorAll).toEqual(['.diff-hidden-lines']);
    expect(snapshot.folded_region_count).toBe(4);
  });

  it('reads a null folded-region count when the editor has no diff root', () => {
    const recordedSelectors = { closest: [] as string[], querySelectorAll: [] as string[] };
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [] }),
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [], hasDiffRoot: false, recordedSelectors }),
      ),
      STATE,
    );

    expect(snapshot.folded_region_count).toBeNull();
    // No root was found, so nothing was counted from the document at large.
    expect(recordedSelectors.querySelectorAll).toEqual([]);
  });

  it('reads a null line change count when the diff has not been computed yet', () => {
    const snapshot = snapshotDiffViewer(
      fakeDiffEditor(
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [] }),
        fakeSide({ lineCount: 10, scrollTop: 0, visibleRanges: () => [] }),
        null,
      ),
      STATE,
    );

    expect(snapshot.line_change_count).toBeNull();
  });

  it('records a throwing sub-editor accessor on its own side and keeps every other field', () => {
    const modified = fakeSide({
      lineCount: 3000,
      scrollTop: 26982,
      foldedRegionCount: 3,
      visibleRanges: () => [{ startLineNumber: 1480, endLineNumber: 1509 }],
    });
    const halfDisposedDiffEditor = {
      getOriginalEditor: () => {
        throw new Error('disposed');
      },
      getModifiedEditor: () => modified,
      getLineChanges: () => [{}, {}],
    } as unknown as SnapshotDiffEditor;

    let snapshot: ReturnType<typeof snapshotDiffViewer> | undefined;
    expect(() => {
      snapshot = snapshotDiffViewer(halfDisposedDiffEditor, STATE);
    }).not.toThrow();

    expect(snapshot).toEqual({
      view_mode: 'split',
      language: 'typescript',
      hide_unchanged_regions: true,
      fold_reenable_pending: false,
      fold_reenable_in_progress: true,
      content_matches: true,
      line_change_count: 2,
      folded_region_count: 3,
      original_line_count: 'threw: disposed',
      original_scroll_top: 'threw: disposed',
      original_scroll_height: 'threw: disposed',
      original_viewport_height: 'threw: disposed',
      original_visible_ranges: 'threw: disposed',
      modified_line_count: 3000,
      modified_scroll_top: 26982,
      modified_scroll_height: 27000,
      modified_viewport_height: 528,
      modified_visible_ranges: '1480-1509',
    });
  });
});
