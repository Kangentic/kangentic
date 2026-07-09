import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { DiffOnMount, Monaco, MonacoDiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import { Loader2, Columns2, Rows2, FileCode, ChevronUp, ChevronDown, Pilcrow, FoldVertical, Eye, UserRound } from 'lucide-react';
import { MarkdownRenderer } from '../../../MarkdownRenderer';
import { useConfigStore } from '../../../../stores/config-store';
import { useKeybinding } from '../../../../hooks/useKeybinding';
import { formatRelativeTime } from '../../../../lib/datetime';
import { NAMED_THEMES } from '../../../../../shared/types';
import type { GitBlameLine, GitDiffStatus } from '../../../../../shared/types';
import {
  getSavedDiffScroll,
  makeDiffScrollKey,
  resolveDiffScrollAction,
  saveDiffScroll,
} from '../../../../utils/diff-scroll-memory';
import { copyDiffSelection } from '../../../../utils/diff-clipboard';

interface DiffViewerProps {
  original: string;
  modified: string;
  language: string;
  filePath: string;
  /** Path the displayed `original`/`modified` were fetched for, or null before
   *  the first content arrives. When it does not equal `filePath`, the props
   *  belong to a previously selected file (the stale-content switch window). */
  contentFilePath: string | null;
  /** Task-scoped key under which this file's scroll position is remembered. */
  scrollKey: string;
  status: GitDiffStatus;
  viewMode: 'split' | 'inline';
  onViewModeChange: (mode: 'split' | 'inline') => void;
  binary: boolean;
  /** Extra controls rendered at the right edge of the toolbar, after a divider
   *  (e.g. the task-detail expand/collapse buttons). Omitted by the standalone
   *  TaskChangesDialog, which has no panel-layout controls. */
  trailingControls?: ReactNode;
  /** Whether the containing task window is focused (gates the change-nav keys). */
  isFocused?: boolean;
  /** Called when next/prev-change reaches a file boundary, so the panel rolls
   *  into the adjacent file. */
  onCrossFile?: (direction: 'next' | 'prev') => void;
  /** When set, jump to this file's first/last change once its diff loads (used
   *  when the panel just rolled into this file from an adjacent one). */
  pendingChangeFocus?: 'first' | 'last' | null;
  /** Called once the pending change-focus has been applied, so the panel clears it. */
  onPendingChangeFocusConsumed?: () => void;
  /** Worktree directory, used to fetch this file's blame. */
  worktreePath?: string;
  /** Project directory, the fallback base when there is no worktree. */
  projectPath: string;
  /**
   * Whether blame can be shown for the currently displayed diff. Blame always
   * reflects the file's CURRENT (working-tree) content and line numbers, so it
   * only lines up when `modified` is that same current content - true for the
   * Uncommitted detail, false while browsing a historical commit (whose
   * content and line numbers may not match the file's current state).
   * Defaults to true.
   */
  blameEligible?: boolean;
}

const STATUS_LABELS: Record<GitDiffStatus, { label: string; colorClass: string }> = {
  A: { label: 'Added', colorClass: 'text-green-400' },
  M: { label: 'Modified', colorClass: 'text-yellow-400' },
  D: { label: 'Deleted', colorClass: 'text-red-400' },
  R: { label: 'Renamed', colorClass: 'text-blue-400' },
  C: { label: 'Copied', colorClass: 'text-blue-400' },
  U: { label: 'Untracked', colorClass: 'text-green-300' },
};

/** Last scroll position observed while the displayed content matched its file,
 *  tagged with the memory key it belongs to so a fast A->B->C switch never
 *  commits one file's scroll under another file's key. */
interface TrackedScroll {
  key: string;
  scrollTop: number;
  scrollLeft: number;
}

/** Shared styling for the diff toolbar buttons: a clear hover background (matching
 *  the rest of the app) and a brief press effect so a click visibly registers.
 *  `active` renders the pressed/selected state for toggles and the current view mode. */
function toolbarButtonClass(active: boolean): string {
  return `p-1.5 rounded transition active:scale-90 ${
    active
      ? 'bg-surface-raised text-fg'
      : 'text-fg-muted hover:text-fg hover:bg-surface-hover'
  }`;
}

export function DiffViewer({
  original,
  modified,
  language,
  filePath,
  contentFilePath,
  scrollKey,
  status,
  viewMode,
  onViewModeChange,
  binary,
  trailingControls,
  isFocused = false,
  onCrossFile,
  pendingChangeFocus = null,
  onPendingChangeFocusConsumed,
  worktreePath,
  projectPath,
  blameEligible = true,
}: DiffViewerProps) {
  const theme = useConfigStore((state) => state.config.theme);
  const themeBase = NAMED_THEMES.find((namedTheme) => namedTheme.id === theme)?.base ?? 'dark';
  const monacoTheme = themeBase === 'dark' ? 'vs-dark' : 'vs';
  const statusConfig = STATUS_LABELS[status];

  // Markdown files can flip from the Monaco diff to a rendered preview of their
  // NEW content. `language` is the server-derived signal (diff-service maps
  // .md/.mdx/.markdown -> 'markdown'); a binary-flagged file is excluded because
  // it has no renderable text and its content pane shows the binary placeholder,
  // not the preview. The diff shows by default and the toggle resets per file
  // (see below), so every file opens on its diff.
  const isMarkdown = language === 'markdown' && !binary;
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const previewActive = isMarkdown && showMarkdownPreview;

  // Blame gutter: off by default, toggled per file (reset below on file switch).
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<GitBlameLine[] | null>(null);
  const blameDecorationsRef = useRef<MonacoEditorNamespace.IEditorDecorationsCollection | null>(null);
  const blameUnavailable = binary || status === 'D' || !blameEligible;

  // Reset the preview toggle and blame whenever the selected file changes, so
  // each file opens on its diff - like changeIndexRef / pendingRevealRef,
  // which also reset per file. DiffViewer is never re-keyed per file (Monaco
  // stays mounted), so the reset is manual. Adjust state during render
  // (React's supported reset-on-prop-change pattern) rather than in an
  // effect, so switching files never paints a frame of the previous file's
  // preview or blame.
  const previousFilePathRef = useRef(filePath);
  if (previousFilePathRef.current !== filePath) {
    previousFilePathRef.current = filePath;
    setShowMarkdownPreview(false);
    setBlameOn(false);
  }

  // Fetch blame when toggled on. `cancelled` guards against a slow fetch
  // landing after the user switched files or toggled blame off; the effect
  // re-runs (cancelling the previous request) on any of those changes.
  useEffect(() => {
    if (!blameOn || blameUnavailable) {
      setBlame(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.git.blame({ worktreePath, projectPath, filePath })
      .then((result) => {
        if (!cancelled) setBlame(result.lines);
      })
      .catch(() => {
        if (!cancelled) setBlame([]);
      });
    return () => {
      cancelled = true;
    };
  }, [blameOn, blameUnavailable, worktreePath, projectPath, filePath]);

  // Turn blame back off when it becomes unavailable (a binary/deleted file, or
  // browsing a historical commit), so re-entering an eligible file or scope
  // starts from the "off by default" state rather than a stale "on".
  useEffect(() => {
    if (blameUnavailable) setBlameOn(false);
  }, [blameUnavailable]);

  // Diff-rendering preferences are single global config keys (the toolbar
  // toggles and the Layout settings tab read and write the same keys), so the
  // choices stick across every diff, all mount points, and restarts - exactly
  // like the split/inline view mode.
  const ignoreWhitespace = useConfigStore((state) => state.config.diffIgnoreWhitespace);
  const collapseUnchanged = useConfigStore((state) => state.config.diffCollapseUnchanged);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const diffEditorRef = useRef<MonacoDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  // Live diff-rendering options derived from the global config. ignoreTrimWhitespace
  // is a diff-COMPUTATION option, so it applies when the diff loads. The diff
  // algorithm is fixed to 'advanced' (Monaco's modern word-level diff, always on -
  // there is no meaningful on/off toggle for it). hideUnchangedRegions is a
  // VIEW-fold option handled separately (see applyCollapseFold): Monaco only folds
  // on a false->true transition, so passing it as a construction option that
  // @monaco-editor/react re-applies on every render never folds a diff that loads
  // while collapse is already on.
  const diffRenderOptions = {
    ignoreTrimWhitespace: ignoreWhitespace,
    diffAlgorithm: 'advanced' as const,
  };

  const collapseUnchangedRef = useRef(collapseUnchanged);
  collapseUnchangedRef.current = collapseUnchanged;

  // Mirror nav props into refs so the stable navigateChange callback and the
  // once-subscribed onDidUpdateDiff listener always read the latest values.
  const onCrossFileRef = useRef(onCrossFile);
  onCrossFileRef.current = onCrossFile;
  const pendingChangeFocusRef = useRef(pendingChangeFocus);
  pendingChangeFocusRef.current = pendingChangeFocus;
  const onPendingChangeFocusConsumedRef = useRef(onPendingChangeFocusConsumed);
  onPendingChangeFocusConsumedRef.current = onPendingChangeFocusConsumed;

  // Mirror blame state into refs so the once-subscribed onDidUpdateDiff
  // listener (below) always reads the latest values.
  const blameRef = useRef(blame);
  blameRef.current = blame;
  const blameOnRef = useRef(blameOn);
  blameOnRef.current = blameOn;

  // Apply (or clear) the blame gutter as `before`-content decorations on the
  // modified editor: a fixed-width column at the start of each line reading
  // "<shortHash>  <author>", with the full hash/author/date on hover. Re-run
  // on every diff update (a file switch swaps Monaco's model in place) and
  // whenever blame data or the toggle changes.
  const applyBlameDecorations = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    const monacoInstance = monacoRef.current;
    if (diffEditor === null || monacoInstance === null) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const blameLines = blameOnRef.current ? blameRef.current : null;
    if (!blameLines) {
      blameDecorationsRef.current?.clear();
      return;
    }
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0;
    const decorations: MonacoEditorNamespace.IModelDeltaDecoration[] = blameLines
      .filter((line) => line.line >= 1 && line.line <= lineCount)
      .map((line) => ({
        range: new monacoInstance.Range(line.line, 1, line.line, 1),
        options: {
          // Monaco does not render a decoration on a collapsed (zero-width)
          // range unless this is set - and every blame decoration targets a
          // single point (the start of the line), so the range is collapsed.
          showIfCollapsed: true,
          before: {
            content: `${line.shortHash}  ${line.author}`.slice(0, 32),
            inlineClassName: 'blame-gutter-annotation',
          },
          hoverMessage: {
            value: line.date
              ? `\`${line.shortHash}\` ${line.author} · ${formatRelativeTime(line.date)}`
              : `\`${line.shortHash}\` ${line.author}`,
          },
        },
      }));
    if (blameDecorationsRef.current) {
      blameDecorationsRef.current.set(decorations);
    } else {
      blameDecorationsRef.current = modifiedEditor.createDecorationsCollection(decorations);
    }
  }, []);

  useEffect(() => {
    applyBlameDecorations();
  }, [blame, blameOn, applyBlameDecorations]);

  // Apply (or clear) the unchanged-region fold on the live editor. Monaco folds
  // only on a false->true transition of hideUnchangedRegions, so a diff that
  // (re)loads while collapse is already enabled is NOT folded by simply having
  // the option on. Force the transition: disable now, then re-enable on a LATER
  // task (setTimeout, not the same frame) so the editor fully processes the
  // disable before the enable - empirically a same-frame toggle does not fold.
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyCollapseFold = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (diffEditor === null) return;
    if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current);
    // Collapse off: ensure regions are shown.
    if (!collapseUnchangedRef.current) {
      diffEditor.updateOptions({ hideUnchangedRegions: { enabled: false } });
      return;
    }
    // Collapse on. If the diff is ALREADY folded (e.g. a recompute from toggling
    // whitespace preserved the fold), do nothing: re-running the disable->enable
    // transition would visibly unfold then refold the regions - the flash. Only
    // force the transition when NOT folded (a fresh file loaded with the option
    // already on, which Monaco does not fold on its own).
    const modifiedDom = diffEditor.getModifiedEditor().getDomNode();
    const diffRoot = modifiedDom ? modifiedDom.closest('.monaco-diff-editor') : null;
    // Scope the fold-state probe to THIS editor's root. Falling back to a
    // document-wide query would read another co-mounted DiffViewer's fold
    // widgets (two task windows open on Changes), wrongly skipping the fold
    // here. When the root is unknown, treat as not-folded and apply the
    // transition rather than skip it.
    const alreadyFolded = diffRoot ? diffRoot.querySelectorAll('.diff-hidden-lines').length > 0 : false;
    if (alreadyFolded) return;
    diffEditor.updateOptions({ hideUnchangedRegions: { enabled: false } });
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      if (collapseUnchangedRef.current) {
        diffEditorRef.current?.updateOptions({ hideUnchangedRegions: { enabled: true } });
      }
    }, 0);
  }, []);

  // Index of the change region the next/prev navigation last revealed, reset on
  // file change so navigation restarts from the top of each new file.
  const changeIndexRef = useRef(-1);

  // Reveal the change at `index`. Pure-deletion hunks have
  // modifiedStartLineNumber 0; clamp to line 1.
  const revealChangeLine = useCallback((lineNumber: number, smooth: boolean) => {
    const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
    if (!modifiedEditor) return;
    const scrollType = smooth
      ? monacoRef.current?.editor.ScrollType.Smooth
      : monacoRef.current?.editor.ScrollType.Immediate;
    modifiedEditor.revealLineInCenter(Math.max(1, lineNumber), scrollType);
    modifiedEditor.setPosition({ lineNumber: Math.max(1, lineNumber), column: 1 });
  }, []);

  // Reveal the next or previous changed region. At a file's first/last change,
  // roll into the adjacent file via onCrossFile (the panel selects it and asks us
  // to land on its first/last change). changeIndexRef === -1 means "nothing
  // focused yet" (file just opened): next -> first change, prev -> last change.
  const navigateChange = useCallback((direction: 'next' | 'prev') => {
    const diffEditor = diffEditorRef.current;
    const lineChanges = diffEditor?.getLineChanges() ?? null;
    if (diffEditor === null || lineChanges === null || lineChanges.length === 0) {
      onCrossFileRef.current?.(direction); // no diff/changes here: roll on
      return;
    }
    const lastIndex = lineChanges.length - 1;
    const current = changeIndexRef.current;
    let nextIndex: number;
    if (direction === 'next') {
      if (current === -1) nextIndex = 0;
      else if (current >= lastIndex) { onCrossFileRef.current?.('next'); return; }
      else nextIndex = current + 1;
    } else {
      if (current === -1) nextIndex = lastIndex;
      else if (current <= 0) { onCrossFileRef.current?.('prev'); return; }
      else nextIndex = current - 1;
    }
    changeIndexRef.current = nextIndex;
    revealChangeLine(lineChanges[nextIndex].modifiedStartLineNumber, true);
  }, [revealChangeLine]);

  // Jump to this file's first or last change (used when rolling in from an
  // adjacent file). Returns false if the diff has no changes yet.
  const navigateToChange = useCallback((which: 'first' | 'last'): boolean => {
    const lineChanges = diffEditorRef.current?.getLineChanges() ?? null;
    if (!lineChanges || lineChanges.length === 0) return false;
    const index = which === 'first' ? 0 : lineChanges.length - 1;
    changeIndexRef.current = index;
    revealChangeLine(lineChanges[index].modifiedStartLineNumber, false);
    return true;
  }, [revealChangeLine]);

  // Refs assigned during render so the once-subscribed Monaco event handlers
  // always read the current file's values, even for scroll events the child
  // DiffEditor fires synchronously while flushing new model content.
  const scrollMemoryKey = makeDiffScrollKey(scrollKey, filePath);
  const scrollMemoryKeyRef = useRef(scrollMemoryKey);
  scrollMemoryKeyRef.current = scrollMemoryKey;
  const contentMatchesRef = useRef(false);
  contentMatchesRef.current = contentFilePath !== null && contentFilePath === filePath && !binary;

  const lastScrollRef = useRef<TrackedScroll | null>(null);
  // Memory key still awaiting its initial positioning; null once consumed.
  const pendingRevealRef = useRef<string | null>(scrollMemoryKey);

  // Applies the saved-scroll restore or first-change reveal for the pending
  // key, once the editor exists and the displayed content matches the file.
  // `allowRevealFromLineChanges` gates reading getLineChanges(): true only from
  // onDidUpdateDiff / onMount, where the diff result is fresh; a plain effect
  // may see a stale (pre-recompute) result, so it restores saved positions only
  // and leaves first visits armed.
  const consumePendingReveal = useCallback((allowRevealFromLineChanges: boolean) => {
    const diffEditor = diffEditorRef.current;
    const memoryKey = scrollMemoryKeyRef.current;
    if (diffEditor === null) return;
    if (pendingRevealRef.current !== memoryKey) return;
    if (!contentMatchesRef.current) return;

    const saved = getSavedDiffScroll(memoryKey);
    if (saved === undefined && !allowRevealFromLineChanges) return;
    const lineChanges = saved === undefined ? diffEditor.getLineChanges() : null;
    const action = resolveDiffScrollAction(saved, lineChanges);
    // null means the diff is not computed yet: stay armed for the next event.
    if (action === null) return;

    const modifiedEditor = diffEditor.getModifiedEditor();
    pendingRevealRef.current = null;
    if (action.kind === 'restore') {
      modifiedEditor.setScrollTop(action.position.scrollTop);
      modifiedEditor.setScrollLeft(action.position.scrollLeft);
    } else if (action.kind === 'revealLineInCenter') {
      modifiedEditor.revealLineInCenter(action.lineNumber, monacoRef.current?.editor.ScrollType.Immediate);
    } else {
      modifiedEditor.setScrollTop(0);
      modifiedEditor.setScrollLeft(0);
    }
    // Seed the tracked position so leaving without further scrolling still
    // commits the position we just applied.
    lastScrollRef.current = {
      key: memoryKey,
      scrollTop: modifiedEditor.getScrollTop(),
      scrollLeft: modifiedEditor.getScrollLeft(),
    };
  }, []);

  // When the panel rolled into this file from an adjacent one, jump to its
  // first/last change instead of restoring the saved scroll. Returns true once
  // applied (or once abandoned because the file has no changes), so the caller
  // skips the normal saved-scroll reveal.
  const consumePendingChangeFocus = useCallback((): boolean => {
    const focus = pendingChangeFocusRef.current;
    if (!focus) return false;
    if (!contentMatchesRef.current) return false; // wait until this file's content shows
    const positioned = navigateToChange(focus);
    // Clear the request either way: a rolled-into file with no changes must not
    // keep re-triggering on every later diff update.
    pendingChangeFocusRef.current = null;
    onPendingChangeFocusConsumedRef.current?.();
    if (positioned) pendingRevealRef.current = null; // positioned explicitly
    return positioned;
  }, [navigateToChange]);

  const handleEditorMount: DiffOnMount = useCallback((diffEditor, monacoInstance) => {
    diffEditorRef.current = diffEditor;
    monacoRef.current = monacoInstance;
    const modifiedEditor = diffEditor.getModifiedEditor();
    modifiedEditor.onDidScrollChange(() => {
      // Ignore clamp noise: events fired while the displayed content belongs to
      // another file, or before this file has been positioned.
      if (!contentMatchesRef.current) return;
      if (pendingRevealRef.current === scrollMemoryKeyRef.current) return;
      lastScrollRef.current = {
        key: scrollMemoryKeyRef.current,
        scrollTop: modifiedEditor.getScrollTop(),
        scrollLeft: modifiedEditor.getScrollLeft(),
      };
    });
    // Diff recomputes asynchronously; reveal the first change only once it has
    // finished. Known imperfection: two file switches within one sub-second
    // recompute window can consume a reveal against the previous content's line
    // changes (the diff API offers no way to attribute a result to a content
    // version). It self-corrects on revisit.
    diffEditor.onDidUpdateDiff(() => {
      // A cross-file roll-in jumps to the first/last change; otherwise restore
      // the saved scroll / first-change reveal.
      if (!consumePendingChangeFocus()) consumePendingReveal(true);
      // Re-apply the fold for the freshly computed diff (a file switch keeps the
      // editor mounted, so the option never transitions on its own).
      applyCollapseFold();
      // Re-target the blame gutter at the freshly swapped model.
      applyBlameDecorations();
    });
    // The diff may have finished before onMount attached these listeners.
    if (!consumePendingChangeFocus()) consumePendingReveal(true);
    applyCollapseFold();
    applyBlameDecorations();
  }, [consumePendingReveal, consumePendingChangeFocus, applyCollapseFold, applyBlameDecorations]);

  // Arm on entering a file; on leaving, commit the tracked scroll under the
  // outgoing key. One cleanup path covers file switch, panel close, dialog
  // close, and ChangesPanel remount (expand/collapse).
  useEffect(() => {
    pendingRevealRef.current = scrollMemoryKey;
    // Restart next/prev-change navigation from the top of each new file.
    changeIndexRef.current = -1;
    return () => {
      const lastScroll = lastScrollRef.current;
      // Commit only a position tracked for this exact key and only after it was
      // positioned (pending consumed). A file switched away from before its
      // content/positioning arrived stays unvisited.
      if (
        lastScroll !== null &&
        lastScroll.key === scrollMemoryKey &&
        pendingRevealRef.current !== scrollMemoryKey
      ) {
        saveDiffScroll(scrollMemoryKey, {
          scrollTop: lastScroll.scrollTop,
          scrollLeft: lastScroll.scrollLeft,
        });
      }
    };
  }, [scrollMemoryKey]);

  // Fast-path restore: a saved scrollTop does not depend on the diff, so apply
  // it as soon as the displayed content matches instead of waiting a full diff
  // recompute cycle (avoids a visible top-of-file flash on revisit). First
  // visits stay armed until onDidUpdateDiff because getLineChanges() may be
  // stale here.
  useEffect(() => {
    consumePendingReveal(false);
  }, [scrollMemoryKey, contentFilePath, binary, consumePendingReveal]);

  // The binary placeholder and the markdown preview both unmount the child
  // DiffEditor, which disposes the editor before this parent effect runs. Drop
  // the stale ref so nothing (the whitespace/collapse effects below, reachable
  // from the Layout settings tab while previewing) touches a disposed editor;
  // onMount repopulates it on remount.
  useEffect(() => {
    if (binary || previewActive) {
      diffEditorRef.current = null;
      blameDecorationsRef.current = null;
    }
  }, [binary, previewActive]);

  // Leaving the preview mounts a brand-new DiffEditor for the same file. The
  // per-file arm effect above is keyed on scrollMemoryKey, so it does not fire on
  // a preview toggle - without this, the fresh editor would open at Monaco's
  // default top instead of the file's remembered/first-change position. Re-arm the
  // reveal on the true->false transition so onMount restores it, mirroring a file
  // open. (Deliberately not saving the live scroll on the false->true transition:
  // the DiffEditor's disposal fires a clamp-to-zero scroll event, which would
  // poison the saved position.)
  const previousPreviewActiveRef = useRef(previewActive);
  useEffect(() => {
    const wasPreviewActive = previousPreviewActiveRef.current;
    previousPreviewActiveRef.current = previewActive;
    if (wasPreviewActive && !previewActive) {
      pendingRevealRef.current = scrollMemoryKey;
      changeIndexRef.current = -1;
    }
  }, [previewActive, scrollMemoryKey]);

  // Apply whitespace changes to the live editor so a toolbar or settings toggle
  // takes effect immediately, not just on the next file open.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace });
  }, [ignoreWhitespace]);

  // Re-apply the fold whenever collapse is toggled. The diff is already loaded
  // here, so applyCollapseFold's disable -> enable is the transition Monaco honors.
  useEffect(() => {
    applyCollapseFold();
  }, [collapseUnchanged, applyCollapseFold]);

  // Clear any pending fold re-apply on unmount so it never touches a disposed editor.
  useEffect(() => () => {
    if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current);
  }, []);

  // Keyboard navigation: next/prev change, rolling into the adjacent file at a
  // boundary. Gated on the window being focused; capture phase so it beats the
  // embedded terminal. Also gated off while previewing markdown: the diff editor
  // is unmounted then, so there are no line changes to navigate. Bound here
  // because the diff editor owns the line changes.
  useKeybinding('changes.nextChange', () => navigateChange('next'), { capture: true, enabled: isFocused && !previewActive });
  useKeybinding('changes.prevChange', () => navigateChange('prev'), { capture: true, enabled: isFocused && !previewActive });

  // Reliable copy: Monaco's own Ctrl+C routes through the web clipboard, which
  // rejects once the document loses focus. Capture ahead of Monaco (capture
  // phase + default preventDefault) and write via the focus-independent
  // main-process clipboard instead. Scoped to when a diff sub-editor actually
  // holds focus so it never hijacks Ctrl+C elsewhere (e.g. the file filter).
  useKeybinding('changes.copy', () => {
    const diffEditor = diffEditorRef.current;
    if (diffEditor) copyDiffSelection(diffEditor);
  }, {
    capture: true,
    enabled: isFocused && !previewActive,
    when: () => {
      const diffEditor = diffEditorRef.current;
      return !!diffEditor
        && (diffEditor.getModifiedEditor().hasTextFocus() || diffEditor.getOriginalEditor().hasTextFocus());
    },
  });

  // Right-click Copy / Select All: the main process's showTerminalAwareContextMenu
  // shows the native OS Copy/Paste/Select All menu (same as everywhere else in
  // the app - Monaco no longer preempts it now that contextmenu:false is set
  // below). Its Copy and Select All items dispatch 'diff-copy' / 'diff-select-all'
  // CustomEvents when the click lands over a '.monaco-diff-editor' rather than
  // running document.execCommand, which is unreliable for Copy (focus loss) and
  // a no-op for Select All (Monaco's selection model is outside the browser's
  // native document Selection) - mirroring the terminal's 'terminal-copy' /
  // 'terminal-select-all' handling in useTerminal.ts. Scope to THIS instance's
  // container (isInside) so two co-mounted DiffViewers (two task windows open
  // on Changes) don't both react to one right-click.
  useEffect(() => {
    // The click coordinates the main-process context menu forwarded, or null
    // when the event carries no positional detail.
    const pointOf = (event: Event): { x: number; y: number } | null => {
      const { x, y } = (event as CustomEvent).detail || {};
      if (x == null || y == null) return null;
      return { x, y };
    };
    const isInside = (point: { x: number; y: number }): boolean => {
      const el = editorContainerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    };
    // Which sub-editor the user right-clicked in, resolved from the click POINT
    // rather than hasTextFocus(): the native context menu (Menu.popup) steals
    // document focus before this handler runs, so both sub-editors report no
    // text focus and a focus-based check would always fall back to the modified
    // pane (silently mistargeting the original pane in split view). The click
    // point is reliable whether or not focus was restored. Falls back to the
    // modified editor, which is the only pane laid out in inline view.
    const subEditorAtPoint = (
      diffEditor: MonacoDiffEditor,
      point: { x: number; y: number },
    ): MonacoEditorNamespace.ICodeEditor => {
      const originalEditor = diffEditor.getOriginalEditor();
      const originalNode = originalEditor.getDomNode();
      if (originalNode) {
        const rect = originalNode.getBoundingClientRect();
        if (rect.width > 0
          && point.x >= rect.left && point.x <= rect.right
          && point.y >= rect.top && point.y <= rect.bottom) {
          return originalEditor;
        }
      }
      return diffEditor.getModifiedEditor();
    };
    const handleDiffCopy = (event: Event) => {
      const point = pointOf(event);
      if (!point || !isInside(point)) return;
      const diffEditor = diffEditorRef.current;
      if (diffEditor) copyDiffSelection(diffEditor, subEditorAtPoint(diffEditor, point));
    };
    const handleDiffSelectAll = (event: Event) => {
      const point = pointOf(event);
      if (!point || !isInside(point)) return;
      const diffEditor = diffEditorRef.current;
      if (!diffEditor) return;
      const editor = subEditorAtPoint(diffEditor, point);
      const model = editor.getModel();
      if (!model) return;
      editor.focus();
      editor.setSelection(model.getFullModelRange());
    };
    window.addEventListener('diff-copy', handleDiffCopy);
    window.addEventListener('diff-select-all', handleDiffSelectAll);
    return () => {
      window.removeEventListener('diff-copy', handleDiffCopy);
      window.removeEventListener('diff-select-all', handleDiffSelectAll);
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge flex-shrink-0">
        <FileCode size={12} className="text-fg-muted flex-shrink-0" />
        <span className="text-xs text-fg-secondary truncate">{filePath}</span>
        <span className={`text-xs ${statusConfig.colorClass} flex-shrink-0`}>{statusConfig.label}</span>

        <div className="ml-auto flex items-center gap-1">
          {/* Markdown files toggle between the diff and a rendered preview of the
              new content. Only shown for markdown; while previewing, the diff-only
              controls below are hidden since they do not apply to a rendered view. */}
          {isMarkdown && (
            <button
              onClick={() => setShowMarkdownPreview((value) => !value)}
              className={toolbarButtonClass(previewActive)}
              title={previewActive ? 'Show diff' : 'Preview rendered markdown'}
              aria-pressed={previewActive}
              data-testid="diff-markdown-preview"
            >
              <Eye size={16} />
            </button>
          )}

          {!previewActive && (
            <>
              {isMarkdown && <div className="w-px h-4 bg-edge mx-1" aria-hidden="true" />}

              {/* Next / previous change navigation */}
              <button
                onClick={() => navigateChange('prev')}
                className={toolbarButtonClass(false)}
                title="Previous change"
                data-testid="diff-prev-change"
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={() => navigateChange('next')}
                className={toolbarButtonClass(false)}
                title="Next change"
                data-testid="diff-next-change"
              >
                <ChevronDown size={16} />
              </button>

              <div className="w-px h-4 bg-edge mx-1" aria-hidden="true" />

              {/* Diff-rendering toggles (persisted as global Layout settings) */}
              <button
                onClick={() => updateConfig({ diffIgnoreWhitespace: !ignoreWhitespace })}
                className={toolbarButtonClass(ignoreWhitespace)}
                title="Ignore whitespace"
                aria-pressed={ignoreWhitespace}
                data-testid="diff-ignore-whitespace"
              >
                <Pilcrow size={16} />
              </button>
              <button
                onClick={() => updateConfig({ diffCollapseUnchanged: !collapseUnchanged })}
                className={toolbarButtonClass(collapseUnchanged)}
                title="Collapse unchanged regions"
                aria-pressed={collapseUnchanged}
                data-testid="diff-collapse-unchanged"
              >
                <FoldVertical size={16} />
              </button>
              <button
                onClick={() => setBlameOn((value) => !value)}
                disabled={blameUnavailable}
                className={`${toolbarButtonClass(blameOn)} disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted`}
                title={blameUnavailable ? 'Blame unavailable for this file' : 'Toggle blame'}
                aria-pressed={blameOn}
                data-testid="diff-blame-toggle"
              >
                <UserRound size={16} />
              </button>

              <div className="w-px h-4 bg-edge mx-1" aria-hidden="true" />

              <button
                onClick={() => onViewModeChange('split')}
                className={toolbarButtonClass(viewMode === 'split')}
                title="Side by side"
                data-testid="diff-view-split"
              >
                <Columns2 size={16} />
              </button>
              <button
                onClick={() => onViewModeChange('inline')}
                className={toolbarButtonClass(viewMode === 'inline')}
                title="Inline"
                data-testid="diff-view-inline"
              >
                <Rows2 size={16} />
              </button>
            </>
          )}
          {trailingControls && (
            <>
              <div className="w-px h-4 bg-edge mx-1" aria-hidden="true" />
              {trailingControls}
            </>
          )}
        </div>
      </div>

      {/* Editor area - Monaco stays mounted to avoid expensive re-initialization */}
      <div className="flex-1 min-h-0 relative" data-testid="diff-editor-area">
        {binary ? (
          <div className="flex items-center justify-center h-full text-xs text-fg-disabled">
            Binary file - cannot display diff
          </div>
        ) : contentFilePath === null ? (
          // Wait for the first content before mounting Monaco, so the editor is
          // never created with empty placeholder models (whose empty diff would
          // be misread as "no changes" for the first real file).
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        ) : previewActive ? (
          // Rendered markdown preview. A deleted file (status 'D') has no new
          // content, so preview its old content; every other status previews the
          // new content - including a file legitimately emptied in the working
          // tree, which must render blank rather than fall back to the stale old
          // text. Reuses the shared MarkdownRenderer so the preview is theme-aware
          // and routes links through shell.openExternal.
          <div
            data-testid="diff-markdown-preview-content"
            className="h-full overflow-y-auto px-4 py-3"
          >
            <MarkdownRenderer content={status === 'D' ? original : modified} />
          </div>
        ) : (
          // On unmount (panel close, Changes<->Browser switch, file deselect),
          // @monaco-editor/react disposes this DiffEditor's two TextModels
          // before the widget, so a disposal listener throws a BugIndicatingError
          // ("TextModel got disposed before DiffEditorWidget model got reset")
          // and monaco resets its own model. It is benign and does not leak (both
          // models are disposed regardless of order); no stable release fixes
          // the order, and taking over disposal here would only add leak
          // surface. Do not "fix" it by adding keepCurrent*Model + manual
          // disposal. The thrown message is swallowed at monaco's error funnel
          // (monacoConfig.ts wraps errorHandler.unexpectedErrorHandler; pattern
          // list in src/shared/benign-renderer-errors.ts) so it no longer renders
          // red in the console, and the test harness filters the same message.
          // Upstream: https://github.com/suren-atoyan/monaco-react/issues/647
          <div ref={editorContainerRef} className="h-full w-full">
            <DiffEditor
              height="100%"
              language={language}
              original={original}
              modified={modified}
              theme={monacoTheme}
              // Set the theme BEFORE the editor is created. Without this, Monaco
              // creates the editor under its default light theme and only swaps to
              // the prop theme afterwards, painting one white frame. A fade hid
              // that frame; the slide-in reveal does not, so we prevent it here.
              beforeMount={(monacoInstance) => monacoInstance.editor.setTheme(monacoTheme)}
              onMount={handleEditorMount}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: viewMode === 'split',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
                renderWhitespace: 'boundary',
                fontSize: 12,
                lineHeight: 18,
                // Monaco's default context menu also surfaces "Command Palette",
                // which is meaningless on a read-only embedded diff, and its Copy
                // action is unreliable (see copyDiffSelection). Disabling it lets
                // the native contextmenu event through to showTerminalAwareContextMenu.
                contextmenu: false,
                ...diffRenderOptions,
              }}
              loading={
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={20} className="animate-spin text-fg-muted" />
                </div>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
