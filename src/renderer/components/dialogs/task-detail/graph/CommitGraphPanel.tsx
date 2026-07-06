import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, GitBranch } from 'lucide-react';
import { layoutCommitGraph } from '../../../../lib/commit-graph-layout';
import { CommitGraphSvg, ROW_HEIGHT_PX, laneColor } from './CommitGraphSvg';
import { formatRelativeTime } from '../../../../lib/datetime';
import type { GitCommitGraphResult, Task } from '../../../../../shared/types';

interface CommitGraphPanelProps {
  projectPath: string;
  worktreePath?: string;
  baseBranch: string;
  task: Task;
  /** Whether the containing task window is focused (unused today; kept for parity with ChangesPanel). */
  isFocused?: boolean;
}

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

export function CommitGraphPanel({ projectPath, worktreePath, baseBranch, task }: CommitGraphPanelProps) {
  const [result, setResult] = useState<GitCommitGraphResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const initialFetchDoneRef = useRef(false);

  const fetchGraph = useCallback(async () => {
    try {
      const next = await window.electronAPI.git.commitGraph({ worktreePath, projectPath, baseBranch });
      setResult(next);
      initialFetchDoneRef.current = true;
      setLoaded(true);
    } catch {
      // Best-effort, like ChangesPanel: on a transient live-update failure keep
      // the previous graph; only reveal the empty state if the first load failed.
      if (!initialFetchDoneRef.current) setLoaded(true);
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

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="commit-graph-panel">
        <Loader2 size={18} className="animate-spin text-fg-faint" />
      </div>
    );
  }

  const commits = result?.commits ?? [];
  if (commits.length === 0) {
    const message = tipHash || result?.currentBranch ? 'No commits on this branch yet.' : 'No git history available.';
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        data-testid="commit-graph-panel"
      >
        <GitBranch size={22} className="text-fg-disabled" />
        <span className="text-sm text-fg-muted">{message}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex">
          <div className="shrink-0 pl-2" style={{ minHeight: commits.length * ROW_HEIGHT_PX }}>
            <CommitGraphSvg layout={layout} tipHash={tipHash} />
          </div>
          <div className="min-w-0 flex-1">
            {commits.map((commit, index) => {
              const node = layout.nodes[index];
              const color = node ? laneColor(node.lane) : undefined;
              return (
                <div
                  key={commit.hash}
                  className="flex flex-col justify-center gap-0.5 border-b border-edge-subtle px-3"
                  style={{ height: ROW_HEIGHT_PX }}
                  data-testid="commit-graph-row"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px]" style={{ color }}>
                      {commit.shortHash}
                    </span>
                    <span className="truncate text-xs text-fg">{commit.subject}</span>
                    {commit.hash === tipHash && <RefBadge label="HEAD" tone="tip" />}
                    {commit.hash === baseHash && <RefBadge label={baseBranch} tone="base" />}
                    {prHash && commit.hash === prHash && task.pr_number != null && (
                      <RefBadge label={`PR #${task.pr_number}`} tone="pr" />
                    )}
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
                </div>
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
