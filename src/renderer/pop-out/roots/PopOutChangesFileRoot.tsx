import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import type { PopOutChangesFileParams } from '../../../shared/pop-out';
import type { GitDiffFileEntry } from '../../../shared/types';
// No Monaco in this module's graph, so the root chunk stays light.
import { fetchDiffContent, type DiffContent, type DiffContentScope } from '../../components/dialogs/task-detail/changes/diff-content';
import { openChangesFileWindow } from '../../components/dialogs/task-detail/changes/open-file-window';
import type { DiffLinkedFiles } from '../../components/dialogs/task-detail/changes/DiffViewer';

const ChangesFileDiffPane = lazy(() =>
  import('./ChangesFileDiffPane').then((module) => ({ default: module.ChangesFileDiffPane })),
);

/** Displayed file content paired with the path it was fetched for, mirroring
 *  ChangesPanel's DisplayedFileContent (DiffViewer's stale-content contract). */
export interface DisplayedFileDiffContent {
  result: DiffContent;
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
  const { t } = useLingui();
  const { filePath, scope, commitOid, range, projectPath, worktreePath, baseBranch } = params;
  // A completed task's file window reads a fixed range, which no edit changes.
  const rangeBase = range?.base;
  const rangeHead = range?.head;
  // The file's current list entry, seeded from params (so the first content
  // fetch needs no preceding diffFiles round trip). null after a reconcile that
  // no longer finds the file = the change was reverted (empty state; the window
  // never auto-closes).
  const [entry, setEntry] = useState<GitDiffFileEntry | null>(() => buildSeedEntry(params));
  const [content, setContent] = useState<DisplayedFileDiffContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The whole file list from the latest reconcile: the files a link in this
  // window's markdown preview can open, each in a window of its own.
  const [listedFiles, setListedFiles] = useState<GitDiffFileEntry[]>([]);

  // Guard out-of-order resolutions: only the newest fetch may commit state.
  const fetchGenerationRef = useRef(0);
  // The last content shown. This window shows one file at one scope, so it is
  // always the same file the next fetch asks for, and its image fingerprints
  // let main skip resending an image that did not change.
  const lastResultRef = useRef<DiffContent | null>(null);
  const runFetch = useCallback(async (seedEntry: GitDiffFileEntry | null) => {
    const generation = ++fetchGenerationRef.current;
    const fetchRange = rangeBase && rangeHead ? { base: rangeBase, head: rangeHead } : undefined;
    const applyContent = async (fileEntry: GitDiffFileEntry) => {
      const result = await fetchDiffContent({
        worktreePath,
        projectPath,
        baseBranch,
        filePath,
        status: fileEntry.status,
        oldPath: fileEntry.oldPath,
        scope,
        commitOid,
        range: fetchRange,
      }, fileEntry.binary, lastResultRef.current);
      if (generation !== fetchGenerationRef.current) return;
      lastResultRef.current = result;
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
      const filesResult = await window.electronAPI.git.diffFiles({ worktreePath, projectPath, baseBranch, scope, commitOid, range: fetchRange });
      if (seededContent) await seededContent;
      if (generation !== fetchGenerationRef.current) return;
      setListedFiles(filesResult.files);
      const matched = filesResult.files.find((file) => file.path === filePath) ?? null;
      setEntry(matched);
      if (!matched) {
        // Reverted / no longer changed: the empty state below. Window stays open.
        lastResultRef.current = null;
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
  }, [worktreePath, projectPath, baseBranch, filePath, scope, commitOid, rangeBase, rangeHead]);

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
  // Written on commit (a layout effect, ahead of the passive effect below),
  // never during render, which the compiler rules forbid.
  useLayoutEffect(() => {
    runFetchRef.current = runFetch;
  });
  const isRange = Boolean(rangeBase && rangeHead);
  useEffect(() => {
    const watchPath = worktreePath ?? projectPath;
    // A range is fixed commits, not a working tree: nothing to watch.
    if (!watchPath || isRange) return;
    window.electronAPI.git.subscribeDiff(watchPath);
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      // A commit's diff is immutable - no refetch while pinned to one.
      if (!commitOid) void runFetchRef.current(null);
    });
    return () => {
      window.electronAPI.git.unsubscribeDiff(watchPath);
      unsubscribe();
    };
  }, [worktreePath, projectPath, commitOid, isRange]);

  // What the diff is read against, for the images the markdown preview loads.
  const contentScope = useMemo<DiffContentScope>(() => ({
    worktreePath,
    projectPath,
    baseBranch,
    scope,
    commitOid,
    range: rangeBase && rangeHead ? { base: rangeBase, head: rangeHead } : undefined,
  }), [worktreePath, projectPath, baseBranch, scope, commitOid, rangeBase, rangeHead]);

  // This window shows one file, so a link to another listed file opens that
  // file in its own window (or focuses the one already open), at this
  // window's scope. Keyed on the paths so a refresh that changed only counts
  // does not re-render the preview; the entry is looked up when the link is
  // followed. NUL joins the paths because no git path holds one.
  const listedFilesRef = useRef(listedFiles);
  useLayoutEffect(() => {
    listedFilesRef.current = listedFiles;
  });
  const listedPathsKey = useMemo(() => listedFiles.map((file) => file.path).join('\0'), [listedFiles]);
  const linkedFiles = useMemo<DiffLinkedFiles>(() => {
    const listedPaths = new Set(listedPathsKey.split('\0'));
    return {
      isListed: (path) => listedPaths.has(path),
      open: (path) => {
        const target = listedFilesRef.current.find((file) => file.path === path);
        if (!target) return;
        void openChangesFileWindow({ ...params, filePath: path, status: target.status, oldPath: target.oldPath, binary: target.binary });
      },
    };
  }, [listedPathsKey, params]);

  if (!entry) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled" data-testid="changes-file-popout-empty">
        <Trans>No changes for this file</Trans>
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
    <PanelErrorBoundary panel="File diff" message={t`Failed to load the File diff`}>
      {content === null && <CenteredSpinner />}
      <Suspense fallback={content === null ? null : <CenteredSpinner />}>
        {content !== null && (
          <ChangesFileDiffPane
            filePath={filePath}
            entry={entry}
            content={content}
            scope={scope}
            commitOid={commitOid}
            isRange={isRange}
            projectPath={projectPath}
            worktreePath={worktreePath}
            scrollKey={params.taskId}
            contentScope={contentScope}
            linkedFiles={linkedFiles}
          />
        )}
      </Suspense>
    </PanelErrorBoundary>
  );
}
