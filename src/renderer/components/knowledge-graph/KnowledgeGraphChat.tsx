/**
 * The Knowledge Graph chat: the right panel a question moves into.
 *
 * ONE RESPONSE SHAPE for every question, because per-question UI is what makes
 * an open-ended system unbuildable. A reply is chat prose with the tasks it
 * names drawn as `#561` marks, then source rows of one kind that open existing
 * views. The graph updating is the only other visual an answer needs.
 *
 * Who is speaking is always visible: the user's messages are right-aligned
 * bubbles, and every reply starts with the same small sparkle avatar. The
 * header names the agent once, so no message repeats it.
 *
 * While a turn is in flight it shows what is happening, never a bare spinner:
 * "Reading 14 related tasks" once the local search has returned, and each
 * search the agent makes on its own as a step line naming the query.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { ArrowUp, Check, Search, Sparkles, X } from 'lucide-react';
import type { KnowledgeGraphRelatedTask } from '../../../shared/types';
import type { KnowledgeGraphChatTurn } from '../../stores/knowledge-graph-store';
import { KnowledgeGraphChatText, stripProtocolLine, ticketRef } from './KnowledgeGraphChatText';
import { KnowledgeGraphSourceRows } from './KnowledgeGraphSourceRows';

function Avatar() {
  return (
    <span
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent/15"
      aria-hidden
    >
      <Sparkles size={13} className="text-accent-fg" />
    </span>
  );
}

function Shimmer({ width }: { width: string }) {
  return <div className="h-2.5 rounded-full bg-surface-control animate-pulse-subtle" style={{ width }} />;
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-[7px] text-xs ${done ? 'text-fg-muted' : 'text-fg-secondary'}`}>
      {done
        ? <Check size={12} className="flex-shrink-0" aria-hidden />
        : <Search size={12} className="flex-shrink-0 text-accent-fg" aria-hidden />}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function tasksWord(count: number): string {
  return count === 1 ? 'task' : 'tasks';
}

interface TurnProps {
  turn: KnowledgeGraphChatTurn;
  isLatest: boolean;
  agentName: string;
  onRetry: (turnId: string) => void;
  onOpenTask: (task: KnowledgeGraphRelatedTask) => void;
  canOpenTask: (task: KnowledgeGraphRelatedTask) => boolean;
  onFocusTurn: (turnId: string) => void;
  homeProjectId: string | null;
}

/**
 * One reply. Memoized because a streamed chunk replaces only the turn in
 * flight: the finished turns above it keep their object and their props, so
 * they skip the render each chunk causes (about 1.5 ms a turn, measured). The
 * callbacks take the turn id rather than closing over it for the same reason.
 */
const AgentTurn = memo(function AgentTurn({ turn, isLatest, agentName, onRetry, onOpenTask, canOpenTask, onFocusTurn, homeProjectId }: TurnProps) {
  // Every task this turn can name, by the ref the answer writes: the ones it is
  // about, and the related work it was handed. A ref, not a bare number, since
  // an answer across projects names kangentic#88 and mobile#88. The graph's own
  // project's tasks answer to their bare ticket too, as they do everywhere else.
  const tasksByTicket = useMemo(() => {
    const map = new Map<string, KnowledgeGraphRelatedTask>();
    const bare = new Map<string, KnowledgeGraphRelatedTask>();
    for (const task of [...(turn.related ?? []), ...turn.rows]) {
      const ref = ticketRef(task);
      if (ref) map.set(ref, task);
      if (task.displayId != null && task.projectId === homeProjectId) bare.set(`#${task.displayId}`, task);
    }
    for (const [ref, task] of bare) if (!map.has(ref)) map.set(ref, task);
    return map;
  }, [turn.related, turn.rows, homeProjectId]);

  const prose = stripProtocolLine(turn.text);

  if (turn.status === 'failed') {
    return (
      <div className="flex items-start gap-2.5" data-testid="knowledge-graph-chat-turn-failed">
        <Avatar />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-[3px]">
          <div className="text-[13px] leading-[1.6] text-danger">
            {agentName} didn&apos;t answer. {turn.reason}
          </div>
          {isLatest ? (
            <button
              type="button"
              onClick={() => onRetry(turn.id)}
              className="self-start rounded-md border border-edge-input bg-surface-control px-[11px] py-1 text-xs text-fg hover:bg-surface-hover cursor-pointer"
              data-testid="knowledge-graph-chat-retry"
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const inFlight = turn.status === 'finding' || turn.status === 'answering';
  const searching = inFlight && !prose && turn.searches.length > 0;
  return (
    <div className="flex items-start gap-2.5" data-testid="knowledge-graph-chat-turn">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-[3px]">
        {inFlight && !prose ? (
          <div className="flex flex-col gap-2" data-testid="knowledge-graph-chat-pending">
            {turn.status === 'finding' ? (
              <div className="text-xs text-fg-muted">Finding related work</div>
            ) : searching ? (
              <>
                <Step done>Read {turn.handedCount} related {tasksWord(turn.handedCount)}</Step>
                {turn.searches.map((search, index) => (
                  <Step key={`${index}:${search.query}`} done={index < turn.searches.length - 1}>
                    Searching {`"${search.query}"`}
                  </Step>
                ))}
              </>
            ) : (
              <div className="text-xs text-fg-muted" data-testid="knowledge-graph-chat-reading">
                Reading {turn.handedCount} related {tasksWord(turn.handedCount)}
              </div>
            )}
            <Shimmer width="92%" />
            <Shimmer width="64%" />
          </div>
        ) : (
          <KnowledgeGraphChatText
            text={prose}
            tasksByTicket={tasksByTicket}
            onOpenTask={onOpenTask}
            canOpenTask={canOpenTask}
            homeProjectId={homeProjectId}
          />
        )}
        {turn.status === 'done' ? (
          <KnowledgeGraphSourceRows
            rows={turn.rows}
            collapsed={!isLatest}
            onOpenTask={onOpenTask}
            canOpenTask={canOpenTask}
            onReveal={() => onFocusTurn(turn.id)}
          />
        ) : null}
      </div>
    </div>
  );
});

export function KnowledgeGraphChat({
  thread,
  agentName,
  onAsk,
  onRetry,
  onEnd,
  onOpenTask,
  canOpenTask,
  onFocusTurn,
  homeProjectId = null,
  draft,
  onDraftChange,
}: {
  thread: ReadonlyArray<KnowledgeGraphChatTurn>;
  agentName: string;
  /** True when the question went out. */
  onAsk: (question: string) => boolean;
  onRetry: (turnId: string) => void;
  onEnd: () => void;
  onOpenTask: (task: KnowledgeGraphRelatedTask) => void;
  /** Whether a task can be opened in this host: a conversation, or the board. */
  canOpenTask: (task: KnowledgeGraphRelatedTask) => boolean;
  /** Show this turn's tasks on the map. */
  onFocusTurn: (turnId: string) => void;
  /** The project the graph is on. Its tickets draw bare in an answer across
   *  projects, and a bare ticket in the prose means one of them. */
  homeProjectId?: string | null;
  /** The follow-up box's text. Held by the caller, since this panel unmounts
   *  while a node's detail takes the right slot. */
  draft: string;
  onDraftChange: (text: string) => void;
}) {
  const setDraft = onDraftChange;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const busy = thread.some((turn) => turn.status === 'finding' || turn.status === 'answering');

  // Follow the conversation down as it grows: a new question, a streamed
  // delta, a step line. Keyed on what changes the height, not on every render.
  const growth = thread.map((turn) => `${turn.id}:${turn.status}:${turn.text.length}:${turn.searches.length}`).join('|');
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [growth]);

  const send = (): void => {
    const question = draft.trim();
    if (!question || busy) return;
    // Kept when it did not go out (no agent chosen yet), so it is still there
    // when the user comes back from Settings.
    if (onAsk(question)) setDraft('');
  };

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-[10px] border border-edge bg-surface-raised/95 shadow-xl backdrop-blur-md"
      data-testid="knowledge-graph-chat"
    >
      {/* Titled for what it is, not who answers: the agent is a Settings
          choice, and the sparkle belongs to the replies alone, so each answer
          carries it once rather than the panel stamping it again above them. */}
      <div className="flex items-center gap-2 border-b border-edge py-2.5 pl-3.5 pr-2.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg" data-testid="knowledge-graph-chat-title">Chat</span>
        <button
          type="button"
          onClick={onEnd}
          aria-label="End the chat"
          title="End the chat"
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
          data-testid="knowledge-graph-chat-end"
        >
          <X size={14} />
        </button>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-3.5" data-testid="knowledge-graph-chat-thread">
        {thread.map((turn, index) => (
          <div key={turn.id} className="flex flex-col gap-[18px]">
            <div
              className="max-w-[86%] self-end select-text rounded-[14px] rounded-br-[4px] bg-surface-control px-3 py-2 text-[13px] leading-[1.45] text-fg"
              data-testid="knowledge-graph-chat-question"
            >
              {turn.question}
            </div>
            <AgentTurn
              turn={turn}
              isLatest={index === thread.length - 1}
              agentName={agentName}
              onRetry={onRetry}
              onOpenTask={onOpenTask}
              canOpenTask={canOpenTask}
              onFocusTurn={onFocusTurn}
              homeProjectId={homeProjectId}
            />
          </div>
        ))}
      </div>

      <form
        className="mx-3 mb-3 mt-2 flex items-center gap-2 rounded-[10px] border border-edge-input bg-surface py-1.5 pl-3 pr-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask a follow-up"
          aria-label="Ask a follow-up"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-muted outline-none"
          data-testid="knowledge-graph-chat-input"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={busy || !draft.trim()}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-accent text-accent-on hover:bg-accent-emphasis disabled:bg-surface-control disabled:text-fg-muted cursor-pointer disabled:cursor-default"
          data-testid="knowledge-graph-chat-send"
        >
          <ArrowUp size={14} strokeWidth={2.2} />
        </button>
      </form>
    </div>
  );
}
