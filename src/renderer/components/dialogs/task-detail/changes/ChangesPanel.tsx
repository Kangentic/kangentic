import '../../../../monacoConfig';
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { RefreshCw, ChevronsLeftRight, ChevronsRightLeft, Loader2 } from 'lucide-react';
import { FileTreePanel } from './FileTreePanel';
import { DiffViewer } from './DiffViewer';
import { useSessionStore } from '../../../../stores/session-store';
import { useConfigStore } from '../../../../stores/config-store';
import type { GitBranchSummaryResult, GitDiffFileEntry, GitDiffFilesResult, GitDiffScope, GitFileContentResult } from '../../../../../shared/types';

// Stable empty set so a task with no viewed files keeps a referentially-constant
// prop (avoids re-rendering the file tree every render).
const EMPTY_VIEWED_FILES = new Set<string>();

// Scoped error boundary prevents Monaco failures from crashing the entire app.
class DiffErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('DiffViewer error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
          <span className="text-xs text-red-400">
            {this.state.error?.message || 'Failed to load diff viewer'}
          </span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface ChangesPanelProps {
  entityId: string;
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

export function ChangesPanel({ entityId, scrollKey, projectPath, worktreePath, baseBranch, emptyMessage, panelMode, onExpand, onCollapse }: ChangesPanelProps) {
  const effectiveScrollKey = scrollKey ?? entityId;
  // The task-detail embed passes panelMode + a handler; the standalone
  // TaskChangesDialog passes neither, so it never shows these controls. Expand
  // and collapse are mutually exclusive: only one is relevant per mode.
  const panelControls =
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
  // When no diff is mounted (no file selected, empty diff, or a fetch error)
  // the controls have no toolbar to live in, so render a minimal row to keep a
  // pointer-reachable collapse affordance available in expanded mode.
  const fallbackControlsRow = panelControls && (
    <div className="flex items-center justify-end px-3 py-1.5 border-b border-edge flex-shrink-0">
      {panelControls}
    </div>
  );
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const selectedFile = useSessionStore((state) => state.changesSelectedFile[entityId] ?? null);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);
  const setSelectedFile = useCallback((filePath: string | null) => setChangesSelectedFile(entityId, filePath), [entityId, setChangesSelectedFile]);
  const [fileContent, setFileContent] = useState<DisplayedFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [branchSummary, setBranchSummary] = useState<GitBranchSummaryResult | null>(null);
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
  }, [worktreePath, projectPath, baseBranch, scope]);

  const fetchFileContent = useCallback(async (filePath: string) => {
    // Key the cache by scope so a file's working/staged/branch diffs never
    // bleed into one another when the user switches scope.
    const cacheKey = `${scope}:${filePath}`;
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
  }, [worktreePath, projectPath, baseBranch, scope]);

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

  // Stable refs for fetch callbacks - used in the subscription effect and
  // handleSelectFile to avoid re-subscribing or re-creating on every render.
  const fetchFilesRef = useRef(fetchFiles);
  fetchFilesRef.current = fetchFiles;
  const fetchFileContentRef = useRef(fetchFileContent);
  fetchFileContentRef.current = fetchFileContent;
  const fetchBranchSummaryRef = useRef(fetchBranchSummary);
  fetchBranchSummaryRef.current = fetchBranchSummary;

  // Fetch file list + branch context on mount, and re-fetch the list whenever
  // the scope changes (working / staged / branch show different file sets).
  useEffect(() => {
    fetchFilesRef.current();
    fetchBranchSummaryRef.current();
  }, [worktreePath, projectPath, baseBranch, scope]);

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
      fetchFilesRef.current();
      fetchBranchSummaryRef.current();
      const currentFile = selectedFileRef.current;
      if (currentFile) {
        fetchFileContentRef.current(currentFile);
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

  // File-tree width is PER-TASK (session store, keyed by entityId), like the
  // terminal split's dividerRatio: an undefined stored width means auto-fit to the
  // branch name / last commit on open; a drag sets that task's own width. Local
  // state drives live drag feedback.
  const storedFileTreeWidth = useSessionStore((state) => state.changesFileTreeWidth[entityId]);
  const setChangesFileTreeWidth = useSessionStore((state) => state.setChangesFileTreeWidth);
  const [fileTreeWidth, setFileTreeWidth] = useState<number>(storedFileTreeWidth ?? 220);
  const fileTreeWidthRef = useRef<number>(storedFileTreeWidth ?? 220);
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
    const branchNeeded = branchEl ? branchEl.scrollWidth + 100 : 0;
    const commitNeeded = commitEl ? commitEl.scrollWidth + 28 : 0;
    const needed = Math.max(branchNeeded, commitNeeded);
    if (needed > 0) {
      const fit = Math.round(Math.max(220, Math.min(420, container.getBoundingClientRect().width - 280, needed)));
      setFileTreeWidth(fit);
      fileTreeWidthRef.current = fit;
    }
    setAutoFitReady(true);
  }, [branchSummary, storedFileTreeWidth]);

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
      // Keep at least 160px for the tree and 240px for the diff pane.
      const next = Math.max(160, Math.min(rect.width - 240, moveEvent.clientX - rect.left));
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

  const selectedFileEntry = files.find((file) => file.path === selectedFile);

  if (error) {
    return (
      <div className="flex flex-col h-full">
        {fallbackControlsRow}
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
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative">
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
            branchSummary={branchSummary}
            viewedFiles={viewedFiles}
            onToggleViewed={handleToggleViewed}
            scope={scope}
            onScopeChange={handleScopeChange}
            worktreePath={worktreePath}
            projectPath={projectPath}
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
              {fallbackControlsRow}
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
                trailingControls={panelControls ?? undefined}
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
}
