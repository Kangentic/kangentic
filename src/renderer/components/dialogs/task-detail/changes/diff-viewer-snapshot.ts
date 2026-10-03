import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import type { DiffViewerSnapshot } from '../../../../monaco-error-funnel';

/** The parts of a monaco sub-editor the snapshot reads. */
type SnapshotSubEditor = Pick<
  MonacoEditorNamespace.ICodeEditor,
  'getModel' | 'getScrollTop' | 'getScrollHeight' | 'getLayoutInfo' | 'getVisibleRanges' | 'getDomNode'
>;

/** The parts of a monaco diff editor the snapshot reads. */
export interface SnapshotDiffEditor {
  getOriginalEditor(): SnapshotSubEditor;
  getModifiedEditor(): SnapshotSubEditor;
  getLineChanges(): MonacoEditorNamespace.ILineChange[] | null;
}

/** App-side state DiffViewer holds in refs, read at the moment of the throw. */
export interface DiffViewerSnapshotState {
  viewMode: 'split' | 'inline';
  language: string;
  hideUnchangedRegions: boolean;
  /** DiffViewer's disable-then-enable fold timer is armed (applyCollapseFold). */
  foldReenablePending: boolean;
  /** That timer's enable call is running right now, which is when the throw is inside it. */
  foldReenableInProgress: boolean;
  contentMatches: boolean;
}

/**
 * Read one value, recording a failure instead of throwing. This runs inside
 * monaco's own catch block on an editor whose view model just threw, so any
 * read can throw the same error again, and the failure is itself the signal.
 * `getVisibleRanges()` throwing on one side names the side that threw.
 */
function readSafely(read: () => string | number | boolean | null): string | number | boolean | null {
  try {
    return read();
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function formatRanges(ranges: Array<{ startLineNumber: number; endLineNumber: number }>): string {
  return ranges.map((range) => `${range.startLineNumber}-${range.endLineNumber}`).join(',');
}

// Takes a getter rather than the sub-editor itself so a throw from the
// accessor (a half-disposed diff editor) lands in each field, not the caller.
function snapshotSide(prefix: 'original' | 'modified', getSubEditor: () => SnapshotSubEditor, snapshot: DiffViewerSnapshot): void {
  snapshot[`${prefix}_line_count`] = readSafely(() => getSubEditor().getModel()?.getLineCount() ?? null);
  snapshot[`${prefix}_scroll_top`] = readSafely(() => getSubEditor().getScrollTop());
  snapshot[`${prefix}_scroll_height`] = readSafely(() => getSubEditor().getScrollHeight());
  snapshot[`${prefix}_viewport_height`] = readSafely(() => getSubEditor().getLayoutInfo().height);
  snapshot[`${prefix}_visible_ranges`] = readSafely(() => formatRanges(getSubEditor().getVisibleRanges()));
}

/**
 * The live state of one DiffViewer for the monaco error funnel
 * (src/renderer/monaco-error-funnel.ts), as a flat record. It carries counts,
 * scroll metrics and line ranges only: no file path and no file content.
 */
export function snapshotDiffViewer(diffEditor: SnapshotDiffEditor, state: DiffViewerSnapshotState): DiffViewerSnapshot {
  const snapshot: DiffViewerSnapshot = {
    view_mode: state.viewMode,
    language: state.language,
    hide_unchanged_regions: state.hideUnchangedRegions,
    fold_reenable_pending: state.foldReenablePending,
    fold_reenable_in_progress: state.foldReenableInProgress,
    content_matches: state.contentMatches,
  };
  snapshot.line_change_count = readSafely(() => diffEditor.getLineChanges()?.length ?? null);
  // The same probe applyCollapseFold uses, scoped to THIS editor's root so a
  // co-mounted viewer's fold widgets are not counted.
  snapshot.folded_region_count = readSafely(() => {
    const diffRoot = diffEditor.getModifiedEditor().getDomNode()?.closest('.monaco-diff-editor') ?? null;
    return diffRoot ? diffRoot.querySelectorAll('.diff-hidden-lines').length : null;
  });
  snapshotSide('original', () => diffEditor.getOriginalEditor(), snapshot);
  snapshotSide('modified', () => diffEditor.getModifiedEditor(), snapshot);
  return snapshot;
}
