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

/** The ref an answer writes for a task: `#561`, or `mobile#88` from another project. */
export function ticketRef(task: Pick<MemoryRelatedTask, 'ref' | 'displayId'>): string | null {
  return task.ref ?? (task.displayId != null ? `#${task.displayId}` : null);
}

/**
 * A ticket mark's shape. Tight on purpose: no margin, and 3px of padding, so
 * the punctuation after a mark sits against it the way it would against a
 * word. With 5px of padding and a 1px margin, "#383, #381" read as "#383 ,".
 */
const MARK_CLASS = 'inline-block rounded bg-surface-control px-[3px] align-baseline text-[11.5px] font-semibold';

/** A ticket's link fragment: `#kng-ticket-561`, or `#kng-ticket-88-mobile` with its project prefix. */
const TICKET_FRAGMENT = /^#kng-ticket-(\d+)(?:-([a-z0-9-]+))?$/;

/**
 * Rewrite `#561` into a markdown link with a private hash fragment, so the
 * markdown parser does the parsing and the `a` component decides what a ticket
 * renders as. A fragment rather than a custom scheme because react-markdown
 * sanitizes unknown schemes to an empty href. Code is left alone.
 *
 * A ticket from another project (`mobile#88`, in an answer across projects)
 * links the same way with its prefix in the fragment, for the `prefixes` the
 * answer's tasks carry only, so an unrelated `a#12` stays text.
 */
export function linkifyTickets(text: string, prefixes: ReadonlySet<string> = new Set()): string {
  // Prefixes are lowercase letters, digits and dashes (`refPrefixFor`), so they
  // need no escaping. Longest first, so `mobile-app` wins over `mobile`.
  const prefixPattern = prefixes.size > 0
    ? new RegExp(`(^|[^\\w#&[/-])(${[...prefixes].sort((left, right) => right.length - left.length).join('|')})#(\\d{1,6})\\b`, 'gi')
    : null;
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.split(/(`[^`]*`)/g).map((part) => {
      if (part.startsWith('`')) return part;
      const unbolded = part
        // Bold around nothing but tickets ("**#377, #378 and #381**") is
        // dropped: a mark already stands out, and bold marks read as shouting.
        .replace(/\*\*((?:\s|,|and|&|[\w-]*#\d{1,6})*[\w-]*#\d{1,6}(?:\s|,|and|&|[\w-]*#\d{1,6})*)\*\*/g, '$1');
      // Another project's ticket, before the bare form: its `#` follows a word
      // character, which the bare pattern below never matches.
      const prefixed = prefixPattern
        ? unbolded.replace(prefixPattern, (_whole, before: string, prefix: string, ticket: string) => (
          `${before}[${prefix}#${ticket}](#kng-ticket-${ticket}-${prefix.toLowerCase()})`
        ))
        : unbolded;
      return prefixed
        // Not after a word, `&` (an entity), `[` (already link text) or `/` (a URL),
        // except a `/` that follows another ticket: "#413/#503/#494" is three.
        // Never after "PR": "PR #417" is a pull request, and many task titles
        // quote one, so a mark there would open an unrelated task #417.
        .replace(
          /(?<!\b(?:PR|pr|[Pp]ull request))(^|[^\w#&[/]|(?<=#\d{1,6})\/)#(\d{1,6})\b/g,
          (_whole, before: string, ticket: string) => `${before}[#${ticket}](#kng-ticket-${ticket})`,
        );
    }).join('');
  }).join('\n');
}

/** The fields of the rendered answer's tree that `keepMarksWithPunctuation` reads. */
export interface AnswerTreeNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: AnswerTreeNode[];
}

function isTicketLink(node: AnswerTreeNode): boolean {
  const href = node.properties?.href;
  return node.type === 'element' && node.tagName === 'a' && typeof href === 'string' && href.startsWith('#kng-ticket-');
}

/**
 * Keep each mark on one line with the punctuation touching it. A mark is an
 * inline-block, and Chrome breaks a line beside one where it never would beside
 * a word, a word joiner included: "#383" ended a line and ", #377" opened the
 * next. So a mark, a `(` right before it and the punctuation right after it go
 * into one no-wrap span. Runs on the parsed tree, after markdown, so the
 * markdown itself is never rewritten for layout.
 */
export function keepMarksWithPunctuation(parent: AnswerTreeNode): void {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!isTicketLink(child)) {
      keepMarksWithPunctuation(child);
      continue;
    }
    const previous = children[index - 1];
    const next = children[index + 1];
    const before = previous?.type === 'text' && previous.value?.endsWith('(') ? '(' : '';
    const after = next?.type === 'text' ? /^[,.;:!?)]+/.exec(next.value ?? '')?.[0] ?? '' : '';
    if (!before && !after) continue;
    const group: AnswerTreeNode[] = [];
    if (before && previous) {
      previous.value = previous.value?.slice(0, -before.length);
      group.push({ type: 'text', value: before });
    }
    group.push(child);
    if (after && next) {
      next.value = next.value?.slice(after.length);
      group.push({ type: 'text', value: after });
    }
    children[index] = { type: 'element', tagName: 'span', properties: { className: ['whitespace-nowrap'] }, children: group };
  }
}

/** `keepMarksWithPunctuation` as a rehype step. */
function rehypeKeepMarksWithPunctuation() {
  return (tree: { type: string }) => keepMarksWithPunctuation(tree as AnswerTreeNode);
}

const REHYPE_PLUGINS = [rehypeKeepMarksWithPunctuation];

export function MemoryChatText({
  text,
  tasksByTicket,
  onOpenTask,
  canOpenTask,
}: {
  text: string;
  /** Tasks the answer can name, by the ref it writes (`ticketRef`). A ticket not here stays plain text. */
  tasksByTicket: ReadonlyMap<string, MemoryRelatedTask>;
  onOpenTask: (task: MemoryRelatedTask) => void;
  /** A mark for a task that cannot be opened here draws as a mark but is not a control. */
  canOpenTask: (task: MemoryRelatedTask) => boolean;
}) {
  const components: Components = {
    a: ({ href, children, ...rest }) => {
      const match = TICKET_FRAGMENT.exec(href ?? '');
      if (match) {
        const [, ticket, prefix] = match;
        const task = tasksByTicket.get(prefix ? `${prefix}#${ticket}` : `#${ticket}`);
        if (!task) return <span>{children}</span>;
        // Another project's ticket names its project, muted, the way its row
        // does. The open project's stay bare, as the answer writes them.
        const label = (
          <>
            {prefix ? <span className="font-normal text-fg-muted">{task.projectName ?? prefix} </span> : null}
            #{task.displayId}
          </>
        );
        if (!canOpenTask(task)) {
          return (
            <span
              title={task.title}
              data-testid="memory-chat-ticket"
              className={`${MARK_CLASS} text-fg-muted`}
            >
              {label}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={() => onOpenTask(task)}
            title={task.title}
            data-testid="memory-chat-ticket"
            className={`${MARK_CLASS} text-fg hover:bg-surface-hover cursor-pointer`}
          >
            {label}
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

  // The project prefixes this answer's tasks carry (`mobile#88` has `mobile`).
  const prefixes = new Set<string>();
  for (const ref of tasksByTicket.keys()) {
    const hash = ref.indexOf('#');
    if (hash > 0) prefixes.add(ref.slice(0, hash));
  }

  return (
    <div className="markdown-body memory-answer-body text-[13px] leading-[1.6] text-fg" data-testid="memory-chat-answer">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {linkifyTickets(stripProtocolLine(text), prefixes)}
      </ReactMarkdown>
    </div>
  );
}
