import '../../../../monacoConfig';
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronsLeftRight, ChevronsRightLeft, GitBranch, Loader2, ArrowLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { DetachableSurfaceHeader } from '../../../../pop-out/DetachableSurfaceHeader';
import { FileTreePanel } from './FileTreePanel';
import { DiffViewer } from './DiffViewer';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { CommitGraphPanel } from '../graph/CommitGraphPanel';
import { useSessionStore } from '../../../../stores/session-store';
import { useConfigStore } from '../../../../stores/config-store';
import { useKeybinding } from '../../../../hooks/useKeybinding';
import { formatRelativeTime } from '../../../../lib/datetime';
import type { GitBranchSummaryResult, GitCommitGraphCommit, GitDiffFileEntry, GitDiffFilesResult, GitDiffScope, GitFileContentResult, GitFileHistoryCommit, Task } from '../../../../../shared/types';

// Stable empty set so a task with no viewed files keeps a referentially-constant
// prop (avoids re-rendering the file tree every render).
// hmr-safe: never mutated; a referential-identity sentinel for "no viewed files".
const EMPTY_VIEWED_FILES = new Set<string>();

// File-tree width constraints (px) for the Changes panel two-pane layout.
const FILE_TREE_DEFAULT_WIDTH = 220;          // width before an auto-fit measurement; also the auto-fit floor
const FILE_TREE_AUTO_FIT_MAX = 420;           // ceiling so the tree never crowds the diff
const FILE_TREE_AUTO_FIT_DIFF_RESERVE = 280;  // space kept for the diff pane when auto-fitting
const FILE_TREE_DRAG_MIN = 160;               // minimum tree width while dragging the divider
const DIFF_PANE_DRAG_MIN = 240;               // minimum diff-pane width while dragging the divider
const BRANCH_NAME_FIT_PADDING = 100;          // room beside the branch name (git icon, ahead/behind badges)
const LAST_COMMIT_FIT_PADDING = 28;           // room beside the last-commit line

// Vertical-split constraints (px) between the commit-history region (top) and
// the detail pane (bottom).
const HISTORY_DEFAULT_HEIGHT = 200;
const HISTORY_DRAG_MIN = 88;
const DETAIL_REGION_DRAG_MIN = 160;

interface ChangesPanelProps {
  entityId: string;
  /** Whether the containing task window is focused (gates keyboard navigation
   *  so only the focused window's Changes panel reacts). */
  isFocused?: boolean;
  /**
   * Key under which diff scroll positions are remembered. Defaults to
   * `entityId`. The task-detail panel and the standalone TaskChangesDialog pass
   * the same `task.id` here so scroll memory is shared between them even though
   * their `entityId`s differ.
   */
  scrollKey?: string;
  projectPath: string;
  worktreePath?: string;
  baseBranch: string;
  /** When set, shown instead of the two-pane layout if the branch has zero changed files. */
  emptyMessage?: string;
  /** Current panel layout mode (task-detail only - distinct from the internal
   *  DiffViewer split/inline `viewMode` state below). When provided along with
   *  a handler, the panel renders an expand-or-collapse control in the diff
   *  toolbar (and a fallback row when no diff is mounted). */
  panelMode?: 'split' | 'expanded';
  onExpand?: () => void;
  onCollapse?: () => void;
  /** When provided, the panel shows the commit-history browser (a pinned
   *  "Uncommitted changes" row plus the commit graph) above the detail pane.
   *  The task supplies the graph's PR marker (pr_number / head_sha). Omitted
   *  for the command-terminal Changes embed, which stays Uncommitted-only. */
  task?: Task;
  /** When set (task-detail embed only), the panel toolbar shows a pop-out
   *  control that detaches this Changes view into its own OS window. Omitted by
   *  the standalone dialog, the command-terminal embed, and the pop-out root
   *  itself (which must not offer to detach again). */
  popOutParams?: { taskId: string; projectId: string };
}

interface ContentCacheEntry {
  result: GitFileContentResult;
  generation: number;
}

/** Displayed file content paired with the path it was fetched for. The path
 *  lets the DiffViewer tell whether the original/modified props it received
 *  actually belong to its `filePath` prop (the stale-content window that opens
 *  between a file switch and the new content's fetch resolving). */
interface DisplayedFileContent {
  result: GitFileContentResult;
  filePath: string;
}

export function ChangesPanel({ entityId, isFocused = false, scrollKey, projectPath, worktreePath, baseBranch, emptyMessage, panelMode, onExpand, onCollapse, task, popOutParams }: ChangesPanelProps) {
  const effectiveScrollKey = scrollKey ?? entityId;
  // Expand-full is a PANEL-level action (it acts on the whole Changes surface, not
  // the current diff), so it lives in the shared surface header alongside the
  // pop-out control - NOT in the diff toolbar with the diff/git tools. The
  // task-detail embed passes panelMode + a handler; the standalone dialog and the
  // command-terminal embed pass neither, so it shows only in the embed. Expand and
  // collapse are mutually exclusive: only one is relevant per mode.
  const expandCollapseControl =
    panelMode === 'split' && onExpand ? (
      <button
        onClick={onExpand}
        title="Expand changes"
        className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
        data-testid="changes-expand"
      >
        <ChevronsLeftRight size={16} />
      </button>
    ) : panelMode === 'expanded' && onCollapse ? (
      <button
        onClick={onCollapse}
        title="Collapse to split view"
        className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
        data-testid="changes-collapse"
      >
        <ChevronsRightLeft size={16} />
      </button>
    ) : null;
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const selectedFile = useSessionStore((state) => state.changesSelectedFile[entityId] ?? null);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);
  const setSelectedFile = useCallback((filePath: string | null) => setChangesSelectedFile(entityId, filePath), [entityId, setChangesSelectedFile]);
  // Selected commit in the history browser. null (the default) means
  // "Uncommitted changes" - the branch-wide working diff. Only offered when a
  // `task` is provided (the history browser needs the graph's PR marker); the
  // command-terminal embed stays Uncommitted-only (no history region rendered).
  const changesSelectedCommit = useSessionStore((state) => state.changesSelectedCommit[entityId] ?? null);
  const setChangesSelectedCommitStore = useSessionStore((state) => state.setChangesSelectedCommit);
  // Metadata (subject/author/time) for the selected commit, set on click. On a
  // restored (persisted) selection this starts null - the commit-detail header
  // falls back to the short hash alone until the user re-clicks the row.
  const [selectedCommitMeta, setSelectedCommitMeta] = useState<GitCommitGraphCommit | null>(null);
  const handleSelectCommit = useCallback((commit: GitCommitGraphCommit) => {
    setSelectedCommitMeta(commit);
    setChangesSelectedCommitStore(entityId, commit.hash);
  }, [entityId, setChangesSelectedCommitStore]);
  const handleSelectUncommitted = useCallback(() => {
    setChangesSelectedCommitStore(entityId, null);
  }, [entityId, setChangesSelectedCommitStore]);
  // A per-file history popover row jumps straight to that file's diff at that
  // commit. `parents` is unused by the commit-detail header, so a per-file
  // history commit (which has no parent data) fills it empty.
  const handleSelectHistoryCommit = useCallback((filePath: string, commit: GitFileHistoryCommit) => {
    setSelectedCommitMeta({ ...commit, parents: [] });
    setChangesSelectedCommitStore(entityId, commit.hash);
    setSelectedFile(filePath);
  }, [entityId, setChangesSelectedCommitStore, setSelectedFile]);
  const [fileContent, setFileContent] = useState<DisplayedFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [branchSummary, setBranchSummary] = useState<GitBranchSummaryResult | null>(null);
  // File count for the "Uncommitted changes" row badge, fetched independently of
  // the current selection (scope-based, never commitOid) so the count stays live
  // while the user is browsing a commit's detail.
  const [uncommittedFileCount, setUncommittedFileCount] = useState(0);
  // Split-vs-inline diff rendering is a single global preference: the in-diff
  // toggle and the Layout settings tab read and write the same config key, so
  // the choice sticks across every diff, all mount points, and restarts.
  const viewMode = useConfigStore((state) => state.config.diffViewMode);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  // Diff scope (working / staged / branch). Live selection is per-task panel
  // state; config holds only the default a freshly opened panel starts from.
  const diffDefaultScope = useConfigStore((state) => state.config.diffDefaultScope);
  const scopeForTask = useSessionStore((state) => state.changesScope[entityId]);
  const setChangesScope = useSessionStore((state) => state.setChangesScope);
  const scope = scopeForTask ?? diffDefaultScope;
  const handleScopeChange = useCallback((nextScope: GitDiffScope) => {
    setChangesScope(entityId, nextScope);
  }, [entityId, setChangesScope]);

  // Per-file "viewed" marks (per task, session-scoped).
  const viewedFiles = useSessionStore((state) => state.changesViewedFiles[entityId] ?? EMPTY_VIEWED_FILES);
  const toggleChangesFileViewed = useSessionStore((state) => state.toggleChangesFileViewed);
  const handleToggleViewed = useCallback((filePath: string) => {
    toggleChangesFileViewed(entityId, filePath);
  }, [entityId, toggleChangesFileViewed]);

  // Refs for values needed inside callbacks to avoid stale closures
  // and subscription churn on every file selection or re-render.
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const filesRef = useRef(files);
  filesRef.current = files;

  // Stale-while-revalidate content cache. Each entry stores the fetch result
  // and the generation it was fetched in. When fs.watch fires, the generation
  // increments - stale entries are served immediately while a background
  // refetch runs, so content updates without any loading indicators.
  const contentCacheRef = useRef(new Map<string, ContentCacheEntry>());
  const cacheGenerationRef = useRef(0);

  // Tracks whether the initial file list fetch has completed, used to gate
  // the restore effect and suppress error display during live updates.
  const initialFetchDoneRef = useRef(false);

  const fetchFiles = useCallback(async () => {
    try {
      if (!initialFetchDoneRef.current) {
        setError(null);
      }
      const result: GitDiffFilesResult = await window.electronAPI.git.diffFiles({
        worktreePath,
        projectPath,
        baseBranch,
        scope,
        commitOid: changesSelectedCommit ?? undefined,
      });
      setFiles(result.files);
      setTotalInsertions(result.totalInsertions);
      setTotalDeletions(result.totalDeletions);
      initialFetchDoneRef.current = true;
      setLoaded(true);
    } catch (fetchError) {
      // Only show errors on initial load - transient failures during live
      // updates (e.g. git lock contention) are silently ignored.
      if (!initialFetchDoneRef.current) {
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load diff');
      }
    }
  }, [worktreePath, projectPath, baseBranch, scope, changesSelectedCommit]);

  const fetchFileContent = useCallback(async (filePath: string) => {
    // Key the cache by selection (commit OID or scope) so a file's diffs never
    // bleed across a scope switch or a different commit selection.
    const cacheKey = changesSelectedCommit ? `commit:${changesSelectedCommit}:${filePath}` : `scope:${scope}:${filePath}`;
    const cached = contentCacheRef.current.get(cacheKey);
    if (cached) {
      // Always serve cached content immediately (stale-while-revalidate)
      setFileContent({ result: cached.result, filePath });
      if (cached.generation === cacheGenerationRef.current) {
        return; // Fresh entry - no refetch needed
      }
      // Stale entry - show cached content now, refetch in background
      const currentGeneration = cacheGenerationRef.current;
      const fileEntry = filesRef.current.find((entry) => entry.path === filePath);
      window.electronAPI.git.fileContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: fileEntry?.status ?? 'M',
        oldPath: fileEntry?.oldPath,
        scope,
        commitOid: changesSelectedCommit ?? undefined,
      }).then((freshResult) => {
        contentCacheRef.current.set(cacheKey, { result: freshResult, generation: currentGeneration });
        // Only update UI if this file is still selected and content actually changed
        if (selectedFileRef.current === filePath &&
            (freshResult.original !== cached.result.original || freshResult.modified !== cached.result.modified)) {
          setFileContent({ result: freshResult, filePath });
        }
      }).catch(() => {
        // Background refetch failed - stale content remains visible
      });
      return;
    }

    const searchList = filesRef.current;
    const file = searchList.find((entry) => entry.path === filePath);
    if (!file) return;

    try {
      const result = await window.electronAPI.git.fileContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: file.status,
        oldPath: file.oldPath,
        scope,
        commitOid: changesSelectedCommit ?? undefined,
      });
      contentCacheRef.current.set(cacheKey, { result, generation: cacheGenerationRef.current });
      // Guard against a slow fetch resolving after the user switched away: only
      // display this result if its file is still selected, mirroring the
      // background-refetch path above.
      if (selectedFileRef.current === filePath) {
        setFileContent({ result, filePath });
      }
    } catch {
      if (selectedFileRef.current === filePath) {
        setFileContent({ result: { original: '', modified: '', language: 'plaintext' }, filePath });
      }
    }
  }, [worktreePath, projectPath, baseBranch, scope, changesSelectedCommit]);

  // Lightweight, local-only branch context for the header (name, ahead/behind,
  // last commit). Cheap enough to re-run on every fs.watch fire and manual
  // refresh, unlike the Done-dialog pending-changes probe.
  const fetchBranchSummary = useCallback(async () => {
    try {
      const summary = await window.electronAPI.git.branchSummary({ worktreePath, projectPath, baseBranch });
      setBranchSummary(summary);
    } catch {
      // Best-effort context: leave the previous summary in place on failure.
    }
  }, [worktreePath, projectPath, baseBranch]);

  // Working-diff file count for the history browser's "Uncommitted changes" row
  // badge. Always scope-based (never commitOid) so the badge stays accurate even
  // while the user is browsing a different commit's detail.
  const fetchUncommittedCount = useCallback(async () => {
    try {
      const result = await window.electronAPI.git.diffFiles({ worktreePath, projectPath, baseBranch, scope });
      setUncommittedFileCount(result.files.length);
    } catch {
      // Best-effort: leave the previous count in place on failure.
    }
  }, [worktreePath, projectPath, baseBranch, scope]);

  // Stable refs for fetch callbacks - used in the subscription effect and
  // handleSelectFile to avoid re-subscribing or re-creating on every render.
  const fetchFilesRef = useRef(fetchFiles);
  fetchFilesRef.current = fetchFiles;
  const fetchFileContentRef = useRef(fetchFileContent);
  fetchFileContentRef.current = fetchFileContent;
  const fetchBranchSummaryRef = useRef(fetchBranchSummary);
  fetchBranchSummaryRef.current = fetchBranchSummary;
  const fetchUncommittedCountRef = useRef(fetchUncommittedCount);
  fetchUncommittedCountRef.current = fetchUncommittedCount;
  // Selection ref for the fs.watch subscription effect below, which must not
  // re-subscribe on every commit-selection change (see that effect's comment).
  const selectedCommitRef = useRef(changesSelectedCommit);
  selectedCommitRef.current = changesSelectedCommit;

  // Fetch file list + branch context + the Uncommitted-row count on mount, and
  // re-fetch whenever the scope, base branch, or commit selection changes.
  useEffect(() => {
    fetchFilesRef.current();
    fetchBranchSummaryRef.current();
    fetchUncommittedCountRef.current();
  }, [worktreePath, projectPath, baseBranch, scope, changesSelectedCommit]);

  // Restore content for the persisted selected file after files load.
  // `files` is in the dependency array so this re-evaluates after the initial
  // fetchFiles completes and flips initialFetchDoneRef (refs don't trigger renders).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialFetchDoneRef.current) return;
    // Honor the persisted selection only if that file still exists in the
    // current diff. Otherwise fall through to auto-select the first file so
    // the diff viewer isn't blank on open (and isn't stuck on a deleted path).
    if (selectedFile && files.some((file) => file.path === selectedFile)) {
      restoredRef.current = true;
      fetchFileContentRef.current(selectedFile);
      return;
    }
    if (files.length > 0) {
      restoredRef.current = true;
      setSelectedFile(files[0].path);
      fetchFileContentRef.current(files[0].path);
    }
  }, [files, selectedFile, setSelectedFile]);

  // On a scope change, allow the restore effect to re-run so it re-selects the
  // current file (if it still exists in the new scope) or the first file, and
  // mark the content cache stale so any same-key entry refetches.
  const previousScopeRef = useRef(scope);
  useEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    restoredRef.current = false;
    cacheGenerationRef.current += 1;
  }, [scope]);

  // Same reset on a commit-selection change (Uncommitted <-> a commit, or
  // switching between two commits): the file list is a different set, so the
  // restore effect must re-select rather than keep pointing at a stale file.
  const previousSelectedCommitRef = useRef(changesSelectedCommit);
  useEffect(() => {
    if (previousSelectedCommitRef.current === changesSelectedCommit) return;
    previousSelectedCommitRef.current = changesSelectedCommit;
    restoredRef.current = false;
    cacheGenerationRef.current += 1;
  }, [changesSelectedCommit]);

  // Subscribe to live updates via fs.watch.
  // Uses refs for selectedFile/files/fetchers to avoid re-subscribing.
  useEffect(() => {
    const watchPath = worktreePath ?? projectPath;
    if (!watchPath) return;

    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // Mark all cache entries stale by advancing the generation counter.
      // Entries are not deleted - they're served immediately as stale-while-revalidate.
      cacheGenerationRef.current += 1;
      fetchBranchSummaryRef.current();
      fetchUncommittedCountRef.current();
      // A selected commit's diff is immutable - skip the file/content refetch
      // while browsing one; only the Uncommitted (working-diff) detail needs it.
      if (!selectedCommitRef.current) {
        fetchFilesRef.current();
        const currentFile = selectedFileRef.current;
        if (currentFile) {
          fetchFileContentRef.current(currentFile);
        }
      }
    });

    return () => {
      window.electronAPI.git.unsubscribeDiff(watchPath);
      unsubscribe();
    };
  }, [worktreePath, projectPath]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    fetchFileContentRef.current(filePath);
  }, [setSelectedFile]);

  const markChangesFileViewed = useSessionStore((state) => state.markChangesFileViewed);

  // Cross-file change navigation. When next/prev-change in the DiffViewer reaches a
  // file's last/first change, it rolls into the adjacent file: select it and ask the
  // DiffViewer to land on that file's first (forward) or last (backward) change once
  // its diff loads. Rolling forward past a file marks it viewed.
  const [pendingChangeFocus, setPendingChangeFocus] = useState<'first' | 'last' | null>(null);

  const handleCrossFile = useCallback((direction: 'next' | 'prev') => {
    const currentFiles = filesRef.current;
    const current = selectedFileRef.current;
    if (current === null || currentFiles.length === 0) return;
    const index = currentFiles.findIndex((file) => file.path === current);
    if (index === -1) return;
    if (direction === 'next') {
      if (index >= currentFiles.length - 1) return; // last file: stop at the end
      markChangesFileViewed(entityId, current); // rolled past its last change
      setPendingChangeFocus('first');
      handleSelectFile(currentFiles[index + 1].path);
    } else {
      if (index <= 0) return; // first file: stop at the start
      setPendingChangeFocus('last');
      handleSelectFile(currentFiles[index - 1].path);
    }
  }, [entityId, handleSelectFile, markChangesFileViewed]);

  // Whole-file jump (next/prev changed file), independent of change navigation.
  const handleNavigateFile = useCallback((direction: 'next' | 'prev') => {
    const currentFiles = filesRef.current;
    if (currentFiles.length === 0) return;
    const current = selectedFileRef.current;
    const index = current === null ? -1 : currentFiles.findIndex((file) => file.path === current);
    let targetIndex: number;
    if (direction === 'next') {
      targetIndex = index < 0 ? 0 : Math.min(index + 1, currentFiles.length - 1);
    } else {
      targetIndex = index < 0 ? currentFiles.length - 1 : Math.max(index - 1, 0);
    }
    const target = currentFiles[targetIndex]?.path;
    if (target && target !== current) handleSelectFile(target);
  }, [handleSelectFile]);

  useKeybinding('changes.nextFile', () => handleNavigateFile('next'), { capture: true, enabled: isFocused });
  useKeybinding('changes.prevFile', () => handleNavigateFile('prev'), { capture: true, enabled: isFocused });

  // File-tree width is PER-TASK (session store, keyed by entityId), like the
  // terminal split's dividerRatio: an undefined stored width means auto-fit to the
  // branch name / last commit on open; a drag sets that task's own width. Local
  // state drives live drag feedback.
  const storedFileTreeWidth = useSessionStore((state) => state.changesFileTreeWidth[entityId]);
  const setChangesFileTreeWidth = useSessionStore((state) => state.setChangesFileTreeWidth);
  const [fileTreeWidth, setFileTreeWidth] = useState<number>(storedFileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH);
  const fileTreeWidthRef = useRef<number>(storedFileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH);
  const [isResizingTree, setIsResizingTree] = useState(false);
  const panelRowRef = useRef<HTMLDivElement>(null);
  const autoFittedRef = useRef(false);
  // In auto-fit mode the two-pane is held at opacity 0 (behind a spinner) until
  // the width is measured, so it reveals already at the correct width rather than
  // painting at the default and snapping/animating. Manual width is ready at once.
  const [autoFitReady, setAutoFitReady] = useState<boolean>(storedFileTreeWidth !== undefined);

  // Apply the stored (manual) width. Fires only when the stored value itself
  // changes - NOT on isResizingTree - so the release does not momentarily re-apply
  // a stale width and snap the panel (the janky double-move). A live drag is
  // local-only and untouched.
  useEffect(() => {
    if (storedFileTreeWidth === undefined) return; // auto-fit mode owns the width
    setFileTreeWidth(storedFileTreeWidth);
    fileTreeWidthRef.current = storedFileTreeWidth;
  }, [storedFileTreeWidth]);

  // Auto-fit once when the branch summary first arrives and this task has no
  // manual width: measure the natural (un-truncated) width of the branch name +
  // last-commit line (scrollWidth survives truncation, and works at opacity 0) and
  // size the tree to fit, clamped so it never crowds the diff. Reveal once
  // measured, so the panel appears already at its final width.
  useLayoutEffect(() => {
    if (storedFileTreeWidth !== undefined || autoFittedRef.current || !branchSummary) return;
    const container = panelRowRef.current;
    if (!container) return;
    autoFittedRef.current = true;
    const branchEl = container.querySelector('[data-testid="changes-branch-name"]');
    const commitEl = container.querySelector('[data-testid="changes-last-commit"]');
    const branchNeeded = branchEl ? branchEl.scrollWidth + BRANCH_NAME_FIT_PADDING : 0;
    const commitNeeded = commitEl ? commitEl.scrollWidth + LAST_COMMIT_FIT_PADDING : 0;
    const needed = Math.max(branchNeeded, commitNeeded);
    if (needed > 0) {
      const fit = Math.round(Math.max(
        FILE_TREE_DEFAULT_WIDTH,
        Math.min(FILE_TREE_AUTO_FIT_MAX, container.getBoundingClientRect().width - FILE_TREE_AUTO_FIT_DIFF_RESERVE, needed),
      ));
      setFileTreeWidth(fit);
      fileTreeWidthRef.current = fit;
    }
    setAutoFitReady(true);
  }, [branchSummary, storedFileTreeWidth]);

  // Safety net: never hold the two-pane hidden forever waiting on branch context
  // that may never arrive (e.g. the branch-summary IPC rejected, so branchSummary
  // stays null and the auto-fit effect above never runs). If auto-fit has not
  // completed shortly after mount, reveal at the default width. The happy path
  // sets autoFitReady within a frame or two, well before this fires, and clears
  // the timer on cleanup.
  useEffect(() => {
    if (autoFitReady) return;
    const revealFallbackTimer = setTimeout(() => setAutoFitReady(true), 1500);
    return () => clearTimeout(revealFallbackTimer);
  }, [autoFitReady]);

  const handleTreeResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const container = panelRowRef.current;
    if (!container) return;
    setIsResizingTree(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      // Keep at least FILE_TREE_DRAG_MIN for the tree and DIFF_PANE_DRAG_MIN for the diff pane.
      const next = Math.max(FILE_TREE_DRAG_MIN, Math.min(rect.width - DIFF_PANE_DRAG_MIN, moveEvent.clientX - rect.left));
      setFileTreeWidth(next);
      fileTreeWidthRef.current = next;
    };
    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setIsResizingTree(false);
      setChangesFileTreeWidth(entityId, fileTreeWidthRef.current);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [setChangesFileTreeWidth, entityId]);

  const selectedFileEntry = useMemo(() => files.find((file) => file.path === selectedFile), [files, selectedFile]);

  // Base-branch badge, shown in the Uncommitted detail's branch header: just
  // the base branch name, tone-coded (see FileTreePanel's baseLabelCustom) so
  // a custom base is what draws the eye - the full "based on / off" sentence
  // lives in the badge's hover tooltip instead of the visible pill. Reconciled
  // with the graph's own base-ref badge by scope: the badge marks WHERE the
  // base commit sits in the history list; this one states the divergence
  // relationship in the working-diff context, so it only renders there (never
  // in commit-detail).
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const isCustomBase = !!task?.base_branch && task.base_branch !== (defaultBaseBranch || 'main');
  const baseLabel = baseBranch;

  // Commit-detail header info: metadata for the selected commit if it was set
  // by a click this session, else just the short hash (a restored selection
  // has no metadata until the user re-clicks the row).
  const commitHeaderMeta = selectedCommitMeta && selectedCommitMeta.hash === changesSelectedCommit ? selectedCommitMeta : null;

  // Vertical-split state between the commit-history region (top) and the
  // detail pane (bottom), per task, mirroring the file-tree width resize below.
  const changesPanelRootRef = useRef<HTMLDivElement>(null);
  const storedHistoryHeight = useSessionStore((state) => state.changesHistoryHeight[entityId]);
  const setChangesHistoryHeightStore = useSessionStore((state) => state.setChangesHistoryHeight);
  const [historyHeight, setHistoryHeight] = useState<number>(storedHistoryHeight ?? HISTORY_DEFAULT_HEIGHT);
  const historyHeightRef = useRef<number>(storedHistoryHeight ?? HISTORY_DEFAULT_HEIGHT);
  const [isResizingHistory, setIsResizingHistory] = useState(false);

  useEffect(() => {
    if (storedHistoryHeight === undefined) return;
    setHistoryHeight(storedHistoryHeight);
    historyHeightRef.current = storedHistoryHeight;
  }, [storedHistoryHeight]);

  const handleHistoryResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const container = changesPanelRootRef.current;
    if (!container) return;
    setIsResizingHistory(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.height === 0) return;
      // Keep at least HISTORY_DRAG_MIN for the history list and DETAIL_REGION_DRAG_MIN for the detail pane.
      const next = Math.max(HISTORY_DRAG_MIN, Math.min(rect.height - DETAIL_REGION_DRAG_MIN, moveEvent.clientY - rect.top));
      setHistoryHeight(next);
      historyHeightRef.current = next;
    };
    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setIsResizingHistory(false);
      setChangesHistoryHeightStore(entityId, historyHeightRef.current);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [setChangesHistoryHeightStore, entityId]);

  // Shared detachable-surface header (task-detail embed only): the panel's true
  // first row, above the commit-history region. It also OWNS the branch context
  // (branch + base badge + ahead/behind + last commit) that the file-tree's
  // BranchHeader shows in the other embeds - the embed passes showBranchHeader=false
  // to that so the row is not duplicated. Panel-level actions (expand-full) and the
  // pop-out control sit on the right - the one predictable home for pop-out across
  // every surface. Diff/git tools stay in the diff toolbar below, never mixed in.
  const surfaceHeaderAhead = branchSummary?.ahead ?? 0;
  const surfaceHeaderBehind = branchSummary?.behind ?? 0;
  const surfaceHeaderLastCommit = branchSummary?.lastCommit ?? null;
  const surfaceHeader = popOutParams ? (
    <DetachableSurfaceHeader kind="changes" params={popOutParams} actions={expandCollapseControl}>
      <GitBranch size={14} className="text-fg-muted flex-shrink-0" aria-hidden />
      <span
        className="text-xs font-medium text-fg-secondary truncate flex-shrink-0 max-w-[45%]"
        title={branchSummary?.currentBranch ?? undefined}
        data-testid="changes-branch-name"
      >
        {branchSummary?.currentBranch ?? 'Changes'}
      </span>
      {baseLabel && (
        <span
          className={`shrink-0 rounded border px-1 py-px text-[11px] font-medium leading-none ${
            isCustomBase ? 'border-accent/50 text-accent-fg' : 'border-edge-subtle text-fg-faint'
          }`}
          data-testid="changes-base-label"
          title={isCustomBase ? `Based on ${baseLabel}, not the project default` : `Based on ${baseLabel}, the project default`}
        >
          {baseLabel}
        </span>
      )}
      {(surfaceHeaderAhead > 0 || surfaceHeaderBehind > 0) && (
        <span className="flex items-center gap-1.5 text-fg-muted flex-shrink-0 text-[11px]" title={`${surfaceHeaderAhead} ahead, ${surfaceHeaderBehind} behind base branch`}>
          {surfaceHeaderAhead > 0 && (
            <span className="flex items-center gap-0.5 tabular-nums"><ArrowUp size={11} className="text-green-400" />{surfaceHeaderAhead}</span>
          )}
          {surfaceHeaderBehind > 0 && (
            <span className="flex items-center gap-0.5 tabular-nums"><ArrowDown size={11} className="text-red-400" />{surfaceHeaderBehind}</span>
          )}
        </span>
      )}
      {surfaceHeaderLastCommit && (
        <>
          <span className="h-3 w-px bg-edge/60 flex-shrink-0 mx-0.5" aria-hidden />
          <span
            className="text-[11px] text-fg-muted truncate min-w-0"
            title={`${surfaceHeaderLastCommit.hash} ${surfaceHeaderLastCommit.subject}`}
            data-testid="changes-last-commit"
          >
            <span className="font-mono text-fg-faint">{surfaceHeaderLastCommit.hash}</span>{' '}
            {surfaceHeaderLastCommit.subject}
            {surfaceHeaderLastCommit.timestamp && (
              <span className="text-fg-faint"> {'·'} {formatRelativeTime(surfaceHeaderLastCommit.timestamp)}</span>
            )}
          </span>
        </>
      )}
    </DetachableSurfaceHeader>
  ) : null;

  // The detail pane (error / empty / two-pane), scoped to the current
  // selection (Uncommitted or a commit). Rendered as a helper so the history
  // region above stays mounted regardless of which branch renders below.
  const renderFilesBody = (): React.ReactNode => {
  // Compact header identifying the selected commit, shown above the detail
  // pane whenever a commit (not Uncommitted) is selected.
  const commitDetailHeader = changesSelectedCommit ? (
    <div
      className="flex items-center gap-2 border-b border-edge px-3 py-1.5 flex-shrink-0"
      data-testid="commit-detail-header"
    >
      <button
        type="button"
        onClick={handleSelectUncommitted}
        title="Back to Uncommitted changes"
        className="p-1 -ml-1 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors flex-shrink-0"
        data-testid="commit-detail-back"
      >
        <ArrowLeft size={14} />
      </button>
      <span className="font-mono text-xs text-fg-secondary flex-shrink-0">
        {commitHeaderMeta?.shortHash ?? changesSelectedCommit.slice(0, 7)}
      </span>
      {commitHeaderMeta && <span className="truncate text-xs text-fg">{commitHeaderMeta.subject}</span>}
      {commitHeaderMeta && (
        <span className="truncate text-[11px] text-fg-faint flex-shrink-0">
          {commitHeaderMeta.authorName}
          {commitHeaderMeta.authorTimestamp && ` · ${formatRelativeTime(commitHeaderMeta.authorTimestamp)}`}
        </span>
      )}
      <span className="ml-auto flex-shrink-0 text-[11px] text-fg-faint">
        +{totalInsertions}/-{totalDeletions}
      </span>
    </div>
  ) : null;

  if (error) {
    return (
      <div className="flex flex-col h-full">
        {commitDetailHeader}
        <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4">
          <span className="text-xs text-red-400">{error}</span>
          <button
            onClick={fetchFiles}
            className="text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (emptyMessage && loaded && files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {commitDetailHeader}
        <div className="flex items-center justify-center flex-1 text-sm text-fg-disabled">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative">
      {commitDetailHeader}
      {/* Hold the panel hidden (behind the spinner) until the auto-fit width is
          measured, so it reveals already at the correct width - no snap, no animate. */}
      <div ref={panelRowRef} className="flex-1 min-h-0 flex" style={{ opacity: autoFitReady ? 1 : 0 }}>
        {/* File tree - left panel (drag-resizable) */}
        <div className="flex-shrink-0 overflow-hidden" style={{ width: fileTreeWidth }}>
          <FileTreePanel
            files={files}
            selectedFile={selectedFile}
            onSelect={handleSelectFile}
            totalInsertions={totalInsertions}
            totalDeletions={totalDeletions}
            branchSummary={changesSelectedCommit ? undefined : branchSummary}
            showBranchHeader={!popOutParams}
            viewedFiles={viewedFiles}
            onToggleViewed={handleToggleViewed}
            scope={changesSelectedCommit ? undefined : scope}
            onScopeChange={changesSelectedCommit ? undefined : handleScopeChange}
            baseLabel={changesSelectedCommit ? undefined : baseLabel}
            baseLabelCustom={changesSelectedCommit ? undefined : isCustomBase}
            worktreePath={worktreePath}
            projectPath={projectPath}
            onSelectHistoryCommit={handleSelectHistoryCommit}
          />
        </div>

        {/* Drag handle: widen the file tree to see long branch names / file paths. */}
        <div
          onMouseDown={handleTreeResizeStart}
          className={`w-1 flex-shrink-0 cursor-col-resize transition-colors ${isResizingTree ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
          role="separator"
          aria-orientation="vertical"
          data-testid="changes-tree-resize"
        />

        {/* Diff viewer - right panel */}
        <div className="flex-1 min-h-0">
          {!selectedFile ? (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-center flex-1 text-xs text-fg-disabled">
                Select a file to view changes
              </div>
            </div>
          ) : (
            <DiffErrorBoundary>
              <DiffViewer
                original={fileContent?.result.original ?? ''}
                modified={fileContent?.result.modified ?? ''}
                language={fileContent?.result.language ?? 'plaintext'}
                filePath={selectedFile}
                contentFilePath={fileContent?.filePath ?? null}
                scrollKey={effectiveScrollKey}
                status={selectedFileEntry?.status ?? 'M'}
                viewMode={viewMode}
                onViewModeChange={(mode) => updateConfig({ diffViewMode: mode })}
                binary={selectedFileEntry?.binary ?? false}
                isFocused={isFocused}
                onCrossFile={handleCrossFile}
                pendingChangeFocus={pendingChangeFocus}
                onPendingChangeFocusConsumed={() => setPendingChangeFocus(null)}
                worktreePath={worktreePath}
                projectPath={projectPath}
                blameEligible={!changesSelectedCommit && scope !== 'staged'}
              />
            </DiffErrorBoundary>
          )}
        </div>
      </div>

      {/* Brief spinner shown over the opacity-0 panel until the auto-fit width is
          measured, so the panel never paints at the wrong width first. */}
      {!autoFitReady && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={20} className="animate-spin text-fg-muted" />
        </div>
      )}
    </div>
  );
  };

  return (
    <div ref={changesPanelRootRef} className="flex flex-col h-full min-h-0">
      {surfaceHeader}
      {/* Commit-history region (top): the master browse surface. Only shown when
          a `task` is provided (the history browser needs the graph's PR marker);
          the command-terminal embed stays Uncommitted-only, filling the whole panel. */}
      {task && (
        <>
          <div className="flex-shrink-0 overflow-hidden" style={{ height: historyHeight }}>
            <CommitGraphPanel
              projectPath={projectPath}
              worktreePath={worktreePath}
              baseBranch={baseBranch}
              task={task}
              isFocused={isFocused}
              onSelectCommit={handleSelectCommit}
              onSelectUncommitted={handleSelectUncommitted}
              selectedCommit={changesSelectedCommit}
              uncommittedCount={uncommittedFileCount}
            />
          </div>

          {/* Drag handle: resize the history region vs. the detail pane below. */}
          <div
            onMouseDown={handleHistoryResizeStart}
            className={`h-1 flex-shrink-0 cursor-row-resize transition-colors ${isResizingHistory ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
            role="separator"
            aria-orientation="horizontal"
            data-testid="changes-history-resize"
          />
        </>
      )}

      {/* Detail pane (bottom): the selected row's diff (Uncommitted or a commit). */}
      <div className="flex-1 min-h-0">
        {renderFilesBody()}
      </div>
    </div>
  );
}
