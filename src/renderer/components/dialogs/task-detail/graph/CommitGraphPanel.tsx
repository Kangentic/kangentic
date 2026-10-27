import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { translateText } from '../../../../i18n/translate';
import { layoutCommitGraph } from '../../../../lib/commit-graph-layout';
import { CommitGraphSvg, ROW_HEIGHT_PX, laneColor } from './CommitGraphSvg';
import { formatRelativeTime } from '../../../../lib/datetime';
import { Tooltip } from '../../../Tooltip';
import { EMPTY_REASON_COPY } from '../completed/CompletedChangesEmpty';
import type { GitCommitGraphCommit, GitCommitGraphResult, Task } from '../../../../../shared/types';

/**
 * A completed task's commits, handed in whole: the panel then fetches nothing,
 * listens to no watcher, and marks no tip, base or PR (there is no checkout
 * whose HEAD they would describe).
 */
export interface StaticCommitHistory {
  commits: GitCommitGraphCommit[];
  truncated: boolean;
  /** Who each commit's `webUrl` opens ("GitHub"), for the hash link's tip. */
  webProviderName: string | null;
}

interface CommitGraphPanelProps {
  projectPath: string;
  worktreePath?: string;
  baseBranch: string;
  task: Task;
  /** Whether the containing task window is focused (unused today; kept for parity with ChangesPanel). */
  isFocused?: boolean;
  /** Fires when the user clicks a commit row - scopes the detail pane to that commit's diff. */
  onSelectCommit: (commit: GitCommitGraphCommit) => void;
  /** The currently-selected commit OID, or null when none is. */
  selectedCommit: string | null;
  /**
   * Rail-width rendering (the History section at the bottom of the Changes
   * rail, 200-420px): tighter row padding, the lane gutter capped at
   * {@link COMPACT_MAX_LANES}, and the base / PR RefBadges demoted to tone dots
   * with their labels in tooltips so the subject keeps the width. HEAD keeps
   * its badge - it is the one ref worth ink at this size.
   */
  compact?: boolean;
  /** Set for a completed task: these commits, as they are, instead of the checkout's graph. */
  staticHistory?: StaticCommitHistory;
  /**
   * Fires whenever the commits settle, with the commits themselves (and
   * whether the list hit its cap). Lets the host render the count while the
   * panel is mounted-hidden (the collapsed History section), and name a
   * restored selection's subject.
   */
  onLoaded?: (commits: GitCommitGraphCommit[], truncated: boolean) => void;
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

/**
 * A commit's short hash. When the commit is on the repository's web host it is
 * its own button that opens the commit there; the row around it selects.
 */
function CommitHash({ commit, color, providerName }: { commit: GitCommitGraphCommit; color: string | undefined; providerName: string | null }) {
  const { t } = useLingui();
  const shortHash = commit.shortHash;
  const webUrl = commit.webUrl ?? null;
  if (!webUrl || !providerName) {
    return <span className="shrink-0 font-mono text-[11px]" style={{ color }}>{commit.shortHash}</span>;
  }
  return (
    <Tooltip label={t`Open on ${providerName}`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void window.electronAPI.shell.openExternal(webUrl);
        }}
        aria-label={t`Open ${shortHash} on ${providerName}`}
        className="pointer-events-auto relative shrink-0 rounded font-mono text-[11px] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        style={{ color }}
        data-testid="commit-hash-link"
      >
        {commit.shortHash}
      </button>
    </Tooltip>
  );
}

export function CommitGraphPanel({
  projectPath,
  worktreePath,
  baseBranch,
  task,
  onSelectCommit,
  selectedCommit,
  compact = false,
  staticHistory,
  onLoaded,
}: CommitGraphPanelProps) {
  const { t } = useLingui();
  const [result, setResult] = useState<GitCommitGraphResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const initialFetchDoneRef = useRef(false);
  const isStatic = staticHistory !== undefined;

  // Stable ref so a host passing an inline callback never re-triggers fetches.
  // Written on commit (a layout effect), never during render.
  const onLoadedRef = useRef(onLoaded);
  useLayoutEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  const fetchGraph = useCallback(async () => {
    try {
      const next = await window.electronAPI.git.commitGraph({ worktreePath, projectPath, baseBranch });
      setResult(next);
      initialFetchDoneRef.current = true;
      setLoaded(true);
      onLoadedRef.current?.(next.commits, next.truncated);
    } catch {
      // Best-effort, like ChangesPanel: on a transient live-update failure keep
      // the previous graph; only reveal the empty state if the first load failed.
      if (!initialFetchDoneRef.current) {
        setLoaded(true);
        onLoadedRef.current?.([], false);
      }
    }
  }, [worktreePath, projectPath, baseBranch]);

  // Stable ref so the subscription effect never re-subscribes on a fetch change.
  // Written on commit (a layout effect, ahead of the passive effects that read
  // it), never during render.
  const fetchGraphRef = useRef(fetchGraph);
  useLayoutEffect(() => {
    fetchGraphRef.current = fetchGraph;
  });

  // Fetch on mount and whenever the target directory / base branch changes.
  // A static history is never fetched.
  useEffect(() => {
    if (isStatic) return;
    fetchGraphRef.current();
  }, [worktreePath, projectPath, baseBranch, isStatic]);

  // A static history reports its commits once per set, as a fetch would.
  useEffect(() => {
    if (!staticHistory) return;
    onLoadedRef.current?.(staticHistory.commits, staticHistory.truncated);
  }, [staticHistory]);

  // Live refresh via the shared diff fs-watcher. We ONLY register an onDiffChanged
  // listener here - we deliberately do NOT call subscribeDiff / unsubscribeDiff.
  // CommitGraphPanel is always rendered inside ChangesPanel for the same task, and
  // ChangesPanel already arms the fs-watcher for this exact path and keeps it armed
  // for its whole mounted lifetime. DiffWatcher is a single shared watcher per path
  // with no reference count (src/main/git/diff-watcher.ts): if this panel also called
  // unsubscribeDiff on unmount (e.g. a Graph->Files toggle, which unmounts only this
  // child), it would tear down the watcher out from under the still-mounted
  // ChangesPanel and silently stop its live refresh. Listening only, and letting
  // ChangesPanel own subscribe/unsubscribe, avoids that. A static history has
  // nothing on disk to watch.
  useEffect(() => {
    if (isStatic) return;
    const unsubscribe = window.electronAPI.git.onDiffChanged(() => {
      fetchGraphRef.current();
    });
    return () => {
      unsubscribe();
    };
  }, [isStatic]);

  const commits = useMemo(() => (staticHistory ? staticHistory.commits : (result?.commits ?? [])), [staticHistory, result]);
  const truncated = staticHistory ? staticHistory.truncated : (result?.truncated ?? false);
  const providerName = staticHistory ? staticHistory.webProviderName : (result?.webProviderName ?? null);
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  const commitCount = commits.length;

  // Markers derived in the renderer: the tip and base come from the result; the
  // PR-head anchor is the task's persisted head_sha when a PR is linked. A
  // static history marks none of them.
  const tipHash = staticHistory ? null : (result?.tipHash ?? null);
  const baseHash = staticHistory ? null : (result?.baseHash ?? null);
  const prHash = !staticHistory && task.pr_number != null ? task.head_sha : null;

  const rowPadding = compact ? 'px-2' : 'px-3';

  if (!isStatic && !loaded) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
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

  if (commits.length === 0) {
    const message = isStatic
      ? translateText(EMPTY_REASON_COPY['no-commits'])
      : tipHash || result?.currentBranch ? t`No commits on this branch yet.` : t`No git history available.`;
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <GitBranch size={22} className="text-fg-disabled" />
          <span className="text-sm text-fg-muted">{message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="commit-graph-panel">
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
              // base / PR refs render as bare dots there: the subject as the
              // label, the author and refs under it.
              const compactTipLabel = compact ? `${commit.shortHash} ${commit.subject}` : '';
              const prNumber = task.pr_number;
              const compactTipDetail = compact
                ? [
                  commit.authorName,
                  ...(isBase ? [t`Base: ${baseBranch}`] : []),
                  ...(isPr ? [t`PR #${prNumber}`] : []),
                ].join('\n')
                : undefined;
              // The row selects through a button stretched across it, and the
              // content above it passes clicks through, except the hash: a link
              // to the commit's web page is its own button, and a button cannot
              // sit inside another.
              return (
                <div
                  key={commit.hash}
                  className={`relative border-b border-edge-subtle transition-colors ${isSelected ? 'bg-accent/10' : 'hover:bg-surface-hover'}`}
                  style={{ height: ROW_HEIGHT_PX }}
                  data-testid="commit-graph-row"
                  data-selected={isSelected || undefined}
                >
                  <Tooltip label={compactTipLabel} detail={compactTipDetail}>
                    <button
                      type="button"
                      onClick={() => onSelectCommit(commit)}
                      aria-pressed={isSelected}
                      aria-label={`${commit.shortHash} ${commit.subject}`}
                      className="absolute inset-0 h-full w-full outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                      data-testid="commit-graph-row-select"
                    />
                  </Tooltip>
                  <div className={`pointer-events-none relative flex h-full flex-col justify-center gap-0.5 ${rowPadding}`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <CommitHash commit={commit} color={color} providerName={providerName} />
                      <span className="truncate text-xs text-fg">{commit.subject}</span>
                      {/* i18n-ok: HEAD is git's own term */}
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
                        <RefBadge label={t`PR #${prNumber}`} tone="pr" />
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
                      <span className="truncate">{commit.authorName}</span>
                      {commit.authorTimestamp && (
                        <>
                          <span aria-hidden>{'·'}</span>
                          <span className="shrink-0">{formatRelativeTime(commit.authorTimestamp)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {truncated && (
        <div className="shrink-0 border-t border-edge-subtle px-3 py-1.5 text-[11px] text-fg-faint">
          {t`Showing latest ${plural(commitCount, { one: '# commit', other: '# commits' })}.`}
        </div>
      )}
    </div>
  );
}
