/**
 * "You have worked on something like this before."
 *
 * The Memory Graph is a place you have to remember to visit. This is the same
 * retrieval pointed the other way: while you are reading a task, the index
 * surfaces earlier conversations near it, unprompted. That is the moment the
 * question "have I already figured this out?" actually matters, and the moment
 * a search box is least likely to get typed into.
 *
 * Deliberately quiet. It renders NOTHING when there is nothing to say - no
 * empty state, no spinner, no header - because a permanent empty panel on every
 * task would be worse than the feature's absence. It only earns its space when
 * it has a real answer.
 */

import { useEffect, useState } from 'react';
import { History, ChevronDown, ChevronRight } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import type { MemoryGraphQueryHit } from '../../../shared/types';

export interface TaskPriorWorkProps {
  taskId: string;
  projectId: string | null;
}

/** Collapsed by default: the task's own content is what the user opened the
 *  detail to read, and this must not push it down the page. */
const DEFAULT_EXPANDED = false;

export function TaskPriorWork({ taskId, projectId }: TaskPriorWorkProps) {
  // Each result is stored WITH the task it was fetched for, so a task change
  // shows nothing until its own result lands, with no reset to schedule. A
  // result for a task the user has since left is simply never read.
  const requestKey = `${projectId ?? ''}:${taskId}`;
  const [result, setResult] = useState<{ key: string; hits: MemoryGraphQueryHit[] } | null>(null);
  const hits = result?.key === requestKey ? result.hits : [];
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.memory
      .relatedToTask(taskId, projectId)
      .then((found) => {
        if (!cancelled) setResult({ key: requestKey, hits: found });
      })
      .catch(() => {
        // Recall is an enhancement, never a blocker: a failure here leaves the
        // task detail exactly as it was.
        if (!cancelled) setResult({ key: requestKey, hits: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId, requestKey]);

  if (hits.length === 0) return null;

  return (
    <div className="rounded-md border border-edge bg-surface-raised" data-testid="task-prior-work">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted hover:text-fg cursor-pointer"
        data-testid="task-prior-work-toggle"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <History size={13} aria-hidden />
        <span className="font-medium">
          {hits.length} earlier {hits.length === 1 ? 'conversation' : 'conversations'} about this
        </span>
      </button>

      {expanded ? (
        <ul className="px-1.5 pb-1.5">
          {hits.map((hit) => (
            <li key={hit.sessionId}>
              <button
                type="button"
                onClick={() => useSessionStore.getState().setConversationSessionId(hit.sessionId)}
                className="w-full text-left rounded px-2 py-1.5 hover:bg-surface-hover cursor-pointer"
                data-testid="task-prior-work-item"
                title="Open this conversation"
              >
                {/* Title only, deliberately. In the Memory Graph's search
                    results a snippet earns its place by showing WHY a
                    conversation matched the query. Here there is no query, so
                    the snippet is just an arbitrary chunk - in practice often
                    raw tool-call JSON, which reads as noise and buries the one
                    line that is actually useful. */}
                <div className="text-xs text-fg truncate">{hit.taskTitle ?? 'Untitled conversation'}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
