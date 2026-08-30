import '../../../../monacoConfig';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronsLeftRight, ChevronsRightLeft, GitBranch, ArrowLeft, ArrowUp, ArrowDown, Check } from 'lucide-react';
import { PrLink } from '../../../PrLink';
import { DetachableSurfaceHeader } from '../../../../pop-out/DetachableSurfaceHeader';
import { FileTreePanel } from './FileTreePanel';
import { DiffViewer } from './DiffViewer';
import { DiffViewOptionsMenu } from './DiffViewOptionsMenu';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { ChangesHistorySection, HISTORY_SECTION_HEADER_PX } from './ChangesHistorySection';
import { CommitGraphPanel } from '../graph/CommitGraphPanel';
import { useSessionStore } from '../../../../stores/session-store';
import { useConfigStore } from '../../../../stores/config-store';
import { useToastStore } from '../../../../stores/toast-store';
import { POP_OUT_SURFACES } from '../../../../../shared/pop-out';
import { useKeybinding, useFormattedCombo } from '../../../../hooks/useKeybinding';
import { MousePointerClick } from 'lucide-react';
import { formatRelativeTime } from '../../../../lib/datetime';
import type { GitBranchSummaryResult, GitCommitGraphCommit, GitDiffFileEntry, GitDiffFilesResult, GitDiffScope, GitFileContentResult, GitFileHistoryCommit, Task } from '../../../../../shared/types';

// Stable empty set so a task with no viewed files keeps a referentially-constant
// prop (avoids re-rendering the file tree every render).
// hmr-safe: never mutated; a referential-identity sentinel for "no viewed files".
const EMPTY_VIEWED_FILES = new Set<string>();

// Rail (file-tree column) width constraints. The DEFAULT is proportional:
// clamp(220px, 25%, 420px) of the panel row, pure CSS, so a split<->expanded
// flip re-derives the width with no observer and the expanded panel widens
// filenames instead of stranding a fixed-px rail in a full-window row - while
// the width dividend past the 420px cap all goes to the diff pane. A manual
// drag still stores exact px (TortoiseGit-style precise control), render-
// clamped so a width stored against a wider panel never starves the diff.
// The skeleton in TaskDetailBody.tsx mirrors the default clamp - keep in sync.
const RAIL_DEFAULT_WIDTH_CLAMP = 'clamp(220px, 25%, 420px)';
const FILE_TREE_DEFAULT_WIDTH = 220;          // drag-state seed before any stored width exists
const FILE_TREE_DRAG_MIN = 200;               // minimum rail width while dragging the divider
const DIFF_PANE_DRAG_MIN = 240;               // minimum diff-pane width while dragging the divider

// Vertical-split constraints (px) for the History section at the BOTTOM of the
// rail: the section body's height vs the file-tree region above it.
const HISTORY_DEFAULT_HEIGHT = 200;
// Min body height: the pinned Uncommitted row plus ~1.5 commit rows at 44px.
const HISTORY_DRAG_MIN = 120;
// Min height kept for the tree region above the section while dragging.
const TREE_REGION_DRAG_MIN = 160;

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
   *  a handler, the panel renders an expand-or-collapse control in the shared
   *  surface header - it acts on the whole Changes surface, not the current
   *  diff, so it does not belong in the diff toolbar. */
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
  /** When set, file rows offer "open this file's diff in its own OS window"
   *  (double-click + the context menu item). SEPARATE from `popOutParams`
   *  because that prop also gates the whole-surface detach header, which the
   *  detached Changes window deliberately omits while still offering the
   *  per-file affordance. Absent for the command-terminal embed (no task). */
  filePopOutParams?: { taskId: string; projectId: string };
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

export function ChangesPanel({ entityId, isFocused = false, scrollKey, projectPath, worktreePath, baseBranch, emptyMessage, panelMode, onExpand, onCollapse, task, popOutParams, filePopOutParams }: ChangesPanelProps) {
  const effectiveScrollKey = scrollKey ?? entityId;
  // Live combo for the empty-state hint (tracks rebinds; '' when unbound).
  const nextFileCombo = useFormattedCombo('changes.nextFile');
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
  // toggle and the Changes settings tab read and write the same config key, so
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

  // Guards against overlapping diffFiles fetches. A rapid string of fs.watch
  // fires (e.g. an agent writing many files in a burst) would otherwise queue
  // multiple concurrent git subprocess calls whose responses can resolve out
  // of order. While a fetch is in flight, a new call just marks a pending
  // re-fetch and returns; the pending fetch runs once the in-flight one
  // completes, through fetchFilesRef so it always picks up the latest
  // scope/selection rather than the params captured when it was queued.
  const filesFetchInFlightRef = useRef(false);
  const filesFetchPendingRef = useRef(false);

  const fetchFiles = useCallback(async () => {
    if (filesFetchInFlightRef.current) {
      filesFetchPendingRef.current = true;
      return;
    }
    filesFetchInFlightRef.current = true;
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
      // A working-scope, no-commit-selected fetch is exactly the query
      // fetchUncommittedCount would make - derive the badge count here so the
      // watcher cascade doesn't fire a second diffFiles call for it.
      if (!changesSelectedCommit && scope === 'working') {
        setUncommittedFileCount(result.files.length);
      }
      initialFetchDoneRef.current = true;
      setLoaded(true);
    } catch (fetchError) {
      // Only show errors on initial load - transient failures during live
      // updates (e.g. git lock contention) are silently ignored.
      if (!initialFetchDoneRef.current) {
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load diff');
      }
    } finally {
      filesFetchInFlightRef.current = false;
      if (filesFetchPendingRef.current) {
        filesFetchPendingRef.current = false;
        void fetchFilesRef.current();
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

  // Truthful `behind`: without a fetch, the counts only reflect the last time
  // anyone fetched, so a branch can read "0 behind" while origin has moved on.
  // refreshRemote makes the HANDLER run the throttled all-remotes fetch first
  // (5s budget, never rejects). Mount-only by design - the cheap local summary
  // above paints immediately and this corrects it once; the fs.watch refires
  // stay flagless so file edits never trigger network I/O.
  const refreshBranchSummaryFromRemote = useCallback(async () => {
    try {
      const summary = await window.electronAPI.git.branchSummary({ worktreePath, projectPath, baseBranch, refreshRemote: true });
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
  // Scope ref for the same subscription effect, to decide whether fetchFiles's
  // result already covers the Uncommitted-row count (see onDiffChanged below).
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // Fetch file list + branch context + the Uncommitted-row count on mount, and
  // re-fetch whenever the scope, base branch, or commit selection changes.
  useEffect(() => {
    fetchFilesRef.current();
    fetchBranchSummaryRef.current();
    // fetchFiles already derives uncommittedFileCount for a working-scope,
    // no-commit fetch (see its body), so firing the separate query too would be
    // a second, redundant diffFiles call. Only fire it for the cases fetchFiles
    // doesn't cover, mirroring the onDiffChanged watcher guard below.
    if (changesSelectedCommit || scope !== 'working') {
      fetchUncommittedCountRef.current();
    }
  }, [worktreePath, projectPath, baseBranch, scope, changesSelectedCommit]);

  // One remote-refreshed summary per panel identity, NOT per scope or
  // commit-selection change - browsing commits must never re-fetch the
  // network. The callback's own deps are exactly the panel identity
  // (worktreePath / projectPath / baseBranch), so depending on it keys this
  // effect correctly. Runs after the flagless mount fetch above, so the header
  // shows the cheap local counts immediately and corrects them within the
  // probe budget (or silently keeps them when offline).
  // hmr-safe: a Vite Fast Refresh remount re-runs this like a fresh mount;
  // that is accepted because the handler's fetch is throttled to one real
  // fetch per repo per 30s and never rejects - do not "fix" that throttle
  // window down on the strength of the mount-only comment above.
  useEffect(() => {
    void refreshBranchSummaryFromRemote();
  }, [refreshBranchSummaryFromRemote]);

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
      return;
    }
    // The diff is EMPTY (a clean worktree, or a scope/commit with no files)
    // while a persisted selection still names a file. Neither branch above can
    // fire, so without this the stale path stayed selected: the toolbar showed
    // a filename that is not in the list and the editor sat on its boot
    // spinner forever, because content is only ever fetched for a listed file.
    // Deliberately does NOT set restoredRef - a file arriving later (the agent
    // writes one and the fs-watch refetch lands) should still auto-select.
    if (selectedFile) setSelectedFile(null);
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
      // A selected commit's diff is immutable - skip the file/content refetch
      // while browsing one; only the Uncommitted (working-diff) detail needs it.
      if (!selectedCommitRef.current) {
        fetchFilesRef.current();
        // When scope is 'working', the fetchFiles call above already derives
        // uncommittedFileCount from its own result - firing this too would be
        // a second, redundant diffFiles call on every watcher fire. Any other
        // scope needs the separate working-scope query.
        if (scopeRef.current !== 'working') {
          fetchUncommittedCountRef.current();
        }
        const currentFile = selectedFileRef.current;
        if (currentFile) {
          fetchFileContentRef.current(currentFile);
        }
      } else {
        fetchUncommittedCountRef.current();
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

  // Detach ONE file's diff into its own OS window ('changes-file' pop-out kind).
  // The params capture the diff selection the row was double-clicked in (the
  // pinned commit when one is selected, the live scope otherwise) plus the boot
  // seed - paths, the file's list entry, and the task label - so the window
  // fetches and titles itself without waiting on store hydration (see
  // PopOutChangesFileParams). The cap is enforced main-side (maxInstances); a
  // refused open resolves false and is surfaced as a toast.
  // task and filePopOutParams are read through a ref / primitives rather than
  // depended on directly: both get a fresh identity on every board-store push
  // (an actively-working task refreshes constantly), and this callback feeds
  // every FileRowView's memo'd onOpenInNewWindow prop - an unstable identity
  // here re-renders every visible row on every push, which the sibling
  // onSelect / onToggleViewed / onContextMenu handlers deliberately avoid.
  const taskRef = useRef(task);
  taskRef.current = task;
  const filePopOutTaskId = filePopOutParams?.taskId;
  const filePopOutProjectId = filePopOutParams?.projectId;
  const handleOpenFileWindow = useCallback((filePath: string) => {
    const currentTask = taskRef.current;
    if (!filePopOutTaskId || !filePopOutProjectId || !currentTask) return;
    const entry = filesRef.current.find((file) => file.path === filePath);
    if (!entry) return;
    void (async () => {
      try {
        const opened = await window.electronAPI.popOut.open('changes-file', {
          taskId: filePopOutTaskId,
          projectId: filePopOutProjectId,
          filePath,
          scope: changesSelectedCommit ? undefined : scope,
          commitOid: changesSelectedCommit ?? undefined,
          projectPath,
          worktreePath,
          baseBranch,
          status: entry.status,
          oldPath: entry.oldPath,
          binary: entry.binary,
          taskDisplayId: currentTask.display_id,
          taskTitle: currentTask.title,
        });
        if (!opened) {
          const maxInstances = POP_OUT_SURFACES['changes-file'].maxInstances;
          useToastStore.getState().addToast({ message: `File diff window limit reached (${maxInstances}). Close one to open another.` });
        }
      } catch {
        useToastStore.getState().addToast({ message: 'Could not open the file diff window.' });
      }
    })();
  }, [filePopOutTaskId, filePopOutProjectId, changesSelectedCommit, scope, projectPath, worktreePath, baseBranch]);

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
  // terminal split's dividerRatio: an undefined stored width means the default
  // width; a drag sets that task's own width. Local state drives live drag
  // feedback.
  const storedFileTreeWidth = useSessionStore((state) => state.changesFileTreeWidth[entityId]);
  const setChangesFileTreeWidth = useSessionStore((state) => state.setChangesFileTreeWidth);
  const [fileTreeWidth, setFileTreeWidth] = useState<number>(storedFileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH);
  const fileTreeWidthRef = useRef<number>(storedFileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH);
  const [isResizingTree, setIsResizingTree] = useState(false);
  const panelRowRef = useRef<HTMLDivElement>(null);

  // Apply the stored (manual) width. Fires only when the stored value itself
  // changes - NOT on isResizingTree - so the release does not momentarily re-apply
  // a stale width and snap the panel (the janky double-move). A live drag is
  // local-only and untouched.
  useEffect(() => {
    if (storedFileTreeWidth === undefined) return;
    setFileTreeWidth(storedFileTreeWidth);
    fileTreeWidthRef.current = storedFileTreeWidth;
  }, [storedFileTreeWidth]);

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

  // Double-click-to-reset: clear the stored width so the rail returns to its
  // proportional default (the render falls through to RAIL_DEFAULT_WIDTH_CLAMP
  // once the stored value is gone).
  const handleTreeResizeReset = useCallback(() => {
    setChangesFileTreeWidth(entityId, null);
    setFileTreeWidth(FILE_TREE_DEFAULT_WIDTH);
    fileTreeWidthRef.current = FILE_TREE_DEFAULT_WIDTH;
  }, [setChangesFileTreeWidth, entityId]);

  const selectedFileEntry = useMemo(() => files.find((file) => file.path === selectedFile), [files, selectedFile]);

  // Rendered rail width: local px while dragging (1:1 pointer tracking), the
  // stored px render-clamped when a drag has ever set one, else the
  // proportional default. The clamp's percentage resolves against the panel
  // row (the rail's flex container), so mode flips re-derive it for free.
  const railWidthStyle = isResizingTree
    ? `${fileTreeWidth}px`
    : storedFileTreeWidth !== undefined
      ? `clamp(${FILE_TREE_DRAG_MIN}px, ${storedFileTreeWidth}px, calc(100% - ${DIFF_PANE_DRAG_MIN + 4}px))`
      : RAIL_DEFAULT_WIDTH_CLAMP;

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

  // The empty-diff sentence names what was searched. This pane is the only
  // place the surface states emptiness, so a bare "No changes" leaves the user
  // guessing whether the panel failed or they are simply looking at the wrong
  // scope - naming it points at where the changes actually are.
  const emptyDiffMessage = changesSelectedCommit
    ? 'This commit changed no files'
    : scope === 'staged'
      ? 'No staged changes'
      : scope === 'branch'
        ? `No changes vs ${baseLabel}`
        : 'No uncommitted changes';

  // Commit-detail header info: metadata for the selected commit if it was set
  // by a click this session, else just the short hash (a restored selection
  // has no metadata until the user re-clicks the row).
  const commitHeaderMeta = selectedCommitMeta && selectedCommitMeta.hash === changesSelectedCommit ? selectedCommitMeta : null;

  // Fade the rail's slot-swap content in only when the pin CHANGES live (a
  // restored pin renders on first paint without the class - restore-flat).
  const previousPinRef = useRef(changesSelectedCommit);
  const [pinSwapFade, setPinSwapFade] = useState(false);
  useEffect(() => {
    if (previousPinRef.current === changesSelectedCommit) return;
    previousPinRef.current = changesSelectedCommit;
    setPinSwapFade(true);
    const timer = setTimeout(() => setPinSwapFade(false), 140);
    return () => clearTimeout(timer);
  }, [changesSelectedCommit]);

  // History section state: expanded flag (per task, persisted only when true -
  // collapsed is the default) and the expanded body's height, both mirroring
  // the file-tree width pattern above. The section lives at the BOTTOM of the
  // rail column, so the drag math measures up from the rail's bottom edge.
  const railRef = useRef<HTMLDivElement>(null);
  const historyOpen = useSessionStore((state) => state.changesHistoryOpen[entityId] ?? false);
  const setChangesHistoryOpen = useSessionStore((state) => state.setChangesHistoryOpen);
  const handleHistoryToggle = useCallback(() => {
    setChangesHistoryOpen(entityId, !useSessionStore.getState().changesHistoryOpen[entityId]);
  }, [entityId, setChangesHistoryOpen]);
  // Commit count for the section header, reported by the (possibly hidden)
  // graph panel so the collapsed header stays informative.
  const [historyCommitCount, setHistoryCommitCount] = useState<number | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const handleGraphLoaded = useCallback((commitCount: number, truncated: boolean) => {
    setHistoryCommitCount(commitCount);
    setHistoryTruncated(truncated);
  }, []);
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
    const container = railRef.current;
    if (!container) return;
    setIsResizingHistory(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.height === 0) return;
      // The section sits at the rail bottom, so dragging UP grows the body:
      // pointer-to-rail-bottom distance, minus the always-visible section
      // header. Keep HISTORY_DRAG_MIN for the body and TREE_REGION_DRAG_MIN for
      // the tree region above.
      const next = Math.max(
        HISTORY_DRAG_MIN,
        Math.min(rect.height - TREE_REGION_DRAG_MIN, rect.bottom - moveEvent.clientY - HISTORY_SECTION_HEADER_PX),
      );
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

  // Double-click-to-reset: clear the stored height and return the section body
  // to its default.
  const handleHistoryResizeReset = useCallback(() => {
    setChangesHistoryHeightStore(entityId, null);
    setHistoryHeight(HISTORY_DEFAULT_HEIGHT);
    historyHeightRef.current = HISTORY_DEFAULT_HEIGHT;
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
  // Review progress (n/m viewed) in the surface header, hidden until the first
  // mark. Deliberately duplicates the rail's changes-viewed-count: this one is
  // the at-a-glance summary that survives the rail scrolling or a maximized
  // diff; the rail's stays with the list it describes.
  const viewedCount = useMemo(
    () => files.reduce((count, file) => (viewedFiles.has(file.path) ? count + 1 : count), 0),
    [files, viewedFiles],
  );
  const surfaceHeaderViewed = files.length > 0 && viewedCount > 0 ? (
    <span
      className="flex items-center gap-1 text-[11px] text-fg-muted tabular-nums flex-shrink-0"
      title={`${viewedCount} of ${files.length} files marked viewed`}
      data-testid="changes-header-viewed"
    >
      <Check size={12} className={viewedCount === files.length ? 'text-green-400' : 'text-fg-faint'} />
      {viewedCount}/{files.length}
    </span>
  ) : null;
  const surfaceHeader = popOutParams ? (
    <DetachableSurfaceHeader kind="changes" params={popOutParams} actions={<>{surfaceHeaderViewed}{expandCollapseControl}</>}>
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
      {task?.pr_url && (
        <PrLink prUrl={task.pr_url} prNumber={task.pr_number} prState={task.pr_state} testId="changes-pr-link" className="shrink-0" />
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
  // Two-line, rail-width layout: it renders at the TOP of the rail column, in
  // the region the scope segmented control vacates while a commit is pinned
  // (FileTreePanel suppresses the control when `scope` is undefined), so
  // pinning swaps the slot's content instead of inserting a full-width row and
  // jumping the whole layout. The error / empty branches below render the same
  // element full-width, where the two-line shape still reads fine.
  const commitDetailHeader = changesSelectedCommit ? (
    <div
      className={`border-b border-edge px-2 py-1.5 flex-shrink-0 ${pinSwapFade ? 'rail-slot-in' : ''}`}
      data-testid="commit-detail-header"
    >
      <div className="flex items-center gap-1.5 min-w-0">
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
        <span className="ml-auto flex-shrink-0 text-[11px] text-fg-faint tabular-nums">
          +{totalInsertions}/-{totalDeletions}
        </span>
      </div>
      {commitHeaderMeta && (
        <div
          className="mt-0.5 flex items-center gap-1.5 min-w-0 pl-6"
          title={`${commitHeaderMeta.subject}\n${commitHeaderMeta.authorName}${commitHeaderMeta.authorTimestamp ? ` · ${formatRelativeTime(commitHeaderMeta.authorTimestamp)}` : ''}`}
        >
          <span className="truncate text-xs text-fg">{commitHeaderMeta.subject}</span>
          <span className="flex-shrink-0 truncate max-w-[45%] text-[11px] text-fg-faint">
            {commitHeaderMeta.authorName}
            {commitHeaderMeta.authorTimestamp && ` · ${formatRelativeTime(commitHeaderMeta.authorTimestamp)}`}
          </span>
        </div>
      )}
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
    <div className="flex flex-col h-full">
      <div ref={panelRowRef} className="flex-1 min-h-0 flex">
        {/* Rail - left column (drag-resizable): commit context, file tree, and
            the collapsible History section pinned at the bottom. */}
        <div ref={railRef} className="flex-shrink-0 overflow-hidden flex flex-col" style={{ width: railWidthStyle }}>
          {commitDetailHeader}
          <div className="flex-1 min-h-0">
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
              prLink={task?.pr_url ? { url: task.pr_url, number: task.pr_number, state: task.pr_state } : undefined}
              loaded={loaded}
              worktreePath={worktreePath}
              projectPath={projectPath}
              onSelectHistoryCommit={handleSelectHistoryCommit}
              onOpenInNewWindow={filePopOutParams && task ? handleOpenFileWindow : undefined}
            />
          </div>

          {/* Drag handle: resize the History body vs. the tree region above.
              Rendered only while the section is open (a collapsed header is not
              resizable). 1px visual line, ~9px invisible hit zone; double-click
              resets to the default height (VS Code convention). */}
          {task && historyOpen && (
            <div
              onMouseDown={handleHistoryResizeStart}
              onDoubleClick={handleHistoryResizeReset}
              className={`relative h-1 flex-shrink-0 cursor-row-resize transition-colors ${isResizingHistory ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize - double-click to reset"
              data-testid="changes-history-resize"
            >
              <span className="absolute inset-x-0 -inset-y-1" />
            </div>
          )}

          {/* History: the commit browser, collapsed to its header row by default.
              Only when a `task` is provided (the graph needs its PR marker); the
              command-terminal embed stays Uncommitted-only with a plain rail. */}
          {task && (
            <ChangesHistorySection
              open={historyOpen}
              onToggle={handleHistoryToggle}
              bodyHeight={historyHeight}
              commitCount={historyCommitCount}
              truncated={historyTruncated}
              pinnedShortHash={changesSelectedCommit ? (commitHeaderMeta?.shortHash ?? changesSelectedCommit.slice(0, 7)) : null}
              animateHeight={!isResizingHistory}
            >
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
                compact
                onLoaded={handleGraphLoaded}
              />
            </ChangesHistorySection>
          )}
        </div>

        {/* Drag handle: widen the file tree to see long branch names / file
            paths. 1px visual line, ~9px invisible hit zone; double-click
            resets to the proportional default width (VS Code convention). */}
        <div
          onMouseDown={handleTreeResizeStart}
          onDoubleClick={handleTreeResizeReset}
          className={`relative w-1 flex-shrink-0 cursor-col-resize transition-colors ${isResizingTree ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize - double-click to reset"
          data-testid="changes-tree-resize"
        >
          <span className="absolute inset-y-0 -inset-x-1" />
        </div>

        {/* Diff viewer - right panel */}
        <div className="flex-1 min-h-0">
          {!selectedFile ? (
            <div className="flex flex-col h-full">
              {/* The toolbar row survives with no file selected, carrying only
                  the controls that still mean something: View options and its
                  "Open settings" footer. Without it a clean worktree had NO
                  route to the diff preferences from inside the Changes surface
                  at all - the whole row lives in DiffViewer, which does not
                  mount until a file is picked, so the user had to already have
                  a change in order to set how changes render. Keeping the row
                  also stops the diff jumping down ~30px the moment the first
                  file is selected. File-specific controls (change navigation,
                  markdown preview, split/inline, blame) are omitted rather than
                  disabled: there is no file for them to act on, so a greyed
                  control would imply one exists and is unavailable. */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge flex-shrink-0" data-testid="diff-toolbar-no-file">
                <div className="ml-auto flex items-center gap-1">
                  <DiffViewOptionsMenu />
                </div>
              </div>
              {/* Three states, not two. An empty diff has nothing to select, so
                  telling the user to pick a file would be a dead end - but
                  during the FIRST fetch the list is empty too, and this pane is
                  now the only voice for emptiness (the rail dropped its
                  duplicate), so an ungated message here would state a false
                  negative beside the rail's skeleton rows. Paint nothing until
                  `loaded`, mirroring FileTreePanel's own gate. */}
              {files.length === 0 ? (
                loaded ? (
                  <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center" data-testid="diff-no-changes">
                    <Check size={22} className="text-fg-disabled" />
                    {/* Naming the scope is what makes ONE message self-explanatory:
                        "No changes" under Working while History shows commits reads
                        as a broken panel, where "No uncommitted changes" points at
                        where to look instead. */}
                    <span className="text-sm text-fg-muted">{emptyDiffMessage}</span>
                  </div>
                ) : (
                  <div className="flex-1" />
                )
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center">
                  <MousePointerClick size={22} className="text-fg-disabled" />
                  <span className="text-sm text-fg-muted">Select a file to view changes</span>
                  {nextFileCombo && (
                    <span className="text-xs text-fg-faint">{nextFileCombo} - next changed file</span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <DiffErrorBoundary>
              <DiffViewer
                original={fileContent?.result.original ?? ''}
                modified={fileContent?.result.modified ?? ''}
                language={fileContent?.result.language ?? 'plaintext'}
                filePath={selectedFile}
                contentFilePath={fileContent?.filePath ?? null}
                // Scoped by what is under review: the same file at the same
                // scrollTop means different CONTENT under a different commit or
                // scope, so each review context remembers its own position
                // instead of restoring one context's offset against another's
                // text.
                scrollKey={`${effectiveScrollKey}:${changesSelectedCommit ?? scope}`}
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
    </div>
  );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {surfaceHeader}
      {/* The review surface: rail (tree + History section) beside the diff. */}
      <div className="flex-1 min-h-0">
        {renderFilesBody()}
      </div>
    </div>
  );
}
