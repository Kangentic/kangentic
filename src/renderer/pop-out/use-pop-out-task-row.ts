import { useEffect, useState } from 'react';
import type { Task } from '../../shared/types';

export interface PopOutTaskRow {
  /** The task row, archived ones included, or null once the read found none. */
  task: Task | null;
  /** The task's OWN project's path, never the one the main window has open. */
  projectPath: string | null;
  /** True until the read for these params has answered. */
  loading: boolean;
}

interface SettledRow {
  key: string;
  task: Task | null;
  projectPath: string | null;
}

/**
 * A task-scoped pop-out's task row, read by its `params` from the task's own
 * project (the monitor's detail read).
 *
 * A pop-out must not take its task from the board store. That store loads the
 * main window's CURRENT project, so a task whose project is backgrounded is not
 * in it, and a fresh window's first board load is thrown away outright: it
 * starts before the window's `currentProject` arrives, and `loadBoard` reads
 * the project changing under it as a switch. See
 * `.claude/rules/pop-out-surface-registry.md`.
 */
export function usePopOutTaskRow(projectId: string, taskId: string): PopOutTaskRow {
  const [settled, setSettled] = useState<SettledRow | null>(null);
  const key = `${projectId}\u0000${taskId}`;
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.monitor.getTaskDetail(projectId, taskId)
      .then((bundle) => {
        if (!cancelled) setSettled({ key, task: bundle?.task ?? null, projectPath: bundle?.projectPath ?? null });
      })
      .catch((error: unknown) => {
        console.warn('[pop-out] task read failed:', error);
        if (!cancelled) setSettled({ key, task: null, projectPath: null });
      });
    return () => { cancelled = true; };
  }, [key, projectId, taskId]);
  const current = settled?.key === key ? settled : null;
  return { task: current?.task ?? null, projectPath: current?.projectPath ?? null, loading: current === null };
}
