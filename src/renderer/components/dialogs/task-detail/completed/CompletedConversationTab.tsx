import { useEffect, useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { ConversationBody } from '../../../conversation/ConversationBody';
import { useConversationState } from '../../../conversation/use-conversation-state';
import type { ConversationTabRequest } from '../../../../../shared/types';

/**
 * A completed task's Conversation tab: the conversation viewer's own body,
 * the same Route tabs, search and message cards the Conversation window
 * shows, inside the completed view instead of a window of its own.
 *
 * Anchored on the task's newest session, as the window's opener picks one when
 * no session is live (any of the task's sessions resolves the whole
 * conversation). Its paging key and tab ids are its own, so a Conversation
 * window open for the same task keeps its reads and its element ids.
 */
export function CompletedConversationTab({ taskId, projectId, isFocused, tabRequest }: {
  taskId: string;
  projectId: string;
  /** The host window is focused: gates the view's Mod+F, so one body answers it. */
  isFocused: boolean;
  /** The column (and stay) to show, from the Route card; a new object per click. */
  tabRequest: ConversationTabRequest | null;
}) {
  const [anchor, setAnchor] = useState<{ key: string; sessionId: string | null } | null>(null);
  const key = `${projectId}\u0000${taskId}`;

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.transcripts.listSessions(taskId, projectId)
      .then((sessions) => {
        const newest = [...sessions].sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0];
        if (!cancelled) setAnchor({ key, sessionId: newest?.sessionId ?? null });
      })
      .catch((error: unknown) => {
        console.warn('[completed-task] conversation sessions read failed:', error);
        if (!cancelled) setAnchor({ key, sessionId: null });
      });
    return () => { cancelled = true; };
  }, [key, projectId, taskId]);

  const current = anchor?.key === key ? anchor : null;
  if (!current) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={20} className="animate-spin text-fg-muted" />
      </div>
    );
  }
  if (!current.sessionId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="completed-conversation-empty">
        <MessageSquare size={24} className="text-fg-disabled" />
        <div className="text-sm text-fg-muted"><Trans>This task has no conversation history</Trans></div>
      </div>
    );
  }
  return (
    <AnchoredConversation
      taskId={taskId}
      projectId={projectId}
      anchorSessionId={current.sessionId}
      isFocused={isFocused}
      tabRequest={tabRequest}
    />
  );
}

function AnchoredConversation({ taskId, projectId, anchorSessionId, isFocused, tabRequest }: {
  taskId: string;
  projectId: string;
  anchorSessionId: string;
  isFocused: boolean;
  tabRequest: ConversationTabRequest | null;
}) {
  const state = useConversationState({
    projectId,
    anchorSessionId,
    requestKey: `completed-conversation:${taskId}`,
    tabRequest,
  });
  return (
    <ConversationBody
      state={state}
      isFocused={isFocused}
      autoFollowNewMessages={false}
      tabIdPrefix="completed-conversation-route"
    />
  );
}
