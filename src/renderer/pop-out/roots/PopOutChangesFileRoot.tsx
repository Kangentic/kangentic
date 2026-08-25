import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import type { PopOutChangesFileParams } from '../../../shared/pop-out';
import type { GitDiffFileEntry, GitFileContentResult } from '../../../shared/types';

const ChangesFileDiffPane = lazy(() =>
  import('./ChangesFileDiffPane').then((module) => ({ default: module.ChangesFileDiffPane })),
);

/** Displayed file content paired with the path it was fetched for, mirroring
 *  ChangesPanel's DisplayedFileContent (DiffViewer's stale-content contract). */
export interface DisplayedFileDiffContent {
  result: GitFileContentResult;
  filePath: string;
}

function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={20} className="animate-spin text-fg-muted" />
    </div>
  );
}

/** The file's list entry as known at open time. insertions/deletions are type
 *  filler, not real counts - nothing downstream reads them (ChangesFileDiffPane
 *  consumes only status/binary). One builder so the entry state's initializer
 *  and the first-fetch seed cannot drift. */
function buildSeedEntry(params: PopOutChangesFileParams): GitDiffFileEntry {
  return {
    path: params.filePath,
    status: params.status,
    oldPath: params.oldPath,
    binary: params.binary,
    insertions: 0,
    deletions: 0,
  };
}

/**
 * Pop-out root for the 'changes-file' surface: ONE file's diff, detached
 * read-only. Resolves EVERYTHING from params - the opener seeds the git paths,
 * the file's list-entry fields, and the task label (see PopOutChangesFileParams)
 * - so, unlike the sibling roots, no store hydration gates the first paint: the
 * content fetch fires on the first render, in parallel with the Monaco-bearing
 * pane chunk (warmed by the surface's bootstrap), and the file-list reconcile
 * runs alongside instead of ahead. One spinner element covers the whole load;
 * the pane mounts only once content exists, so the loading surface never
 * shifts.
 */
export function PopOutChangesFileRoot({ params }: { params: PopOutChangesFileParams }) {
  const { filePath, scope, commitOid, projectPath, worktreePath, baseBranch } = params;
  // The file's current list entry, seeded from params (so the first content
  // fetch needs no preceding diffFiles round trip). null after a reconcile that
  // no longer finds the file = the change was reverted (empty state; the window
  // never auto-closes).
  const [entry, setEntry] = useState<GitDiffFileEntry | null>(() => buildSeedEntry(params));
  const [content, setContent] = useState<DisplayedFileDiffContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Guard out-of-order resolutions: only the newest fetch may commit state.
  const fetchGenerationRef = useRef(0);
  const runFetch = useCallback(async (seedEntry: GitDiffFileEntry | null) => {
    const generation = ++fetchGenerationRef.current;
    const applyContent = async (fileEntry: GitDiffFileEntry) => {
      const result = await window.electronAPI.git.fileContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: fileEntry.status,
        oldPath: fileEntry.oldPath,
        scope,
        commitOid,
      });
      if (generation !== fetchGenerationRef.current) return;
      setContent({ result, filePath });
      setLoadError(null);
    };
    try {
      // Seeded (first) load: content straight off the seed while the list
      // reconciles in parallel. Unseeded (watcher) refetch: list first, content
      // from the fresh entry.
      let seedContentFailed = false;
      const seededContent = seedEntry
        ? applyContent(seedEntry).catch(() => {
            seedContentFailed = true;
          })
        : null;
      const filesResult = await window.electronAPI.git.diffFiles({ worktreePath, projectPath, baseBranch, scope, commitOid });
      if (seededContent) await seededContent;
      if (generation !== fetchGenerationRef.current) return;
      const matched = filesResult.files.find((file) => file.path === filePath) ?? null;
      setEntry(matched);
      if (!matched) {
        // Reverted / no longer changed: the empty state below. Window stays open.
        setContent(null);
        setLoadError(null);
        return;
      }
      const seedMatches = !!seedEntry && seedEntry.status === matched.status && seedEntry.oldPath === matched.oldPath;
      if (!seedMatches || seedContentFailed) await applyContent(matched);
    } catch (error) {
      if (generation !== fetchGenerationRef.current) return;
      // A watcher-triggered refetch failure keeps the last displayed content
      // (ChangesPanel's transient-failure policy); the error line only renders
      // while nothing is displayed yet.
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [worktreePath, projectPath, baseBranch, filePath, scope, commitOid]);

  const seedRef = useRef<GitDiffFileEntry | null>(buildSeedEntry(params));
  useEffect(() => {
    const seed = seedRef.current;
    seedRef.current = null;
    void runFetch(seed);
  }, [runFetch]);

  // Live diff updates, mirroring ChangesPanel's subscription block. The ref
  // keeps the subscription stable across runFetch identity changes. Per-sender
  // refcounting in main (DiffSubscriptionRegistry) keeps this window's teardown
  // from touching the in-app panel's or sibling file windows' watches.
  const runFetchRef = useRef(runFetch);
  runFetchRef.current = runFetch;
  useEffect(() => {
    const watchPath = worktreePath ?? projectPath;
    if (!watchPath) return;
    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // A commit's diff is immutable - no refetch while pinned to one.
      if (!commitOid) void runFetchRef.current(null);
    });
    return () => {
      window.electronAPI.git.unsubscribeDiff(watchPath);
      unsubscribe();
    };
  }, [worktreePath, projectPath, commitOid]);

  if (!entry) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled" data-testid="changes-file-popout-empty">
        No changes for this file
      </div>
    );
  }

  if (loadError && !content) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-400">
        {loadError}
      </div>
    );
  }

  return (
    <PanelErrorBoundary label="File diff">
      {content === null && <CenteredSpinner />}
      <Suspense fallback={content === null ? null : <CenteredSpinner />}>
        {content !== null && (
          <ChangesFileDiffPane
            filePath={filePath}
            entry={entry}
            content={content}
            scope={scope}
            commitOid={commitOid}
            projectPath={projectPath}
            worktreePath={worktreePath}
            scrollKey={params.taskId}
          />
        )}
      </Suspense>
    </PanelErrorBoundary>
  );
}
