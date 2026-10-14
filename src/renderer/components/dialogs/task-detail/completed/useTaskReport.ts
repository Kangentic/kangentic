import { useEffect, useState } from 'react';
import type { TaskLastMessage, TaskReport } from '../../../../../shared/types';

/**
 * The completed task's report, read once per task. `projectId` is the task's
 * own project (the host's), since a completed task can be open from another
 * project's Agent Monitor.
 */
export function useTaskReport(projectId: string, taskId: string): { report: TaskReport | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; report: TaskReport | null } | null>(null);
  const key = `${projectId}\u0000${taskId}`;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.sessions.getTaskReport(projectId, taskId)
      .then((report) => { if (!cancelled) setState({ key, report }); })
      .catch((error: unknown) => {
        console.warn('[completed-task] report read failed:', error);
        if (!cancelled) setState({ key, report: null });
      });
    return () => { cancelled = true; };
  }, [key, projectId, taskId]);

  const current = state?.key === key ? state : null;
  return { report: current?.report ?? null, loading: current === null };
}

/**
 * The agent's last message, read only while `enabled` (no summary is written),
 * so a long transcript is parsed only for a view that shows it.
 */
export function useTaskLastMessage(projectId: string, taskId: string, enabled: boolean): { lastMessage: TaskLastMessage | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; lastMessage: TaskLastMessage | null } | null>(null);
  const key = `${projectId}\u0000${taskId}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    window.electronAPI.sessions.getTaskLastMessage(projectId, taskId)
      .then((lastMessage) => { if (!cancelled) setState({ key, lastMessage }); })
      .catch((error: unknown) => {
        console.warn('[completed-task] last message read failed:', error);
        if (!cancelled) setState({ key, lastMessage: null });
      });
    return () => { cancelled = true; };
  }, [enabled, key, projectId, taskId]);

  const current = state?.key === key ? state : null;
  return { lastMessage: current?.lastMessage ?? null, loading: enabled && current === null };
}
