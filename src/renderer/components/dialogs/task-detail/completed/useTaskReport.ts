import { useCallback, useEffect, useState } from 'react';
import { asSentence, describeIpcError } from '../../../../lib/ipc-error';
import type { GitTaskChangesResult, TaskLastMessage, TaskReport } from '../../../../../shared/types';

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
 * What the completed task changed, from git (`git:taskChanges`): its range,
 * commits and files, shared by the header strip, the Summary and the Changes
 * tab. Read once per task; `error` is set when the read failed (the index was
 * restarting, or the project's repository is unreadable), and `retry` reads
 * again.
 */
export function useTaskChanges(projectId: string, taskId: string): {
  changes: GitTaskChangesResult | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<{ key: string; changes: GitTaskChangesResult | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}\u0000${taskId}\u0000${attempt}`;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.git.taskChanges({ projectId, taskId })
      .then((changes) => { if (!cancelled) setState({ key, changes, error: null }); })
      .catch((error: unknown) => {
        console.warn('[completed-task] changes read failed:', error);
        if (!cancelled) setState({ key, changes: null, error: asSentence(describeIpcError(error, ''), 'The task\'s changes could not be read.') });
      });
    return () => { cancelled = true; };
  }, [key, projectId, taskId]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  const current = state?.key === key ? state : null;
  return { changes: current?.changes ?? null, loading: current === null, error: current?.error ?? null, retry };
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
