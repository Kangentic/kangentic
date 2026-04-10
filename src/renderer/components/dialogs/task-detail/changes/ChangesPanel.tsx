import '../../../../monacoConfig';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { FileTreePanel } from './FileTreePanel';
import { DiffViewer } from './DiffViewer';
import { useSessionStore } from '../../../../stores/session-store';
import type { GitDiffFileEntry, GitDiffFilesResult, GitFileContentResult } from '../../../../../shared/types';

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
  projectPath: string;
  worktreePath?: string;
  baseBranch: string;
  /** When set, shown instead of the two-pane layout if the branch has zero changed files. */
  emptyMessage?: string;
}

interface ContentCacheEntry {
  result: GitFileContentResult;
  generation: number;
}

export function ChangesPanel({ entityId, projectPath, worktreePath, baseBranch, emptyMessage }: ChangesPanelProps) {
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const selectedFile = useSessionStore((state) => state.changesSelectedFile[entityId] ?? null);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);
  const setSelectedFile = useCallback((filePath: string | null) => setChangesSelectedFile(entityId, filePath), [entityId, setChangesSelectedFile]);
  const [fileContent, setFileContent] = useState<GitFileContentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<'split' | 'inline'>('split');

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
  }, [worktreePath, projectPath, baseBranch]);

  const fetchFileContent = useCallback(async (filePath: string) => {
    const cached = contentCacheRef.current.get(filePath);
    if (cached) {
      // Always serve cached content immediately (stale-while-revalidate)
      setFileContent(cached.result);
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
      }).then((freshResult) => {
        contentCacheRef.current.set(filePath, { result: freshResult, generation: currentGeneration });
        // Only update UI if this file is still selected and content actually changed
        if (selectedFileRef.current === filePath &&
            (freshResult.original !== cached.result.original || freshResult.modified !== cached.result.modified)) {
          setFileContent(freshResult);
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
      });
      contentCacheRef.current.set(filePath, { result, generation: cacheGenerationRef.current });
      setFileContent(result);
    } catch {
      setFileContent({ original: '', modified: '', language: 'plaintext' });
    }
  }, [worktreePath, projectPath, baseBranch]);

  // Stable refs for fetch callbacks - used in the subscription effect and
  // handleSelectFile to avoid re-subscribing or re-creating on every render.
  const fetchFilesRef = useRef(fetchFiles);
  fetchFilesRef.current = fetchFiles;
  const fetchFileContentRef = useRef(fetchFileContent);
  fetchFileContentRef.current = fetchFileContent;

  // Fetch file list on mount
  useEffect(() => {
    fetchFilesRef.current();
  }, [worktreePath, projectPath, baseBranch]);

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

  const selectedFileEntry = files.find((file) => file.path === selectedFile);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
        <span className="text-xs text-red-400">{error}</span>
        <button
          onClick={fetchFiles}
          className="text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
        >
          Retry
        </button>
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
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 flex">
        {/* File tree - left panel */}
        <div className="w-[220px] flex-shrink-0 border-r border-edge overflow-hidden">
          <FileTreePanel
            files={files}
            selectedFile={selectedFile}
            onSelect={handleSelectFile}
            totalInsertions={totalInsertions}
            totalDeletions={totalDeletions}
          />
        </div>

        {/* Diff viewer - right panel */}
        <div className="flex-1 min-h-0">
          {!selectedFile ? (
            <div className="flex items-center justify-center h-full text-xs text-fg-disabled">
              Select a file to view changes
            </div>
          ) : (
            <DiffErrorBoundary>
              <DiffViewer
                original={fileContent?.original ?? ''}
                modified={fileContent?.modified ?? ''}
                language={fileContent?.language ?? 'plaintext'}
                filePath={selectedFile}
                status={selectedFileEntry?.status ?? 'M'}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                binary={selectedFileEntry?.binary ?? false}
              />
            </DiffErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
