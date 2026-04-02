import { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { FileTreePanel } from './FileTreePanel';
import { useSessionStore } from '../../../../stores/session-store';
import { useConfigStore } from '../../../../stores/config-store';
import type { Task, GitDiffFileEntry, GitDiffFilesResult, GitFileContentResult } from '../../../../../shared/types';

const DiffViewer = lazy(() => import('./DiffViewer').then((module) => ({ default: module.DiffViewer })));

interface ChangesPanelProps {
  task: Task;
  projectPath: string;
}

interface ContentCacheEntry {
  result: GitFileContentResult;
  generation: number;
}

export function ChangesPanel({ task, projectPath }: ChangesPanelProps) {
  const [files, setFiles] = useState<GitDiffFileEntry[]>([]);
  const [totalInsertions, setTotalInsertions] = useState(0);
  const [totalDeletions, setTotalDeletions] = useState(0);
  const selectedFile = useSessionStore((state) => state.changesSelectedFile[task.id] ?? null);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);
  const setSelectedFile = useCallback((filePath: string | null) => setChangesSelectedFile(task.id, filePath), [task.id, setChangesSelectedFile]);
  const [fileContent, setFileContent] = useState<GitFileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'inline'>('split');

  const worktreePath = task.worktree_path ?? undefined;
  const defaultBaseBranch = useConfigStore((s) => s.config.git.defaultBaseBranch);
  const baseBranch = task.base_branch || defaultBaseBranch || 'main';

  // Refs for values needed inside the onDiffChanged callback to avoid
  // stale closures and subscription churn on every file selection.
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const filesRef = useRef(files);
  filesRef.current = files;

  // Stale-while-revalidate content cache. Each entry stores the fetch result
  // and the generation it was fetched in. When fs.watch fires, the generation
  // increments - stale entries are served immediately while a background
  // refetch runs, avoiding loading spinners for previously-viewed files.
  const contentCacheRef = useRef(new Map<string, ContentCacheEntry>());
  const cacheGenerationRef = useRef(0);

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
    if (!options?.skipCache) {
      const cached = contentCacheRef.current.get(filePath);
      if (cached) {
        // Always serve cached content immediately (stale-while-revalidate)
        setFileContent(cached.result);
        if (cached.generation === cacheGenerationRef.current) {
          return; // Fresh entry - no refetch needed
        }
        // Stale entry - show cached content now, refetch in background without spinner
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
      contentCacheRef.current.set(filePath, { result, generation: cacheGenerationRef.current });
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

  // Restore content for the persisted selected file after files load
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || loading || !selectedFile) return;
    restoredRef.current = true;
    fetchFileContent(selectedFile);
  }, [loading, selectedFile, fetchFileContent]);

  // Subscribe to live updates via fs.watch.
  // Uses refs for selectedFile/files to avoid re-subscribing on every selection.
  useEffect(() => {
    const watchPath = worktreePath ?? projectPath;
    if (!watchPath) return;

    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // Mark all cache entries stale by advancing the generation counter.
      // Entries are not deleted - they're served immediately as stale-while-revalidate.
      cacheGenerationRef.current += 1;
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
  }, [setSelectedFile, fetchFileContent]);

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
