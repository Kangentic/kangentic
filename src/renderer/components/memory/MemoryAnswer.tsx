/**
 * The agent's answer, above the raw hits it was drawn from.
 *
 * ABOVE rather than instead of. The cards are the retrieval and stay exactly as
 * they were; this is one more reading of them, and a reader who distrusts it can
 * drop straight to the source. That is also why every citation is a control: an
 * answer you cannot trace back to the map is a claim you have to take on faith,
 * which is the thing this surface exists not to ask of anyone.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Sparkles, X, AlertTriangle } from 'lucide-react';
import type { MemoryAnswerCitation, MemoryAnswerTaskRef, MemoryGraphAnswerResult } from '../../../shared/types';

const REMARK_PLUGINS = [remarkGfm];

/**
 * Rewrites the answer's two reference forms into markdown links, so markdown
 * rendering and interactive references can coexist.
 *
 * The answer is MARKDOWN. Agents write headings, bold, bullets and fenced code
 * without being asked, and rendering that as preformatted text put `**Mobile
 * Bridge phases**` on screen literally. But the answer also carries two things
 * that must become CONTROLS - `[3]` for an excerpt and `T12` for a task - and a
 * plain markdown render would flatten both back into text.
 *
 * Rewriting them into links with a private HASH FRAGMENT lets the markdown
 * parser do the parsing while the `a` component decides what each one renders
 * as. A fragment rather than a custom `kng-task:` protocol because
 * react-markdown sanitizes unknown URL schemes to an EMPTY href, which silently
 * produced plain links matching nothing - measured, not assumed. That is
 * strictly better than splitting the raw string ourselves: the previous scan
 * had no idea what a code fence was, so a `T12` inside example code became a
 * button.
 *
 * Code is the one place refs are left alone, tracked here rather than by
 * regex-with-lookbehind because fences and inline spans nest differently.
 */
export function linkifyReferences(answer: string): string {
  const lines = answer.split('\n');
  let inFence = false;
  return lines.map((line) => {
    // A fence toggles regardless of language tag or indentation.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    // Split on inline-code spans and rewrite only the parts outside them.
    return line.split(/(`[^`]*`)/g).map((part) => {
      if (part.startsWith('`')) return part;
      return part
        // `[3]` is only a citation when it is not ALREADY a markdown link or
        // image; those carry a following `(` or a leading `!`.
        .replace(/(!?)\[(\d{1,3})\](?!\()/g, (whole, bang: string, index: string) =>
          (bang ? whole : `[${index}](#kng-cite-${index})`))
        .replace(/\bT(\d{1,4})\b/g, (_whole, ref: string) => `[T${ref}](#kng-task-${ref})`);
    }).join('');
  }).join('\n');
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

/**
 * A task the answer named. Clicking it scopes the map to that task's work.
 *
 * Rendered as its own kind rather than folded into a citation: a `[3]` points
 * at ONE excerpt, where a `T12` points at a whole task, usually several
 * conversations. Same affordance, different unit, so the label keeps its `T`.
 */
function TaskMark({
  taskRef,
  entry,
  onSelect,
}: {
  taskRef: number;
  entry: MemoryAnswerTaskRef | undefined;
  onSelect: (entry: MemoryAnswerTaskRef) => void;
}) {
  // A ref with no task behind it - out of range, or a task that has since left
  // the map. Plain text rather than a dead button, as with an unknown citation.
  if (!entry) return <span className="text-fg-faint">T{taskRef}</span>;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      title={entry.title}
      data-testid="memory-answer-task"
      data-task-ref={taskRef}
      className="mx-0.5 rounded bg-surface-control px-1 text-[11px] font-medium text-fg align-baseline hover:bg-surface-hover cursor-pointer"
    >
      T{taskRef}
    </button>
  );
}

export function MemoryAnswer({
  answer,
  onSelectCitation,
  onSelectTask,
  onDismiss,
}: {
  answer: MemoryGraphAnswerResult | null;
  onSelectCitation: (citation: MemoryAnswerCitation) => void;
  onSelectTask: (entry: MemoryAnswerTaskRef) => void;
  onDismiss: () => void;
}) {
  // The pending state lives on the Ask button, beside the question, because
  // that is where the click happened. A spinner here as well would be a second
  // report of one event.
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
  // `?? []` because an answer that predates this field is still a good answer,
  // and reading `.map` off undefined would unmount the surface.
  const taskByRef = new Map((answer.taskRefs ?? []).map((entry) => [entry.ref, entry]));

  // One `a` override handles both reference schemes and leaves a real link
  // alone. Built here rather than at module scope because it closes over this
  // answer's citation and task maps.
  const components: Components = {
    a: ({ href, children, ...rest }) => {
      const citeMatch = /^#kng-cite-(\d+)$/.exec(href ?? '');
      if (citeMatch) {
        return (
          <CitationMark
            index={Number(citeMatch[1])}
            citation={byIndex.get(Number(citeMatch[1]))}
            onSelect={onSelectCitation}
          />
        );
      }
      const taskMatch = /^#kng-task-(\d+)$/.exec(href ?? '');
      if (taskMatch) {
        return (
          <TaskMark
            taskRef={Number(taskMatch[1])}
            entry={taskByRef.get(Number(taskMatch[1]))}
            onSelect={onSelectTask}
          />
        );
      }
      // A genuine link the agent wrote. Opened externally rather than
      // navigating this window, matching `MarkdownRenderer`.
      return (
        <a
          {...rest}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            if (href) window.electronAPI.shell.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
  };

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

      {/* Rendered as markdown, because that is what the agent writes: headings,
          bold, bullets and fenced code arrive unasked, and as preformatted text
          they showed up as literal `**Mobile Bridge phases**`. The references
          survive it by being rewritten into links first (see
          `linkifyReferences`), so the parser handles the prose and the `a`
          component decides what a reference renders as. */}
      <div className="markdown-body memory-answer-body text-sm leading-relaxed text-fg">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
          {linkifyReferences(answer.answer)}
        </ReactMarkdown>
      </div>

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
