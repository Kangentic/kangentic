import { useEffect, useRef, useState } from 'react';
import { MessageSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { formatRelativeTime } from '../../lib/datetime';
import { CountBadge } from '../CountBadge';
import type { SearchHit } from '../../../shared/types';

type ConversationHit = Extract<SearchHit, { kind: 'conversation' }>;

/** Cap the proactive list so the section stays compact on the task detail. */
const MAX_ROWS = 6;

interface SimilarConversationsProps {
  taskId: string;
}

/**
 * Proactive "Similar conversations" section for the task-detail surface. Asks
 * the memory index for past conversations related to this task and renders a
 * compact, collapsible list. Renders NOTHING when there are no matches (or
 * indexing is off / the IPC rejects), so it never leaves an empty box. The
 * hits are same-project, so a click opens the conversation viewer directly.
 */
export function SimilarConversations({ taskId }: SimilarConversationsProps) {
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [hits, setHits] = useState<ConversationHit[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // Guard against a stale response landing after the task changed.
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let cancelled = false;
    window.electronAPI.memory
      .similarForTask(taskId, currentProjectId)
      .then((results) => {
        if (cancelled || sequence !== requestSequence.current) return;
        setHits(results.slice(0, MAX_ROWS));
      })
      .catch(() => {
        // Best-effort: a failed lookup renders nothing, never blocks the dialog.
        if (cancelled || sequence !== requestSequence.current) return;
        setHits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, currentProjectId]);

  if (hits.length === 0) return null;

  const openConversation = (hit: ConversationHit) => {
    const sessionStore = useSessionStore.getState();
    // Arm the one-shot scroll target before pointing the viewer at the session.
    sessionStore.setScrollToTurnUuid(hit.turnUuid);
    sessionStore.setConversationSessionId(hit.sessionId);
  };

  return (
    <div className="flex-shrink-0 border-t border-edge" data-testid="similar-conversations">
      <button
        type="button"
        onClick={() => setCollapsed((previousCollapsed) => !previousCollapsed)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-1.5 px-4 pt-3 pb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted hover:text-fg transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <MessageSquare size={12} />
        Similar conversations
        <CountBadge count={hits.length} variant="muted" size="sm" className="ml-1" />
      </button>
      {!collapsed && (
        <ul className="px-2 pb-3 space-y-0.5">
          {hits.map((hit) => (
            <li key={`${hit.sessionId}-${hit.chunkId}`}>
              <button
                type="button"
                data-testid="similar-conversation-row"
                onClick={() => openConversation(hit)}
                className="w-full text-left px-2 py-1.5 rounded flex flex-col gap-0.5 hover:bg-surface-hover/60 transition-colors"
              >
                <div className="flex items-center gap-2 text-xs">
                  <MessageSquare size={12} className="flex-shrink-0 text-fg-disabled" />
                  <span className="text-fg truncate">{hit.taskTitle}</span>
                  <span className="text-fg-disabled">/</span>
                  <span className="text-fg-muted whitespace-nowrap">{hit.agentName}</span>
                  {hit.turnTs !== null && (
                    <span className="ml-auto text-fg-disabled tabular-nums whitespace-nowrap">
                      {formatRelativeTime(new Date(hit.turnTs))}
                    </span>
                  )}
                </div>
                <div className="text-xs text-fg-muted truncate pl-5">{hit.snippet}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
