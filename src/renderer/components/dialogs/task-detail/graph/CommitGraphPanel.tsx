import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Circle } from 'lucide-react';
import { layoutCommitGraph } from '../../../../lib/commit-graph-layout';
import { CommitGraphSvg, ROW_HEIGHT_PX, laneColor } from './CommitGraphSvg';
import { formatRelativeTime } from '../../../../lib/datetime';
import { CountBadge } from '../../../CountBadge';
import type { GitCommitGraphCommit, GitCommitGraphResult, Task } from '../../../../../shared/types';

interface CommitGraphPanelProps {
  projectPath: string;
  worktreePath?: string;
  baseBranch: string;
  task: Task;
  /** Whether the containing task window is focused (unused today; kept for parity with ChangesPanel). */
  isFocused?: boolean;
  /** Fires when the user clicks a commit row - scopes the detail pane to that commit's diff. */
  onSelectCommit: (commit: GitCommitGraphCommit) => void;
  /** Fires when the user clicks the pinned "Uncommitted changes" row - returns the detail pane to the branch-wide working diff. */
  onSelectUncommitted: () => void;
  /** The currently-selected commit OID, or null when "Uncommitted changes" is selected. */
  selectedCommit: string | null;
  /** File count for the working diff, shown on the "Uncommitted changes" row. */
  uncommittedCount: number;
  /**
   * Rail-width rendering (the History section at the bottom of the Changes
   * rail, 200-420px): tighter row padding, the lane gutter capped at
   * {@link COMPACT_MAX_LANES}, and the base / PR RefBadges demoted to tone dots
   * with their labels in tooltips so the subject keeps the width. HEAD keeps
   * its badge - it is the one ref worth ink at this size.
   */
  compact?: boolean;
  /**
   * Fires whenever a graph fetch settles, carrying the commit count (and
   * whether the list hit its cap). Lets the host render the count while the
   * panel itself is mounted-hidden (the collapsed History section).
   */
  onLoaded?: (commitCount: number, truncated: boolean) => void;
}

/** Lane cap for the compact (rail) rendering; lanes beyond this clip. Task
 *  worktree branches are 1-2 lanes, so this only bites merged histories, whose
 *  full graph remains available in the whole-panel pop-out. */
const COMPACT_MAX_LANES = 3;

/** A small ref label chip (HEAD / base branch / PR number) shown on a commit row. */
function RefBadge({ label, tone }: { label: string; tone: 'tip' | 'base' | 'pr' }) {
  const toneClass =
    tone === 'tip'
      ? 'border-active text-active'
      : tone === 'pr'
        ? 'border-edge text-fg-secondary'
        : 'border-edge-subtle text-fg-faint';
  return (
    <span
      data-testid="commit-ref-badge"
      className={`shrink-0 rounded border px-1 py-px text-[11px] font-medium leading-none ${toneClass}`}
    >
      {label}
    </span>
  );
}

export function CommitGraphPanel({
  projectPath,
  worktreePath,
  baseBranch,
  task,
  onSelectCommit,
  onSelectUncommitted,
  selectedCommit,
  uncommittedCount,
  compact = false,
  onLoaded,
}: CommitGraphPanelProps) {
  const [result, setResult] = useState<GitCommitGraphResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const initialFetchDoneRef = useRef(false);

  // Stable ref so a host passing an inline callback never re-triggers fetches.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const fetchGraph = useCallback(async () => {
    try {
      const next = await window.electronAPI.git.commitGraph({ worktreePath, projectPath, baseBranch });
      setResult(next);
      initialFetchDoneRef.current = true;
      setLoaded(true);
      onLoadedRef.current?.(next.commits.length, next.truncated);
    } catch {
      // Best-effort, like ChangesPanel: on a transient live-update failure keep
      // the previous graph; only reveal the empty state if the first load failed.
      if (!initialFetchDoneRef.current) {
        setLoaded(true);
        onLoadedRef.current?.(0, false);
      }
    }
  }, [worktreePath, projectPath, baseBranch]);

  // Stable ref so the subscription effect never re-subscribes on a fetch change.
  const fetchGraphRef = useRef(fetchGraph);
  fetchGraphRef.current = fetchGraph;

  // Fetch on mount and whenever the target directory / base branch changes.
  useEffect(() => {
    fetchGraphRef.current();
  }, [worktreePath, projectPath, baseBranch]);

  // Live refresh via the shared diff fs-watcher. We ONLY register an onDiffChanged
  // listener here - we deliberately do NOT call subscribeDiff / unsubscribeDiff.
  // CommitGraphPanel is always rendered inside ChangesPanel for the same task, and
  // ChangesPanel already arms the fs-watcher for this exact path and keeps it armed
  // for its whole mounted lifetime. DiffWatcher is a single shared watcher per path
  // with no reference count (src/main/git/diff-watcher.ts): if this panel also called
  // unsubscribeDiff on unmount (e.g. a Graph->Files toggle, which unmounts only this
  // child), it would tear down the watcher out from under the still-mounted
  // ChangesPanel and silently stop its live refresh. Listening only, and letting
  // ChangesPanel own subscribe/unsubscribe, avoids that.
  useEffect(() => {
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      fetchGraphRef.current();
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const layout = useMemo(() => layoutCommitGraph(result?.commits ?? []), [result]);

  // Markers derived in the renderer: the tip and base come from the result; the
  // PR-head anchor is the task's persisted head_sha when a PR is linked.
  const tipHash = result?.tipHash ?? null;
  const baseHash = result?.baseHash ?? null;
  const prHash = task.pr_number != null ? task.head_sha : null;

  const isUncommittedSelected = !selectedCommit;
  const rowPadding = compact ? 'px-2' : 'px-3';

  // Pinned top row: the working diff, selectable like any commit. Always
  // rendered regardless of load/empty state, so the branch-wide diff stays one
  // click away even on a brand-new branch with no commits yet.
  const uncommittedRow = (
    <button
      type="button"
      onClick={onSelectUncommitted}
      aria-pressed={isUncommittedSelected}
      data-testid="commit-history-uncommitted"
      data-selected={isUncommittedSelected || undefined}
      className={`flex w-full items-center gap-2 border-b border-edge-subtle ${rowPadding} text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
        isUncommittedSelected ? 'bg-accent/10' : 'hover:bg-surface-hover'
      }`}
      style={{ height: ROW_HEIGHT_PX }}
    >
      <Circle size={9} className={isUncommittedSelected ? 'text-accent' : 'text-fg-faint'} fill="currentColor" />
      <span className={`flex-1 truncate text-xs ${isUncommittedSelected ? 'font-medium text-fg' : 'text-fg-secondary'}`}>
        Uncommitted changes
      </span>
      <CountBadge count={uncommittedCount} variant={isUncommittedSelected ? 'accent' : 'muted'} size="sm" />
    </button>
  );

  if (!loaded) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
        {uncommittedRow}
        {/* Skeleton rows echoing the real anatomy (lane-gutter dot + two text
            lines at ROW_HEIGHT), so the loading paint has the list's shape
            instead of a centered spinner. */}
        <div className="flex-1 overflow-hidden" data-testid="commit-graph-skeleton">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className={`flex items-center gap-2 border-b border-edge-subtle ${rowPadding}`} style={{ height: ROW_HEIGHT_PX, opacity: 1 - index * 0.2 }}>
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-surface-hover animate-pulse" />
              <span className="flex-1 space-y-1.5">
                <span className="block h-3 w-3/4 rounded bg-surface-hover animate-pulse" />
                <span className="block h-2.5 w-1/2 rounded bg-surface-hover animate-pulse" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const commits = result?.commits ?? [];
  if (commits.length === 0) {
    const message = tipHash || result?.currentBranch ? 'No commits on this branch yet.' : 'No git history available.';
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
        {uncommittedRow}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <GitBranch size={22} className="text-fg-disabled" />
          <span className="text-sm text-fg-muted">{message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
      {uncommittedRow}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex">
          <div className="shrink-0 overflow-hidden pl-2" style={{ minHeight: commits.length * ROW_HEIGHT_PX }}>
            <CommitGraphSvg layout={layout} tipHash={tipHash} maxLanes={compact ? COMPACT_MAX_LANES : undefined} />
          </div>
          <div className="min-w-0 flex-1">
            {commits.map((commit, index) => {
              const node = layout.nodes[index];
              const color = node ? laneColor(node.lane) : undefined;
              const isSelected = commit.hash === selectedCommit;
              const isBase = commit.hash === baseHash;
              const isPr = prHash !== null && commit.hash === prHash && task.pr_number != null;
              // Compact rows put the full metadata in the tooltip, since the
              // base / PR refs render as bare dots there.
              const compactTitle = compact
                ? `${commit.shortHash} ${commit.subject}\n${commit.authorName}${isBase ? `\nBase: ${baseBranch}` : ''}${isPr ? `\nPR #${task.pr_number}` : ''}`
                : undefined;
              return (
                <button
                  key={commit.hash}
                  type="button"
                  onClick={() => onSelectCommit(commit)}
                  aria-pressed={isSelected}
                  title={compactTitle}
                  data-testid="commit-graph-row"
                  data-selected={isSelected || undefined}
                  className={`flex w-full flex-col justify-center gap-0.5 border-b border-edge-subtle ${rowPadding} text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                    isSelected ? 'bg-accent/10' : 'hover:bg-surface-hover'
                  }`}
                  style={{ height: ROW_HEIGHT_PX }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px]" style={{ color }}>
                      {commit.shortHash}
                    </span>
                    <span className="truncate text-xs text-fg">{commit.subject}</span>
                    {commit.hash === tipHash && <RefBadge label="HEAD" tone="tip" />}
                    {isBase && (compact ? (
                      <span
                        aria-hidden
                        data-testid="commit-ref-dot-base"
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-fg-faint"
                      />
                    ) : (
                      <RefBadge label={baseBranch} tone="base" />
                    ))}
                    {isPr && (compact ? (
                      <span
                        aria-hidden
                        data-testid="commit-ref-dot-pr"
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    ) : (
                      <RefBadge label={`PR #${task.pr_number}`} tone="pr" />
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
                    <span className="truncate">{commit.authorName}</span>
                    {commit.authorTimestamp && (
                      <>
                        <span aria-hidden>&middot;</span>
                        <span className="shrink-0">{formatRelativeTime(commit.authorTimestamp)}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {result?.truncated && (
        <div className="shrink-0 border-t border-edge-subtle px-3 py-1.5 text-[11px] text-fg-faint">
          Showing latest {commits.length} commits.
        </div>
      )}
    </div>
  );
}
