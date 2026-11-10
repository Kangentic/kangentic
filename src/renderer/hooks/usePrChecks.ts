import { useCallback, useEffect, useRef, useState } from 'react';
import type { PRChecks, Task } from '../../shared/types';

/** While any check is pending, re-read this often (the PR refresh's own in-flight re-poll). */
const PENDING_POLL_MS = 30_000;
/** Two surfaces of one task window (the header count, the Pull request section) share one read. */
const SHARED_READ_TTL_MS = 10_000;

interface CachedRead {
  at: number;
  promise: Promise<PRChecks | null>;
}

// hmr-safe: a short-lived cache of a remote read; losing it on a Fast Refresh costs one refetch.
const reads = new Map<string, CachedRead>();

/**
 * One read of a task's checks, shared by every surface that asks with the same
 * `key` within the TTL. The key carries the PR number and its verdict, so a
 * relink or a PR refresh that changes the verdict never gets an answer read
 * before it.
 */
function readChecks(key: string, taskId: string, projectId: string | null, force: boolean): Promise<PRChecks | null> {
  const now = Date.now();
  const cached = reads.get(key);
  if (!force && cached && now - cached.at < SHARED_READ_TTL_MS) return cached.promise;
  // Drop expired entries so the map holds only reads a surface can still share.
  for (const [entryKey, entry] of reads) {
    if (now - entry.at >= SHARED_READ_TTL_MS) reads.delete(entryKey);
  }
  const promise = window.electronAPI.tasks.listPrChecks(taskId, projectId);
  reads.set(key, { at: now, promise });
  // A failed read is not cached, so the next surface or poll asks again.
  promise.catch(() => { if (reads.get(key)?.promise === promise) reads.delete(key); });
  return promise;
}

/** Whether a task's PR can have checks worth reading: linked, numbered, open or draft. */
export function taskHasCheckablePr(task: Task | null | undefined): task is Task & { pr_number: number } {
  return !!task && !!task.pr_url && task.pr_number !== null && (task.pr_state === 'open' || task.pr_state === 'draft');
}

export interface PrChecksState {
  /** The PR's checks; null before the first answer, or when its host lists none. */
  checks: PRChecks | null;
  /** Read again now, past the shared cache (after a send). */
  refresh: () => void;
}

/**
 * The CI checks of `task`'s linked PR, for the Changes panel's Pull request
 * section and the Changes button's count. Reads when the task window shows a task with
 * an open or draft PR, again when the PR's link or verdict changes (the PR
 * refresh rewrites the row, and the deps below see it), and every 30 s while a
 * check is pending. A task with no such PR reads nothing. A failed read keeps
 * the last answer for the same PR.
 */
export function usePrChecks(task: Task | null | undefined, projectId: string | null): PrChecksState {
  // Keyed by the PR the answer is for, so a window that switches task or PR
  // never shows the previous one's checks while the new read is in flight.
  const [answer, setAnswer] = useState<{ key: string; checks: PRChecks | null } | null>(null);
  const [forceToken, setForceToken] = useState(0);
  const lastForceToken = useRef(0);
  const enabled = taskHasCheckablePr(task);
  const taskId = task?.id ?? null;
  const prNumber = task?.pr_number ?? null;
  const readiness = task?.pr_merge_readiness ?? null;
  const prState = task?.pr_state ?? null;
  const answerKey = `${projectId ?? ''}\u0000${taskId ?? ''}\u0000${prNumber ?? ''}`;
  const readKey = `${answerKey}\u0000${prState ?? ''}\u0000${readiness ?? ''}`;

  useEffect(() => {
    if (!enabled || !taskId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (force: boolean): void => {
      readChecks(readKey, taskId, projectId, force).then(
        (result) => {
          if (cancelled) return;
          setAnswer({ key: answerKey, checks: result });
          // The poll goes through the shared cache: both surfaces got this same
          // promise, so their timers fire together and the second one is a hit.
          if (result?.checks.some((check) => check.status === 'pending')) {
            timer = setTimeout(() => run(false), PENDING_POLL_MS);
          }
        },
        () => undefined,
      );
    };
    const force = forceToken !== lastForceToken.current;
    lastForceToken.current = forceToken;
    run(force);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, taskId, projectId, forceToken, answerKey, readKey]);

  const refresh = useCallback(() => setForceToken((value) => value + 1), []);
  const current = enabled && answer?.key === answerKey ? answer : null;
  return { checks: current?.checks ?? null, refresh };
}

/** How many things on the PR an agent could fix: each failed check, plus a conflict. */
export function prFixCount(task: Task | null | undefined, checks: PRChecks | null): number {
  if (!taskHasCheckablePr(task)) return 0;
  const failed = checks ? checks.checks.filter((check) => check.status === 'failed').length : 0;
  return failed + (task.pr_merge_readiness === 'conflicting' ? 1 : 0);
}
