import '../../../../monacoConfig';
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronsLeftRight, ChevronsRightLeft, GitBranch, ArrowUp, ArrowDown, Check, GitCommitHorizontal } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { Tooltip } from '../../../Tooltip';
import { DetachableSurfaceHeader } from '../../../../pop-out/DetachableSurfaceHeader';
import { FileTreePanel } from './FileTreePanel';
import { DiffViewer } from './DiffViewer';
import { DiffViewOptionsMenu } from './DiffViewOptionsMenu';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { ChangesHistorySection, HISTORY_SECTION_HEADER_PX } from './ChangesHistorySection';
import { CommitSelectionBar } from './CommitSelectionBar';
import { CommitGraphPanel, type StaticCommitHistory } from '../graph/CommitGraphPanel';
import { useSessionStore } from '../../../../stores/session-store';
import { useConfigStore } from '../../../../stores/config-store';
import { useToastStore } from '../../../../stores/toast-store';
import { describeIpcError, asSentence } from '../../../../lib/ipc-error';
import { escapeOwnedElsewhere } from '../../../../utils/escape-ownership';
import { POP_OUT_SURFACES } from '../../../../../shared/pop-out';
import { useKeybinding, useFormattedCombo } from '../../../../hooks/useKeybinding';
import { MousePointerClick } from 'lucide-react';
import type { GitBranchSummaryResult, GitCommitGraphCommit, GitDiffFileEntry, GitDiffFilesResult, GitDiffScope, GitFileHistoryCommit, GitTaskChangesResult, Task } from '../../../../../shared/types';
import { DiffContentCache, EMPTY_DIFF_CONTENT, diffContentEqual, fetchDiffContent, type DiffContent } from './diff-content';

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
// When the row is too narrow for both, the rail gives ground first: the outer
// clamp caps it at the row minus DIFF_PANE_DRAG_MIN and the 4px divider, down
// to FILE_TREE_DRAG_MIN. The default 58%-wide window on a 1440px screen gives
// a ~417px row, which used to leave the diff pane 193px.
// The skeleton in TaskDetailBody.tsx mirrors the default clamp - keep in sync.
const RAIL_DEFAULT_WIDTH_CLAMP = 'clamp(160px, clamp(220px, 25%, 420px), calc(100% - 244px))';
const FILE_TREE_DEFAULT_WIDTH = 220;          // drag-state seed before any stored width exists
const FILE_TREE_DRAG_MIN = 160;               // the rail's floor on every path: the default, a drag, a stored width
const DIFF_PANE_DRAG_MIN = 240;               // the diff pane's floor, held while the rail is above its own

// Vertical-split constraints (px) for the History section at the BOTTOM of the
// rail: the section body's height vs the file-tree region above it.
const HISTORY_DEFAULT_HEIGHT = 200;
// Min body height: about 2.5 commit rows at 44px.
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
  /** When provided, the panel shows the commit-history browser (the History
   *  section at the bottom of the rail). The task supplies the graph's PR
   *  marker (pr_number / head_sha). Omitted for the command-terminal Changes
   *  embed, which has no history. */
  task?: Task;
  /**
   * Set for a completed task: what it changed, read from git by
   * `git:taskChanges`. The panel then reads commits only, its range at rest or
   * one commit when selected, never a working tree: no scope control, no
   * fs watcher, no branch summary, no blame and no file history, and History
   * lists exactly the task's commits. The host passes no `worktreePath` and the
   * result's `projectPath`, and shows the empty reasons itself.
   */
  completedChanges?: GitTaskChangesResult;
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
  result: DiffContent;
  generation: number;
}

/** Displayed file content paired with the path it was fetched for. The path
 *  lets the DiffViewer tell whether the original/modified props it received
 *  actually belong to its `filePath` prop (the stale-content window that opens
 *  between a file switch and the new content's fetch resolving). */
interface DisplayedFileContent {
  result: DiffContent;
  filePath: string;
}

export function ChangesPanel({ entityId, isFocused = false, scrollKey, projectPath, worktreePath, baseBranch, emptyMessage, panelMode, onExpand, onCollapse, task, popOutParams, filePopOutParams, completedChanges }: ChangesPanelProps) {
  const { t } = useLingui();
  const effectiveScrollKey = scrollKey ?? entityId;
  const completed = completedChanges ?? null;
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
      <Tooltip label={t`Expand changes`}>
        <button
          onClick={onExpand}
          aria-label={t`Expand changes`}
          className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
          data-testid="changes-expand"
        >
          <ChevronsLeftRight size={16} />
        </button>
      </Tooltip>
    ) : panelMode === 'expanded' && onCollapse ? (
      <Tooltip label={t`Collapse to split view`}>
        <button
          onClick={onCollapse}
          aria-label={t`Collapse to split view`}
          className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
          data-testid="changes-collapse"
        >
          <ChevronsRightLeft size={16} />
        </button>
      </Tooltip>
    ) : null;
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const selectedFile = useSessionStore((state) => state.changesSelectedFile[entityId] ?? null);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);
  const setSelectedFile = useCallback((filePath: string | null) => setChangesSelectedFile(entityId, filePath), [entityId, setChangesSelectedFile]);
  // Selected commit in the history browser. null (the default) means the
  // scope's diff on a live task, and the task's whole change on a completed one.
  // Only offered when a `task` is provided (the history browser needs the
  // graph's PR marker); the command-terminal embed has no history region.
  const changesSelectedCommit = useSessionStore((state) => state.changesSelectedCommit[entityId] ?? null);
  const setChangesSelectedCommitStore = useSessionStore((state) => state.setChangesSelectedCommit);
  // Metadata (subject/author/time) for the selected commit, set on click. On a
  // restored (persisted) selection this starts null, and the selection bar
  // reads the subject from the history's commits once they load.
  const [selectedCommitMeta, setSelectedCommitMeta] = useState<GitCommitGraphCommit | null>(null);
  const handleSelectCommit = useCallback((commit: GitCommitGraphCommit) => {
    setSelectedCommitMeta(commit);
    setChangesSelectedCommitStore(entityId, commit.hash);
  }, [entityId, setChangesSelectedCommitStore]);
  // The selection bar's x and Escape: back to the scope's diff (live) or the
  // task's whole change (completed).
  const handleClearCommit = useCallback(() => {
    setChangesSelectedCommitStore(entityId, null);
  }, [entityId, setChangesSelectedCommitStore]);
  // A per-file history popover row jumps straight to that file's diff at that
  // commit. A per-file history commit has no parent data, so `parents` is
  // filled empty.
  const handleSelectHistoryCommit = useCallback((filePath: string, commit: GitFileHistoryCommit) => {
    setSelectedCommitMeta({ ...commit, parents: [] });
    setChangesSelectedCommitStore(entityId, commit.hash);
    setSelectedFile(filePath);
  }, [entityId, setChangesSelectedCommitStore, setSelectedFile]);
  const [fileContent, setFileContent] = useState<DisplayedFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [branchSummary, setBranchSummary] = useState<GitBranchSummaryResult | null>(null);
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

  // Read once from the completed result. A completed task has no scope, only
  // commits (`liveScope`). With no range and no commit selected its file list
  // is the union of its commits with no single diff behind it, so nothing
  // auto-selects and the diff pane asks for a commit (`noRangeRest`).
  const isCompleted = completed !== null;
  const liveScope = completed ? undefined : scope;
  const noRangeRest = completed !== null && !completed.range && !changesSelectedCommit;

  // Per-file "viewed" marks (per task, session-scoped).
  const viewedFiles = useSessionStore((state) => state.changesViewedFiles[entityId] ?? EMPTY_VIEWED_FILES);
  const toggleChangesFileViewed = useSessionStore((state) => state.toggleChangesFileViewed);
  const handleToggleViewed = useCallback((filePath: string) => {
    toggleChangesFileViewed(entityId, filePath);
  }, [entityId, toggleChangesFileViewed]);

  // Refs for values needed inside callbacks to avoid stale closures
  // and subscription churn on every file selection or re-render. Written on
  // commit (a layout effect, ahead of every passive effect and handler that
  // reads them), never during render, which the compiler rules forbid.
  const selectedFileRef = useRef(selectedFile);
  const filesRef = useRef(files);
  useLayoutEffect(() => {
    selectedFileRef.current = selectedFile;
    filesRef.current = files;
  });

  // Stale-while-revalidate content cache. Each entry stores the fetch result
  // and the generation it was fetched in. When fs.watch fires, the generation
  // increments - stale entries are served immediately while a background
  // refetch runs, so content updates without any loading indicators. Image
  // payloads are budgeted, and the cache evicts the least recently used.
  // Built once by a lazy initializer, never a throwaway per render.
  const [contentCache] = useState(() => new DiffContentCache<ContentCacheEntry>());
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
  // Bumped when a completed task's own files replace the list, so a commit's
  // reply still in flight (the selection was let go of before it landed) is
  // dropped instead of putting that commit's files back.
  const filesFetchGenerationRef = useRef(0);

  const fetchFiles = useCallback(async () => {
    // A completed task at rest already holds its files: the range's diff, or
    // with no range the union of its commits' diffs. Nothing to fetch.
    if (completed && !changesSelectedCommit) {
      filesFetchGenerationRef.current += 1;
      setFiles(completed.files);
      setTotalInsertions(completed.totals?.insertions ?? completed.files.reduce((sum, file) => sum + file.insertions, 0));
      setTotalDeletions(completed.totals?.deletions ?? completed.files.reduce((sum, file) => sum + file.deletions, 0));
      setError(null);
      initialFetchDoneRef.current = true;
      setLoaded(true);
      return;
    }
    if (filesFetchInFlightRef.current) {
      filesFetchPendingRef.current = true;
      return;
    }
    filesFetchInFlightRef.current = true;
    const generation = filesFetchGenerationRef.current;
    try {
      if (!initialFetchDoneRef.current) {
        setError(null);
      }
      const result: GitDiffFilesResult = await window.electronAPI.git.diffFiles({
        worktreePath,
        projectPath,
        baseBranch,
        scope: liveScope,
        commitOid: changesSelectedCommit ?? undefined,
      });
      if (generation !== filesFetchGenerationRef.current) return;
      setFiles(result.files);
      setTotalInsertions(result.totalInsertions);
      setTotalDeletions(result.totalDeletions);
      initialFetchDoneRef.current = true;
      setLoaded(true);
    } catch (fetchError) {
      // Only show errors on initial load - transient failures during live
      // updates (e.g. git lock contention) are silently ignored.
      if (generation === filesFetchGenerationRef.current && !initialFetchDoneRef.current) {
        setError(fetchError instanceof Error ? fetchError.message : t`Failed to load diff`);
      }
    } finally {
      filesFetchInFlightRef.current = false;
      if (filesFetchPendingRef.current) {
        filesFetchPendingRef.current = false;
        void fetchFilesRef.current();
      }
    }
  }, [worktreePath, projectPath, baseBranch, liveScope, changesSelectedCommit, completed, t]);

  // What one file's content is read against: the selected commit, else a
  // completed task's range, else the live scope.
  const contentRange = !changesSelectedCommit ? (completed?.range ?? undefined) : undefined;

  const fetchFileContent = useCallback(async (filePath: string) => {
    // Key the cache by selection (commit OID, range or scope) so a file's diffs
    // never bleed across a scope switch or a different commit selection.
    const cacheKey = changesSelectedCommit
      ? `commit:${changesSelectedCommit}:${filePath}`
      : contentRange
        ? `range:${contentRange.base}..${contentRange.head}:${filePath}`
        : `scope:${scope}:${filePath}`;
    const cached = contentCache.get(cacheKey);
    if (cached) {
      // Always serve cached content immediately (stale-while-revalidate)
      setFileContent({ result: cached.result, filePath });
      if (cached.generation === cacheGenerationRef.current) {
        return; // Fresh entry - no refetch needed
      }
      // Stale entry - show cached content now, refetch in background. The
      // cached result is this same file and selection (the cache key), so its
      // image fingerprints let main skip resending an image that did not change.
      const currentGeneration = cacheGenerationRef.current;
      const fileEntry = filesRef.current.find((entry) => entry.path === filePath);
      fetchDiffContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: fileEntry?.status ?? 'M',
        oldPath: fileEntry?.oldPath,
        scope: liveScope,
        commitOid: changesSelectedCommit ?? undefined,
        range: contentRange,
      }, fileEntry?.binary ?? false, cached.result).then((freshResult) => {
        contentCache.set(cacheKey, { result: freshResult, generation: currentGeneration });
        // Only update UI if this file is still selected and content actually
        // changed. Images compare byte for byte (diffContentEqual), so a
        // regenerated screenshot repaints even when its text is empty both times.
        if (selectedFileRef.current === filePath && !diffContentEqual(freshResult, cached.result)) {
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
      const result = await fetchDiffContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: file.status,
        oldPath: file.oldPath,
        scope: liveScope,
        commitOid: changesSelectedCommit ?? undefined,
        range: contentRange,
      }, file.binary);
      contentCache.set(cacheKey, { result, generation: cacheGenerationRef.current });
      // Guard against a slow fetch resolving after the user switched away: only
      // display this result if its file is still selected, mirroring the
      // background-refetch path above.
      if (selectedFileRef.current === filePath) {
        setFileContent({ result, filePath });
      }
    } catch {
      if (selectedFileRef.current === filePath) {
        setFileContent({ result: EMPTY_DIFF_CONTENT, filePath });
      }
    }
  }, [worktreePath, projectPath, baseBranch, changesSelectedCommit, contentCache, contentRange, liveScope, scope]);

  // Lightweight, local-only branch context for the header (name, ahead/behind).
  // Cheap enough to re-run on every fs.watch fire and manual refresh, unlike
  // the Done-dialog pending-changes probe. A completed task has no checkout to
  // ask: its header is built from its result below.
  const fetchBranchSummary = useCallback(async () => {
    if (completed) return;
    try {
      const summary = await window.electronAPI.git.branchSummary({ worktreePath, projectPath, baseBranch });
      setBranchSummary(summary);
    } catch {
      // Best-effort context: leave the previous summary in place on failure.
    }
  }, [worktreePath, projectPath, baseBranch, completed]);

  // Stable refs for fetch callbacks - used in the subscription effect and
  // handleSelectFile to avoid re-subscribing or re-creating on every render.
  const fetchFilesRef = useRef(fetchFiles);
  const fetchFileContentRef = useRef(fetchFileContent);
  const fetchBranchSummaryRef = useRef(fetchBranchSummary);
  // Selection ref for the fs.watch subscription effect below, which must not
  // re-subscribe on every commit-selection change (see that effect's comment).
  const selectedCommitRef = useRef(changesSelectedCommit);
  const completedRef = useRef(completed);
  // All written on commit, in a layout effect that runs ahead of the passive
  // effects below that read them; never during render.
  useLayoutEffect(() => {
    fetchFilesRef.current = fetchFiles;
    fetchFileContentRef.current = fetchFileContent;
    fetchBranchSummaryRef.current = fetchBranchSummary;
    selectedCommitRef.current = changesSelectedCommit;
    completedRef.current = completed;
  });

  // Adoption signal, once per mount. Every host gates this component on a
  // state the user put it in (TaskDetailBody's changesPresent,
  // CommandTerminalWindow's changesOpen, the standalone dialog's own open
  // state, the existence of the pop-out window), so a mount is always a real
  // open, including the one a restore replays. That matters because main
  // dedups BOTH events this sends: feature_used once per UTC day, and
  // feature_first_use once per INSTALL, which a mount with no real open behind
  // it would burn for good. One effect covers all four hosts.
  useEffect(() => {
    window.electronAPI?.analytics?.trackFeatureUsed('changes_panel');
  }, []);

  // Fetch file list + branch context on mount, and re-fetch whenever the scope,
  // base branch, commit selection or a completed task's result changes.
  useEffect(() => {
    fetchFilesRef.current();
    fetchBranchSummaryRef.current();
  }, [worktreePath, projectPath, baseBranch, scope, changesSelectedCommit, completed]);

  // Truthful `behind`: without a fetch, the counts only reflect the last time
  // anyone fetched, so a branch can read "0 behind" while origin has moved on.
  // refreshRemote makes the HANDLER run the throttled all-remotes fetch first
  // (5s budget, never rejects). One remote-refreshed summary per panel
  // identity (worktreePath / projectPath / baseBranch), NOT per scope or
  // commit-selection change - browsing commits must never re-fetch the
  // network. Runs after the flagless mount fetch above, so the header shows
  // the cheap local counts immediately and corrects them within the probe
  // budget (or silently keeps them when offline). The fetch is inline rather
  // than a callback, so a result that lands after the identity has moved on
  // is dropped instead of overwriting the next identity's summary.
  // hmr-safe: a Vite Fast Refresh remount re-runs this like a fresh mount;
  // that is accepted because the handler's fetch is throttled to one real
  // fetch per repo per 30s and never rejects - do not "fix" that throttle
  // window down on the strength of the mount-only comment above.
  // A completed task never fetches: its commits are history, and asking about
  // the main checkout would describe someone else's work.
  useEffect(() => {
    if (isCompleted) return;
    let cancelled = false;
    void (async () => {
      try {
        const summary = await window.electronAPI.git.branchSummary({ worktreePath, projectPath, baseBranch, refreshRemote: true });
        if (!cancelled) setBranchSummary(summary);
      } catch {
        // Best-effort context: leave the previous summary in place on failure.
      }
    })();
    return () => { cancelled = true; };
  }, [worktreePath, projectPath, baseBranch, isCompleted]);

  // Restore content for the persisted selected file after files load.
  // `files` is in the dependency array so this re-evaluates after the initial
  // fetchFiles completes and flips initialFetchDoneRef (refs don't trigger renders).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialFetchDoneRef.current) return;
    // A file opens through the newest commit that touched it
    // (handleSelectFile), so nothing auto-selects at a no-range rest.
    if (noRangeRest) return;
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
    // Only once `loaded` says the empty list is the answer: a completed task's
    // files arrive synchronously, so the fetch has flipped initialFetchDoneRef
    // in this same effect flush while `files` still holds its first empty
    // value, and clearing here dropped the file a Summary row had just picked.
    if (selectedFile && loaded) setSelectedFile(null);
  }, [files, selectedFile, setSelectedFile, noRangeRest, loaded]);

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
  // Uses refs for selectedFile/files/fetchers to avoid re-subscribing. A
  // completed task reads commits only, so it has nothing on disk to watch.
  useEffect(() => {
    if (isCompleted) return;
    const watchPath = worktreePath ?? projectPath;
    if (!watchPath) return;

    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // Mark all cache entries stale by advancing the generation counter.
      // Entries are not deleted - they're served immediately as stale-while-revalidate.
      cacheGenerationRef.current += 1;
      fetchBranchSummaryRef.current();
      // A selected commit's diff is immutable - skip the file/content refetch
      // while browsing one; only the scope's working-tree diff needs it.
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
  }, [worktreePath, projectPath, isCompleted]);

  const handleSelectFile = useCallback((filePath: string) => {
    // A completed task with no range has no whole-change diff: a file opens
    // through the newest of its commits that touched it, as the Summary's
    // Files card does.
    const completedNow = completedRef.current;
    if (completedNow && !completedNow.range && !selectedCommitRef.current) {
      const entry = completedNow.files.find((file) => file.path === filePath);
      const commit = entry?.newestCommitSha ? completedNow.commits.find((candidate) => candidate.hash === entry.newestCommitSha) : undefined;
      if (commit) {
        setSelectedFile(filePath);
        handleSelectCommit(commit);
      }
      return;
    }
    setSelectedFile(filePath);
    fetchFileContentRef.current(filePath);
  }, [setSelectedFile, handleSelectCommit]);

  // Escape lets go of a selected commit, as the selection bar's x does. Only
  // while one is selected and this panel's window is focused, in the capture
  // phase so it runs before the window's own Escape (which would close the
  // whole task window), and only when nothing nearer owns the key: an open
  // menu, a text field, a terminal, Monaco. See the structural-Escape list in
  // .claude/rules/keybindings-registry.md.
  useEffect(() => {
    if (!changesSelectedCommit || !isFocused) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeOwnedElsewhere(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handleClearCommit();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [changesSelectedCommit, isFocused, handleClearCommit]);

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
  useLayoutEffect(() => {
    taskRef.current = task;
  });
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
          scope: changesSelectedCommit ? undefined : liveScope,
          commitOid: changesSelectedCommit ?? undefined,
          range: contentRange,
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
          // changes-file always declares a cap; the fallback only satisfies the type.
          const maxInstances = POP_OUT_SURFACES['changes-file'].maxInstances ?? 0;
          useToastStore.getState().addToast({
            title: t`Window limit reached`,
            message: t`${plural(maxInstances, {
              one: '# file diff window is open. Close it to open another.',
              other: '# file diff windows are open. Close one to open another.',
            })}`,
            variant: 'info',
          });
        }
      } catch (error) {
        useToastStore.getState().addToast({
          title: t`Couldn't open file diff`,
          message: asSentence(describeIpcError(error, t`The window could not be created.`)),
          variant: 'error',
        });
      }
    })();
  }, [filePopOutTaskId, filePopOutProjectId, changesSelectedCommit, liveScope, projectPath, worktreePath, baseBranch, contentRange, t]);

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
  const railRef = useRef<HTMLDivElement>(null);

  // Track the stored (manual) width in the ref. Fires only when the stored value
  // itself changes - NOT on isResizingTree - so the release does not momentarily
  // re-apply a stale width and snap the panel (the janky double-move). The
  // local state is only rendered while a drag is live, so it is seeded from
  // this ref at drag start rather than synced here (a setState in an effect is
  // the cascading-render shape the compiler rules forbid).
  useLayoutEffect(() => {
    if (storedFileTreeWidth === undefined) return;
    fileTreeWidthRef.current = storedFileTreeWidth;
  }, [storedFileTreeWidth]);

  const handleTreeResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const container = panelRowRef.current;
    if (!container) return;
    setIsResizingTree(true);
    // Start the live width where the rail already is, so the first frame of
    // the drag (before any mousemove) does not jump. Measured, because the
    // default clamp puts the rail anywhere from 160px to 420px and the ref
    // holds only the last stored width.
    const railWidth = railRef.current?.getBoundingClientRect().width;
    if (railWidth) fileTreeWidthRef.current = railWidth;
    setFileTreeWidth(fileTreeWidthRef.current);
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

  // Base-branch badge in the top bar: just the base branch name, tone-coded
  // (see FileTreePanel's baseLabelCustom) so a custom base is what draws the
  // eye - the full "based on / off" sentence lives in the badge's hover
  // tooltip instead of the visible pill. It stays put while a commit is
  // selected: the top bar does not change with the selection.
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const isCustomBase = !!task?.base_branch && task.base_branch !== (defaultBaseBranch || 'main');
  const baseLabel = baseBranch;

  // The top bar's branch context. A completed task's is its result's branch,
  // with no ahead/behind: there is no checkout for those to describe.
  const completedBranchName = completed?.branchName ?? null;
  const headerSummary = useMemo<GitBranchSummaryResult | null>(() => {
    if (!isCompleted) return branchSummary;
    return completedBranchName ? { currentBranch: completedBranchName, ahead: 0, behind: 0, lastCommit: null } : null;
  }, [isCompleted, completedBranchName, branchSummary]);

  // The empty-diff sentence names what was searched. This pane is the only
  // place the surface states emptiness, so a bare "No changes" leaves the user
  // guessing whether the panel failed or they are simply looking at the wrong
  // scope - naming it points at where the changes actually are.
  const emptyDiffMessage = changesSelectedCommit
    ? t`This commit changed no files`
    : completed
      ? t`No files changed`
      : scope === 'staged'
        ? t`No staged changes`
        : scope === 'branch'
          ? t`No changes vs ${baseLabel}`
          : t`No uncommitted changes`;

  // The selected commit's metadata, for the selection bar: set by a click this
  // session, else read from History's commits once they load (a restored
  // selection has no click behind it).
  const commitHeaderMeta = selectedCommitMeta && selectedCommitMeta.hash === changesSelectedCommit ? selectedCommitMeta : null;
  const [historyCommits, setHistoryCommits] = useState<GitCommitGraphCommit[]>([]);
  const selectedCommitInfo = changesSelectedCommit
    ? (commitHeaderMeta ?? historyCommits.find((commit) => commit.hash === changesSelectedCommit) ?? null)
    : null;

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

  // History section state: the collapsed flag (per task, persisted only when
  // collapsed - open is the default) and the open body's height, both mirroring
  // the file-tree width pattern above. The section lives at the BOTTOM of the
  // rail column, so the drag math measures up from the rail's bottom edge.
  const historyOpen = useSessionStore((state) => !state.changesHistoryCollapsed[entityId]);
  const setChangesHistoryOpen = useSessionStore((state) => state.setChangesHistoryOpen);
  const handleHistoryToggle = useCallback(() => {
    // A toggle: a collapsed section opens, an open one collapses.
    const isCollapsed = Boolean(useSessionStore.getState().changesHistoryCollapsed[entityId]);
    setChangesHistoryOpen(entityId, isCollapsed);
  }, [entityId, setChangesHistoryOpen]);
  // Commit count for the section header, reported by the (possibly hidden)
  // graph panel so the collapsed header stays informative.
  const [historyCommitCount, setHistoryCommitCount] = useState<number | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const handleGraphLoaded = useCallback((commits: GitCommitGraphCommit[], truncated: boolean) => {
    setHistoryCommitCount(commits.length);
    setHistoryTruncated(truncated);
    setHistoryCommits(commits);
  }, []);
  // A completed task's History is its own commits, handed to the graph whole.
  const staticHistory = useMemo<StaticCommitHistory | undefined>(
    () => (completed ? { commits: completed.commits, truncated: completed.truncated, webProviderName: completed.webProviderName } : undefined),
    [completed],
  );
  const storedHistoryHeight = useSessionStore((state) => state.changesHistoryHeight[entityId]);
  const setChangesHistoryHeightStore = useSessionStore((state) => state.setChangesHistoryHeight);
  // The live height while a drag is in flight; the stored height otherwise.
  // Derived rather than synced from the store in an effect (the
  // cascading-render shape the compiler rules forbid). The ref carries the
  // latest value for the release handler, which commits it to the store.
  const [liveHistoryHeight, setLiveHistoryHeight] = useState<number>(storedHistoryHeight ?? HISTORY_DEFAULT_HEIGHT);
  const historyHeightRef = useRef<number>(storedHistoryHeight ?? HISTORY_DEFAULT_HEIGHT);
  const [isResizingHistory, setIsResizingHistory] = useState(false);
  const historyHeight = isResizingHistory ? liveHistoryHeight : (storedHistoryHeight ?? HISTORY_DEFAULT_HEIGHT);

  useLayoutEffect(() => {
    if (storedHistoryHeight === undefined) return;
    historyHeightRef.current = storedHistoryHeight;
  }, [storedHistoryHeight]);

  const handleHistoryResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const container = railRef.current;
    if (!container) return;
    setIsResizingHistory(true);
    // Start the live height where the section already is, so the first frame
    // of the drag (before any mousemove) does not jump.
    setLiveHistoryHeight(historyHeightRef.current);
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
      setLiveHistoryHeight(next);
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
    historyHeightRef.current = HISTORY_DEFAULT_HEIGHT;
  }, [setChangesHistoryHeightStore, entityId]);

  // Shared detachable-surface header (task-detail embed only): the panel's true
  // first row, above the commit-history region. It also OWNS the branch context
  // (branch + base badge + ahead/behind) that the file-tree's BranchHeader shows
  // in the other embeds - the embed passes showBranchHeader=false to that so the
  // row is not duplicated. No PR link and no last commit, in any host: the PR
  // opens from the task window's menu, the cards and a completed task's strip,
  // and the commits are History's. Panel-level actions (expand-full) and the
  // pop-out control sit on the right - the one predictable home for pop-out
  // across every surface. Diff/git tools stay in the diff toolbar below.
  const fileCount = files.length;
  const surfaceHeaderAhead = headerSummary?.ahead ?? 0;
  const surfaceHeaderBehind = headerSummary?.behind ?? 0;
  // Review progress (n/m viewed) in the surface header, hidden until the first
  // mark. Deliberately duplicates the rail's changes-viewed-count: this one is
  // the at-a-glance summary that survives the rail scrolling or a maximized
  // diff; the rail's stays with the list it describes.
  const viewedCount = useMemo(
    () => files.reduce((count, file) => (viewedFiles.has(file.path) ? count + 1 : count), 0),
    [files, viewedFiles],
  );
  const surfaceHeaderViewed = files.length > 0 && viewedCount > 0 ? (
    <Tooltip label={t`${viewedCount} of ${plural(fileCount, { one: '# file marked viewed', other: '# files marked viewed' })}`}>
      <span
        className="flex items-center gap-1 text-[11px] text-fg-muted tabular-nums flex-shrink-0"
        data-testid="changes-header-viewed"
      >
        <Check size={12} className={viewedCount === files.length ? 'text-green-400' : 'text-fg-faint'} />
        {viewedCount}/{files.length}
      </span>
    </Tooltip>
  ) : null;
  const surfaceHeader = popOutParams ? (
    <DetachableSurfaceHeader kind="changes" params={popOutParams} actions={<>{surfaceHeaderViewed}{expandCollapseControl}</>}>
      <GitBranch size={14} className="text-fg-muted flex-shrink-0" aria-hidden />
      <Tooltip label={headerSummary?.currentBranch ?? ''}>
        <span
          className="text-xs font-medium text-fg-secondary truncate flex-shrink-0 max-w-[45%]"
          data-testid="changes-branch-name"
        >
          {headerSummary?.currentBranch ?? t({ message: 'Changes', context: 'tab' })}
        </span>
      </Tooltip>
      {baseLabel && (
        <Tooltip label={isCustomBase ? t`Based on ${baseLabel}, not the project default` : t`Based on ${baseLabel}, the project default`}>
          <span
            className={`shrink-0 rounded border px-1 py-px text-[11px] font-medium leading-none ${
              isCustomBase ? 'border-accent/50 text-accent-fg' : 'border-edge-subtle text-fg-faint'
            }`}
            data-testid="changes-base-label"
          >
            {baseLabel}
          </span>
        </Tooltip>
      )}
      {(surfaceHeaderAhead > 0 || surfaceHeaderBehind > 0) && (
        <Tooltip label={t`${surfaceHeaderAhead} ahead, ${surfaceHeaderBehind} behind base branch`}>
          <span className="flex items-center gap-1.5 text-fg-muted flex-shrink-0 text-[11px]" data-testid="changes-ahead-behind">
            {surfaceHeaderAhead > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums"><ArrowUp size={11} className="text-green-400" />{surfaceHeaderAhead}</span>
            )}
            {surfaceHeaderBehind > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums"><ArrowDown size={11} className="text-red-400" />{surfaceHeaderBehind}</span>
            )}
          </span>
        </Tooltip>
      )}
    </DetachableSurfaceHeader>
  ) : null;

  // The detail pane (error / empty / two-pane), scoped to the current
  // selection (the scope, a completed task's change, or a commit). Rendered as
  // a helper so the history region above stays mounted regardless of which
  // branch renders below.
  const renderFilesBody = (): React.ReactNode => {
  // The selected commit, in the slot the scope control holds (FileTreePanel's
  // `selection`), so selecting swaps that slot's content instead of inserting
  // a row; the error / empty branches below render it standalone.
  const selectionBar = changesSelectedCommit ? (
    <div className={pinSwapFade ? 'rail-slot-in' : undefined}>
      <CommitSelectionBar
        shortHash={selectedCommitInfo?.shortHash ?? changesSelectedCommit.slice(0, 7)}
        subject={selectedCommitInfo?.subject ?? null}
        backLabel={completed ? t`Back to all changes` : scope === 'staged' ? t`Back to Staged` : scope === 'branch' ? t`Back to Branch` : t`Back to Working`}
        onClose={handleClearCommit}
      />
    </div>
  ) : null;
  const standaloneSelectionBar = selectionBar ? (
    <div className="flex-shrink-0 border-b border-edge px-2 py-1.5">{selectionBar}</div>
  ) : null;

  if (error) {
    return (
      <div className="flex flex-col h-full">
        {standaloneSelectionBar}
        <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4">
          <span className="text-xs text-red-400">{error}</span>
          <button
            onClick={fetchFiles}
            className="text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
          >
            <Trans>Retry</Trans>
          </button>
        </div>
      </div>
    );
  }

  if (emptyMessage && loaded && files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {standaloneSelectionBar}
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
          <div className="flex-1 min-h-0">
            <FileTreePanel
              files={files}
              selectedFile={selectedFile}
              onSelect={handleSelectFile}
              totalInsertions={totalInsertions}
              totalDeletions={totalDeletions}
              // The top bar does not change with the selection.
              branchSummary={headerSummary}
              showBranchHeader={!popOutParams}
              viewedFiles={viewedFiles}
              onToggleViewed={handleToggleViewed}
              // A completed task has no scope control; a live one hides it while
              // a commit is selected, and the selection bar takes its slot.
              scope={changesSelectedCommit ? undefined : liveScope}
              onScopeChange={changesSelectedCommit || isCompleted ? undefined : handleScopeChange}
              selection={selectionBar}
              baseLabel={baseLabel}
              baseLabelCustom={isCustomBase}
              loaded={loaded}
              // A completed task's files are history, maybe nowhere on disk:
              // no open / reveal, and no per-file history over a checkout.
              worktreePath={completed ? undefined : worktreePath}
              projectPath={completed ? undefined : projectPath}
              onSelectHistoryCommit={completed ? undefined : handleSelectHistoryCommit}
              onOpenInNewWindow={filePopOutParams && task && !noRangeRest ? handleOpenFileWindow : undefined}
            />
          </div>

          {/* Drag handle: resize the History body vs. the tree region above.
              Rendered only while the section is open (a collapsed header is not
              resizable). 1px visual line, ~9px invisible hit zone; double-click
              resets to the default height (VS Code convention). */}
          {task && historyOpen && (
            <Tooltip label={t`Drag to resize`} detail={t`Double-click to reset`}>
              <div
                onMouseDown={handleHistoryResizeStart}
                onDoubleClick={handleHistoryResizeReset}
                className={`relative h-1 flex-shrink-0 cursor-row-resize transition-colors ${isResizingHistory ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t`Resize history`}
                data-testid="changes-history-resize"
                // The drag state as DATA, not just as a Tailwind class. A drag
                // test that dispatches moves straight after mousedown races the
                // handler installing its document listeners, and under CI load
                // the early moves land on nothing - the resize then commits the
                // untouched default and the test fails once, then passes on
                // retry. Polling this attribute is the "wait for the condition"
                // the cross-platform rule asks for.
                data-resizing={isResizingHistory ? 'true' : 'false'}
              >
                <span className="absolute inset-x-0 -inset-y-1" />
              </div>
            </Tooltip>
          )}

          {/* History: the commit browser, open by default. Only when a `task`
              is provided (the graph needs its PR marker); the command-terminal
              embed has a plain rail. */}
          {task && (
            <ChangesHistorySection
              open={historyOpen}
              onToggle={handleHistoryToggle}
              bodyHeight={historyHeight}
              commitCount={historyCommitCount}
              truncated={historyTruncated}
              countScope={completed ? 'task' : undefined}
              animateHeight={!isResizingHistory}
            >
              <CommitGraphPanel
                projectPath={projectPath}
                worktreePath={worktreePath}
                baseBranch={baseBranch}
                task={task}
                isFocused={isFocused}
                onSelectCommit={handleSelectCommit}
                selectedCommit={changesSelectedCommit}
                compact
                staticHistory={staticHistory}
                onLoaded={handleGraphLoaded}
              />
            </ChangesHistorySection>
          )}
        </div>

        {/* Drag handle: widen the file tree to see long branch names / file
            paths. 1px visual line, ~9px invisible hit zone; double-click
            resets to the proportional default width (VS Code convention). */}
        <Tooltip label={t`Drag to resize`} detail={t`Double-click to reset`}>
          <div
            onMouseDown={handleTreeResizeStart}
            onDoubleClick={handleTreeResizeReset}
            className={`relative w-1 flex-shrink-0 cursor-col-resize transition-colors ${isResizingTree ? 'bg-accent' : 'bg-edge hover:bg-accent/50'}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t`Resize file list`}
            data-testid="changes-tree-resize"
            // Same drag-state signal as the history resizer above.
            data-resizing={isResizingTree ? 'true' : 'false'}
          >
            <span className="absolute inset-y-0 -inset-x-1" />
          </div>
        </Tooltip>

        {/* Diff viewer - right panel. min-w-0 lets it shrink to the divider's
            DIFF_PANE_DRAG_MIN instead of to its toolbar's full content width,
            which pushed a narrow pane past the window's right edge. */}
        <div className="flex-1 min-h-0 min-w-0">
          {!selectedFile || noRangeRest ? (
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
              {noRangeRest ? (
                // The task's commits did not land as one run, so there is no
                // single diff of all of them: each commit is its own.
                <div className="flex flex-col items-center justify-center flex-1 gap-2 p-4 text-center" data-testid="diff-select-commit">
                  <GitCommitHorizontal size={22} className="text-fg-disabled" />
                  <span className="text-sm text-fg-muted"><Trans>Select a commit to see its changes</Trans></span>
                </div>
              ) : files.length === 0 ? (
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
                  <span className="text-sm text-fg-muted"><Trans>Select a file to view changes</Trans></span>
                  {nextFileCombo && (
                    <span className="text-xs text-fg-faint"><Trans>{nextFileCombo} - next changed file</Trans></span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <DiffErrorBoundary>
              <DiffViewer
                original={fileContent?.result.text.original ?? ''}
                modified={fileContent?.result.text.modified ?? ''}
                language={fileContent?.result.text.language ?? 'plaintext'}
                image={fileContent?.result.image ?? null}
                filePath={selectedFile}
                contentFilePath={fileContent?.filePath ?? null}
                // Scoped by what is under review: the same file at the same
                // scrollTop means different CONTENT under a different commit or
                // scope, so each review context remembers its own position
                // instead of restoring one context's offset against another's
                // text.
                scrollKey={`${effectiveScrollKey}:${changesSelectedCommit ?? (completed ? 'range' : scope)}`}
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
                // Blame reads the working tree's file, so never for a commit,
                // a completed task, or the staged scope.
                blameEligible={!changesSelectedCommit && !completed && scope !== 'staged'}
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
