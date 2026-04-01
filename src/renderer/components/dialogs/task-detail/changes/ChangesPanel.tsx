import { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { FileTreePanel } from './FileTreePanel';
import type { Task, GitDiffFileEntry, GitDiffFilesResult, GitFileContentResult } from '../../../../../shared/types';

const DiffViewer = lazy(() => import('./DiffViewer').then((module) => ({ default: module.DiffViewer })));

interface ChangesPanelProps {
  task: Task;
  projectPath: string;
}

export function ChangesPanel({ task, projectPath }: ChangesPanelProps) {
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<GitFileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'inline'>('split');

  const worktreePath = task.worktree_path ?? undefined;
  const baseBranch = task.base_branch ?? 'main';

  // Refs for values needed inside the onDiffChanged callback to avoid
  // stale closures and subscription churn on every file selection.
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const filesRef = useRef(files);
  filesRef.current = files;

  // Cache fetched file content so switching between already-viewed files is instant.
  // Invalidated when fs.watch fires (files on disk changed).
  const contentCacheRef = useRef(new Map<string, GitFileContentResult>());

  const fetchFiles = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result: GitDiffFilesResult = await window.electronAPI.git.diffFiles({
        worktreePath,
        projectPath,
        baseBranch,
      });
      setFiles(result.files);
      setTotalInsertions(result.totalInsertions);
      setTotalDeletions(result.totalDeletions);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  }, [worktreePath, projectPath, baseBranch]);

  const fetchFileContent = useCallback(async (filePath: string, options?: { skipCache?: boolean }) => {
    // Serve from cache if available (instant switching between already-viewed files)
    if (!options?.skipCache) {
      const cached = contentCacheRef.current.get(filePath);
      if (cached) {
        setFileContent(cached);
        return;
      }
    }

    const searchList = filesRef.current;
    const file = searchList.find((entry) => entry.path === filePath);
    if (!file) return;

    try {
      setContentLoading(true);
      const result = await window.electronAPI.git.fileContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: file.status,
        oldPath: file.oldPath,
      });
      contentCacheRef.current.set(filePath, result);
      setFileContent(result);
    } catch {
      setFileContent({ original: '', modified: '', language: 'plaintext' });
    } finally {
      setContentLoading(false);
    }
  }, [worktreePath, projectPath, baseBranch]);

  // Fetch file list on mount
  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Subscribe to live updates via fs.watch.
  // Uses refs for selectedFile/files to avoid re-subscribing on every selection.
  useEffect(() => {
    const watchPath = worktreePath ?? projectPath;
    if (!watchPath) return;

    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // Invalidate content cache since files on disk changed
      contentCacheRef.current.clear();
      fetchFiles();
      const currentFile = selectedFileRef.current;
      if (currentFile) {
        fetchFileContent(currentFile, { skipCache: true });
      }
    });

    return () => {
      window.electronAPI.git.unsubscribeDiff(watchPath);
      unsubscribe();
    };
  }, [worktreePath, projectPath, fetchFiles, fetchFileContent]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    fetchFileContent(filePath);
  }, [fetchFileContent]);

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
            onRefresh={fetchFiles}
            refreshing={loading}
          />
        </div>

        {/* Diff viewer - right panel */}
        <div className="flex-1 min-h-0">
          {!selectedFile ? (
            <div className="flex items-center justify-center h-full text-xs text-fg-disabled">
              Select a file to view changes
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={20} className="animate-spin text-fg-muted" />
                </div>
              }
            >
              <DiffViewer
                original={fileContent?.original ?? ''}
                modified={fileContent?.modified ?? ''}
                language={fileContent?.language ?? 'plaintext'}
                filePath={selectedFile}
                status={selectedFileEntry?.status ?? 'M'}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                loading={contentLoading}
                binary={selectedFileEntry?.binary ?? false}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
