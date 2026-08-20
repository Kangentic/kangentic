/**
 * The agent's answer, above the raw hits it was drawn from.
 *
 * ABOVE rather than instead of. The cards are the retrieval and stay exactly as
 * they were; this is one more reading of them, and a reader who distrusts it can
 * drop straight to the source. That is also why every citation is a control: an
 * answer you cannot trace back to the map is a claim you have to take on faith,
 * which is the thing this surface exists not to ask of anyone.
 */

import { Sparkles, Loader2, X, AlertTriangle } from 'lucide-react';
import type { MemoryAnswerCitation, MemoryGraphAnswerResult } from '../../../shared/types';

/**
 * Splits answer text on its citation markers.
 *
 * Deliberately a plain scan rather than markdown rendering. The answer is prose
 * about a codebase and legitimately contains brackets, backticks and fenced
 * code; the ONE thing that has to become interactive is `[n]`, and everything
 * else is safer left as the text the agent wrote.
 */
export function splitOnCitations(text: string): Array<{ text: string } | { cite: number }> {
  const parts: Array<{ text: string } | { cite: number }> = [];
  const pattern = /\[(\d{1,3})\]/g;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
    parts.push({ cite: Number(match[1]) });
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function CitationMark({
  index,
  citation,
  onSelect,
}: {
  index: number;
  citation: MemoryAnswerCitation | undefined;
  onSelect: (citation: MemoryAnswerCitation) => void;
}) {
  // A number the answer invented, with no source behind it. Rendered as plain
  // text rather than a dead button: a control that cannot act is worse than no
  // control, and the marker is still what the agent wrote.
  if (!citation) return <span className="text-fg-faint">[{index}]</span>;
  return (
    <button
      type="button"
      onClick={() => onSelect(citation)}
      title={citation.title}
      data-testid="memory-answer-citation"
      data-citation={index}
      className="mx-0.5 rounded bg-surface-control px-1 text-[11px] font-medium text-accent-fg align-baseline hover:bg-surface-hover cursor-pointer"
    >
      {index}
    </button>
  );
}

export function MemoryAnswer({
  answer,
  answering,
  agentLabel,
  onSelectCitation,
  onDismiss,
}: {
  answer: MemoryGraphAnswerResult | null;
  answering: boolean;
  /** Named before the call, so the cost is attributable before it is paid. */
  agentLabel: string;
  onSelectCitation: (citation: MemoryAnswerCitation) => void;
  onDismiss: () => void;
}) {
  if (answering) {
    return (
      <div
        className="flex items-center gap-2 border-b border-edge px-3 py-3 text-sm text-fg-muted"
        data-testid="memory-answer-pending"
      >
        <Loader2 size={13} className="animate-spin" aria-hidden />
        <span>Asking {agentLabel} to read {' '}the matches</span>
      </div>
    );
  }

  if (!answer) return null;

  if (!answer.ok) {
    return (
      <div
        className="flex items-start gap-2 border-b border-edge px-3 py-3 text-sm text-fg-muted"
        data-testid="memory-answer-error"
      >
        <AlertTriangle size={13} className="mt-0.5 flex-shrink-0 text-attention" aria-hidden />
        {/* The reason verbatim. Every one of them is actionable - no CLI, the
            agent cannot answer, a timeout - and a generic failure line would
            take that away. */}
        <span className="min-w-0 flex-1">{answer.reason}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  const byIndex = new Map(answer.citations.map((citation) => [citation.index, citation]));

  return (
    <div className="border-b border-edge px-3 py-3" data-testid="memory-answer">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
        <Sparkles size={12} className="text-accent-fg" aria-hidden />
        <span className="flex-1">Answered by {answer.agentName}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss answer"
          data-testid="memory-answer-dismiss"
          className="rounded p-0.5 hover:bg-surface-hover hover:text-fg cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>

      {/* `whitespace-pre-wrap`, so the paragraphs the agent wrote survive. */}
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">
        {splitOnCitations(answer.answer).map((part, position) => (
          'cite' in part
            ? (
              <CitationMark
                key={position}
                index={part.cite}
                citation={byIndex.get(part.cite)}
                onSelect={onSelectCitation}
              />
            )
            : <span key={position}>{part.text}</span>
        ))}
      </p>

      {/* Stated rather than swallowed: an answer drawn from 24 of 60 matches is
          a different claim from one drawn from all of them, and the reader is
          the only one who can judge whether that matters. */}
      {answer.droppedConversations > 0 ? (
        <p className="mt-2 text-[11px] text-fg-faint" data-testid="memory-answer-dropped">
          Read {answer.citations.length} conversations. {answer.droppedConversations} more matched
          than fit in one question.
        </p>
      ) : null}
    </div>
  );
}
