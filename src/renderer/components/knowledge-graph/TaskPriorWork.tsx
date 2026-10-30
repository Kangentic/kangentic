/**
 * "You have worked on something like this before."
 *
 * The Knowledge Graph is a place you have to remember to visit. This is the same
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
import { Plural, useLingui } from '@lingui/react/macro';
import { useSessionStore } from '../../stores/session-store';
import type { KnowledgeGraphQueryHit } from '../../../shared/types';
import { Tooltip } from '../Tooltip';

export interface TaskPriorWorkProps {
  taskId: string;
  projectId: string | null;
}

/** Collapsed by default: the task's own content is what the user opened the
 *  detail to read, and this must not push it down the page. */
const DEFAULT_EXPANDED = false;

export function TaskPriorWork({ taskId, projectId }: TaskPriorWorkProps) {
  const { t } = useLingui();
  // Each result is stored WITH the task it was fetched for, so a task change
  // shows nothing until its own result lands, with no reset to schedule. A
  // result for a task the user has since left is simply never read.
  const requestKey = `${projectId ?? ''}:${taskId}`;
  const [result, setResult] = useState<{ key: string; hits: KnowledgeGraphQueryHit[] } | null>(null);
  const hits = result?.key === requestKey ? result.hits : [];
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.knowledgeGraph
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
  const hitCount = hits.length;

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
          <Plural value={hitCount} one="# earlier conversation about this" other="# earlier conversations about this" />
        </span>
      </button>

      {expanded ? (
        <ul className="px-1.5 pb-1.5">
          {hits.map((hit) => (
            <li key={hit.sessionId}>
              {/* The row is the matched task's title, and its tip is the passage
                  that matched. A close passage can sit deep inside a task whose
                  title reads as unrelated (the conversation where this task
                  was first worked out, filed under another one), so the title
                  alone looked like noise. The passage is prose, since prior
                  work never matches on tool output, and stays in the tip so a
                  row is one line. */}
              <Tooltip
                label={hit.snippet || t`Open this conversation`}
                detail={hit.snippet ? t`Open this conversation` : undefined}
              >
                <button
                  type="button"
                  onClick={() => useSessionStore.getState().setConversationSessionId(hit.sessionId)}
                  className="w-full text-left rounded px-2 py-1.5 hover:bg-surface-hover cursor-pointer"
                  data-testid="task-prior-work-item"
                >
                  <div className="text-xs text-fg truncate">{hit.taskTitle ?? t`Untitled conversation`}</div>
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
