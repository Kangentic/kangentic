/**
 * The agent's answer: what it wrote, the tasks it named as controls, and what
 * it rested on behind a disclosure.
 *
 * This used to sit ABOVE a rail of raw retrieval hits, as one more reading of
 * them. That rail is gone: it showed passages our search had picked before the
 * agent saw the question, tagged with how they matched, and the measured
 * example was a chunk beginning `User: <task-notification>`. Nobody asked for
 * that. The agent now searches the transcripts itself and quotes what it used
 * in `<grounds>`, so the answer is the whole of what is shown.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Sparkles, X, AlertTriangle, Loader2 } from 'lucide-react';
import type { MemoryAnswerTaskRef, MemoryGraphAnswerResult } from '../../../shared/types';
import { parseGroundsForDisplay } from './answer-stream-display';

const REMARK_PLUGINS = [remarkGfm];

/**
 * Rewrites task refs into markdown links, so markdown rendering and
 * interactive references can coexist.
 *
 * The answer is MARKDOWN. Agents write headings, bold, bullets and fenced code
 * without being asked, and rendering that as preformatted text put `**Mobile
 * Bridge phases**` on screen literally. But the answer also carries `T12` for
 * a task, which must become a CONTROL, and a plain markdown render would
 * flatten it back into text.
 *
 * Rewriting into a link with a private HASH FRAGMENT lets the markdown parser
 * do the parsing while the `a` component decides what the reference renders
 * as. A fragment rather than a custom `kng-task:` protocol because
 * react-markdown sanitizes unknown URL schemes to an EMPTY href, which silently
 * produced plain links matching nothing - measured, not assumed.
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
      return part.replace(/\bT(\d{1,4})\b/g, (_whole, ref: string) => `[T${ref}](#kng-task-${ref})`);
    }).join('');
  }).join('\n');
}

/**
 * A task the answer named. Clicking it scopes the map to that task's work.
 *
 * Rendered as its own kind rather than folded into a citation: a `[3]` points
 * at ONE excerpt, where a `T12` points at a whole task, usually several
 * conversations. Same affordance, different unit.
 *
 * TWO NUMBERS, and keeping them apart is the point. `T14` is the agent's
 * vocabulary - a position in the prompt's task table - which is what makes it
 * resolvable back to the map, so it stays on the wire. `#529` is the board's
 * `display_id`, the number the user has actually seen on a card, so it is what
 * gets rendered. They are different numbers for the same task: printing the ref
 * as `#14` would hand the reader a board-shaped identifier pointing at somebody
 * else's ticket.
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
  // A conversation with no board task has no ticket, so it keeps the ref. That
  // is honest rather than a fallback: it is not a ticket, and inventing one
  // would be the exact mistake this label avoids.
  const label = entry.displayId != null ? `#${entry.displayId}` : `T${taskRef}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      title={entry.title}
      data-testid="memory-answer-task"
      data-task-ref={taskRef}
      className="mx-0.5 rounded bg-surface-control px-1 text-[11px] font-medium text-fg align-baseline hover:bg-surface-hover cursor-pointer"
    >
      {label}
    </button>
  );
}

export function MemoryAnswer({
  answer,
  streamingAnswer,
  streamingStatus,
  agentName,
  onSelectTask,
  onDismiss,
}: {
  answer: MemoryGraphAnswerResult | null;
  /** The answer as it is being written. Empty when nothing is in flight. */
  streamingAnswer: string;
  /** What the agent is doing between text, or null. */
  streamingStatus: string | null;
  /** Who is answering, for the in-flight header before the result names it. */
  agentName: string;
  onSelectTask: (entry: MemoryAnswerTaskRef) => void;
  onDismiss: () => void;
}) {
  // IN FLIGHT: the answer arriving, as it arrives.
  //
  // Content at first-token time (measured 1.1 to 1.8s) rather than a spinner
  // until completion (measured ~6s). Only prose is shown here - refs are left
  // as plain text, because a ref resolves against the COMPLETE answer's task
  // list and a half-written `T1` is not yet anything to click. The grounds
  // block is split off so the working does not scroll past as prose.
  if (!answer && (streamingAnswer || streamingStatus)) {
    const { text } = parseGroundsForDisplay(streamingAnswer);
    return (
      <div className="border-b border-edge px-3 py-3" data-testid="memory-answer-streaming">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
          <Loader2 size={12} className="animate-spin text-accent-fg" aria-hidden />
          <span className="flex-1">{agentName} is answering</span>
        </div>
        {text ? (
          <div className="markdown-body memory-answer-body text-sm leading-relaxed text-fg">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
          </div>
        ) : null}
        {/* A transcript question is several turns - search, read, answer - and
            this is what keeps the extra turns from reading as a longer wait. */}
        {streamingStatus ? (
          <p className="mt-1 text-[11px] text-fg-muted" data-testid="memory-answer-status">
            {streamingStatus}
          </p>
        ) : null}
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

  // `?? []` because an answer that predates this field is still a good answer,
  // and reading `.map` off undefined would unmount the surface.
  const taskByRef = new Map((answer.taskRefs ?? []).map((entry) => [entry.ref, entry]));

  // The `a` override turns a task ref into a control and leaves a real link
  // alone. Built here rather than at module scope because it closes over this
  // answer's task map.
  const components: Components = {
    a: ({ href, children, ...rest }) => {
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

      {/* What the answer rests on, COLLAPSED.
          The agent is asked to quote its rows and passages before answering,
          which is the documented way to keep a long-context answer on its
          sources. Showing that inline would turn a one-line answer into a
          paragraph in a rail this narrow, so it lives one click away: the
          answer stays terse and the working stays checkable.

          A native <details> rather than component state - it is a disclosure,
          it needs no re-render, and it keeps its own open/closed across the
          answer re-rendering around it. */}
      {answer.grounds ? (
        <details className="mt-2" data-testid="memory-answer-grounds">
          <summary className="cursor-pointer list-none text-[11px] text-fg-muted hover:text-fg">
            Show what this is based on
          </summary>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded border border-edge bg-surface-inset/40 p-2 text-[11px] leading-relaxed text-fg-secondary">
            {answer.grounds}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
