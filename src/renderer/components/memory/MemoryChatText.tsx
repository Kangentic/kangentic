/**
 * An answer's prose, with the tasks it names drawn as the board's own marks.
 *
 * The agent writes chat prose and names tasks by ticket, `#561`. Those become
 * the small `#561` mark the app already uses, and a mark for a task the answer
 * is about opens that task the way its source row does. Everything else is
 * rendered as the markdown the agent writes (bold, short lists, code), since
 * as preformatted text `**14 tasks**` showed up literally.
 *
 * The one-line `SELECTED:` protocol is stripped while the answer is still
 * streaming, so the reader never sees it arrive and then vanish.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { MemoryRelatedTask } from '../../../shared/types';

const REMARK_PLUGINS = [remarkGfm];

/** Remove the answer's `SELECTED:` line, finished or still being written. */
export function stripProtocolLine(text: string): string {
  const lastBreak = text.lastIndexOf('\n');
  const lastLine = text.slice(lastBreak + 1).trim().toUpperCase();
  // The finished line, or any start of it while it streams in ("SEL").
  const isProtocol = lastLine.startsWith('SELECTED:')
    || (lastLine.length > 0 && 'SELECTED:'.startsWith(lastLine));
  return (isProtocol ? text.slice(0, Math.max(lastBreak, 0)) : text).trimEnd();
}

/**
 * Rewrite `#561` into a markdown link with a private hash fragment, so the
 * markdown parser does the parsing and the `a` component decides what a ticket
 * renders as. A fragment rather than a custom scheme because react-markdown
 * sanitizes unknown schemes to an empty href. Code is left alone.
 */
export function linkifyTickets(text: string): string {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.split(/(`[^`]*`)/g).map((part) => {
      if (part.startsWith('`')) return part;
      return part
        // Bold around nothing but tickets ("**#377, #378 and #381**") is
        // dropped: a mark already stands out, and bold marks read as shouting.
        .replace(/\*\*((?:\s|,|and|&|#\d{1,6})*#\d{1,6}(?:\s|,|and|&|#\d{1,6})*)\*\*/g, '$1')
        // Not after a word, `&` (an entity), `[` (already link text) or `/` (a URL).
        .replace(/(^|[^\w#&[/])#(\d{1,6})\b/g, (_whole, before: string, ticket: string) => `${before}[#${ticket}](#kng-ticket-${ticket})`);
    }).join('');
  }).join('\n');
}

export function MemoryChatText({
  text,
  tasksByTicket,
  onOpenTask,
  canOpenTask,
}: {
  text: string;
  /** Tasks the answer can name, by board ticket. A ticket not here stays plain text. */
  tasksByTicket: ReadonlyMap<number, MemoryRelatedTask>;
  onOpenTask: (task: MemoryRelatedTask) => void;
  /** A mark for a task that cannot be opened here draws as a mark but is not a control. */
  canOpenTask: (task: MemoryRelatedTask) => boolean;
}) {
  const components: Components = {
    a: ({ href, children, ...rest }) => {
      const match = /^#kng-ticket-(\d+)$/.exec(href ?? '');
      if (match) {
        const task = tasksByTicket.get(Number(match[1]));
        if (!task) return <span>#{match[1]}</span>;
        if (!canOpenTask(task)) {
          return (
            <span
              title={task.title}
              data-testid="memory-chat-ticket"
              className="mx-px inline-block rounded bg-surface-control px-[5px] align-baseline text-[11.5px] font-semibold text-fg-muted"
            >
              #{task.displayId}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={() => onOpenTask(task)}
            title={task.title}
            data-testid="memory-chat-ticket"
            className="mx-px inline-block rounded bg-surface-control px-[5px] align-baseline text-[11.5px] font-semibold text-fg hover:bg-surface-hover cursor-pointer"
          >
            #{task.displayId}
          </button>
        );
      }
      // A genuine link the agent wrote, opened externally rather than
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
    <div className="markdown-body memory-answer-body text-[13px] leading-[1.6] text-fg" data-testid="memory-chat-answer">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {linkifyTickets(stripProtocolLine(text))}
      </ReactMarkdown>
    </div>
  );
}
