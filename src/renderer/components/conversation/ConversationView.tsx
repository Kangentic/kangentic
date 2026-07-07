/**
 * Pure, virtualized renderer for a single agent conversation transcript.
 *
 * Renders the structured `TranscriptEntry[]` (agent-agnostic) with dynamic row
 * measurement (turn heights vary, unlike the fixed-row ActivityLog). tool_result
 * entries are folded into their owning tool_use card via `buildResultsByUseId`;
 * a tool_result with no owning tool_use in this parse (an orphan, e.g. after a
 * resume) renders as its own standalone row.
 *
 * Stateless with respect to fetching: the owning ConversationWindow fetches and
 * passes the loaded entries down. Scroll-to-turn mirrors ActivityLog: map
 * `scrollToTurnUuid` to a display-row index, scroll it to center, flash a 4s
 * amber highlight, auto-expand a folded card containing the target, then clear
 * the one-shot signal via `onConsumedScroll`.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown, Wrench, MessageSquareWarning, Bot, User, Terminal, Copy, Check } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { HeaderActionButton } from '../HeaderActionButton';
import { buildResultsByUseId, renderAssistantBlocksMarkdown } from '../../../shared/transcript-format';
import { sanitizeTranscriptText } from '../../../shared/ansi-strip';
import { humanizeModelId } from '../../../shared/model-id';
import { parseFileEditTool, computeLineDiff, diffStats, type FileEdit } from '../../../shared/tool-diff';
import { formatTime } from '../../lib/datetime';
import type {
  TranscriptEntry,
  TranscriptSource,
  TranscriptUnavailableReason,
  TranscriptBlock,
} from '../../../shared/types';

/** Result bodies longer than this are clamped with a "Show all" toggle. */
const RESULT_CLAMP_CHARS = 4000;
const HIGHLIGHT_DURATION_MS = 4000;
const ESTIMATED_ROW_HEIGHT = 96;

type ToolResultEntry = Extract<TranscriptEntry, { kind: 'tool_result' }>;

interface DisplayRow {
  /** The TranscriptEntry uuid; used as the React key AND the scroll-to target. */
  uuid: string;
  entry: TranscriptEntry;
}

/** A user turn that is nothing but a slash-command invocation (e.g. "/code-review",
 *  "/model opus"). These are legitimate messages but low-signal as a search
 *  scroll ANCHOR - a chunk match that starts on one should skip to the real
 *  content it precedes. Requires whitespace/end after the command word so a
 *  path like "/usr/bin/foo" is not mistaken for a command. */
function isSlashCommandRow(entry: TranscriptEntry): boolean {
  return entry.kind === 'user' && /^\/[a-zA-Z][\w-]*(?:\s|$)/.test(entry.text.trim());
}

/** Classifies an entry's speaker for the row box color / system divider. */
function speakerGroup(entry: TranscriptEntry): 'user' | 'agent' | 'tool' | 'system' {
  switch (entry.kind) {
    case 'user':
      return 'user';
    case 'system':
      return 'system';
    case 'tool_result':
      return 'tool';
    default:
      return 'agent';
  }
}

interface ConversationViewProps {
  entries: TranscriptEntry[];
  degraded: boolean;
  source: TranscriptSource;
  unavailableReason?: TranscriptUnavailableReason;
  /** Agent CLI display name (e.g. "Claude Code") shown as each agent turn's role
   *  pill; falls back to "Agent" when unknown. */
  agentName?: string;
  /** One-shot: scroll to (and highlight) the row with this uuid, then clear. */
  scrollToTurnUuid: string | null;
  /** Called once the scroll-to signal has been consumed (found or not). */
  onConsumedScroll: () => void;
  /** Whether new turns arriving (a live session's transcript growing) should
   *  smoothly auto-scroll to the bottom. The owning window gates this on the
   *  user NOT focusing or hovering it, so reading an earlier part of the
   *  transcript is never yanked out from under them. */
  autoFollowNewMessages: boolean;
}

export function ConversationView({
  entries,
  degraded,
  source,
  unavailableReason,
  agentName,
  scrollToTurnUuid,
  onConsumedScroll,
  autoFollowNewMessages,
}: ConversationViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [highlightedUuid, setHighlightedUuid] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Map tool_use id -> its tool_result, so cards can inline their result.
  const resultsByUseId = useMemo(() => buildResultsByUseId(entries), [entries]);

  // The set of tool_use ids actually produced by an assistant turn: a tool_result
  // whose owner is in this set is FOLDED (inlined under the card); one without an
  // owner is a standalone orphan row.
  const ownedToolUseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type === 'tool_use') ids.add(block.id);
      }
    }
    return ids;
  }, [entries]);

  // Display rows = every entry except tool_results folded into a card.
  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = [];
    // Defense in depth: the uuid is the React key AND the virtualizer's
    // measurement-cache key, so a duplicate collapses reconciliation (stale
    // rows pile up, boxes overlap). resolveTaskTranscript already dedups the
    // stitched multi-session timeline, but guard here too so no upstream source
    // (a resume replay, an index-fallback collision) can ever break the render.
    const seenUuids = new Set<string>();
    for (const entry of entries) {
      if (
        entry.kind === 'tool_result'
        && entry.toolUseId
        && ownedToolUseIds.has(entry.toolUseId)
      ) {
        continue; // folded into its owning tool_use card
      }
      if (seenUuids.has(entry.uuid)) continue;
      seenUuids.add(entry.uuid);
      rows.push({ uuid: entry.uuid, entry });
    }
    return rows;
  }, [entries, ownedToolUseIds]);

  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    // Key the virtualizer's measurement cache by the entry's stable uuid, not
    // the default raw index. The live-poll can stitch new rows into the
    // MIDDLE of this array (a session_boundary divider plus a newly-live
    // session's entries), shifting every later row's index - without this,
    // the cache keeps applying an earlier row's already-measured height to
    // whatever new content now sits at that index, which visibly overlaps
    // rendered text until a scroll forces a full remeasure.
    getItemKey: (index) => displayRows[index].uuid,
    overscan: 8,
  });

  // Scroll-to-turn: map the one-shot uuid to a display-row index (or the owning
  // assistant row for a folded tool_result), scroll it into view, flash the
  // highlight, and clear the signal. Mirrors ActivityLog.tsx:188-213.
  useEffect(() => {
    if (!scrollToTurnUuid) return;

    let index = displayRows.findIndex((row) => row.uuid === scrollToTurnUuid);
    let expandKey: string | null = null;
    if (index < 0) {
      // The target may be a folded tool_result: scroll to its owning assistant
      // row and auto-expand the card that holds it.
      const target = entries.find((entry) => entry.uuid === scrollToTurnUuid);
      if (target && target.kind === 'tool_result' && target.toolUseId) {
        const ownerToolUseId = target.toolUseId;
        index = displayRows.findIndex(
          (row) =>
            row.entry.kind === 'assistant'
            && row.entry.blocks.some(
              (block) => block.type === 'tool_use' && block.id === ownerToolUseId,
            ),
        );
        if (index >= 0) expandKey = ownerToolUseId;
      }
    }

    if (index < 0) {
      // Not present in this transcript: clear so a later render doesn't re-try.
      onConsumedScroll();
      return;
    }

    // A conversation search hit anchors on its matched chunk's FIRST turn, which
    // can be a bare slash-command (a chunk that opens with "/code-review" then
    // covers the exchange after it). Landing on the command instead of the
    // content that actually matched is confusing, so advance past any leading
    // command turns to the first substantive one. Bounded and never targets a
    // folded tool_result redirect (expandKey), which is already the right row.
    if (!expandKey) {
      let skip = 0;
      while (index + 1 < displayRows.length && isSlashCommandRow(displayRows[index].entry) && skip < 4) {
        index += 1;
        skip += 1;
      }
    }

    if (expandKey) {
      const key = expandKey;
      setExpandedKeys((previous) => new Set(previous).add(key));
    }
    virtualizer.scrollToIndex(index, { align: 'center' });
    setHighlightedUuid(displayRows[index].uuid);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = undefined;
      setHighlightedUuid(null);
    }, HIGHLIGHT_DURATION_MS);
    onConsumedScroll();
  }, [scrollToTurnUuid, displayRows, entries, virtualizer, onConsumedScroll]);

  // Auto-follow: while the window isn't focused/hovered, smoothly scroll to the
  // bottom whenever the live-refresh poll grows the transcript, so the newest
  // turn stays in view. Tracks the previous row count in a ref rather than
  // state so this never fires on the initial load (previousCount starts null)
  // - only on a genuine append after the view is already showing something.
  // Declared after the scrollToTurnUuid effect so an explicit turn-navigation
  // (rare same-tick coincidence with a live append) wins the final scroll
  // position - effects run in declaration order.
  const previousRowCountRef = useRef<number | null>(null);
  useEffect(() => {
    const previousCount = previousRowCountRef.current;
    previousRowCountRef.current = displayRows.length;
    if (previousCount === null) return;
    if (displayRows.length <= previousCount) return;
    if (!autoFollowNewMessages) return;
    virtualizer.scrollToEnd({ behavior: 'smooth' });
  }, [displayRows.length, autoFollowNewMessages, virtualizer]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // A selection spanning multiple rendered blocks (headings, paragraphs, list
  // items) gets the browser's default plain-text serialization, which inserts
  // a blank line at each block boundary crossed - often leaving 1-2 trailing
  // blank lines when the selection ends mid-block. Collapse runs of 3+
  // newlines to a plain paragraph break and trim the ends so a multi-block
  // selection still pastes clean, matching the copy button's tidiness.
  const handleSelectionCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = window.getSelection()?.toString() ?? '';
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text.replace(/\n{3,}/g, '\n\n').trim());
  }, []);

  // source === 'none': no content at all. Explain why per unavailable reason.
  if (source === 'none') {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-6 text-center"
        data-testid="conversation-empty"
      >
        <p className="text-sm text-fg-muted max-w-md">{emptyReasonText(unavailableReason)}</p>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      data-testid="conversation-view"
      onCopy={handleSelectionCopy}
    >
      {degraded && (
        <div
          className="flex items-center gap-2 px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-b border-amber-500/20"
          data-testid="conversation-degraded-banner"
        >
          <MessageSquareWarning size={14} className="flex-shrink-0" />
          <span>Original transcript file is gone - showing indexed text.</span>
        </div>
      )}
      {displayRows.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-fg-muted">
          This conversation has no messages yet.
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto">
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const row = displayRows[virtualRow.index];
              const isHighlighted = highlightedUuid === row.uuid;
              // Each message is a discrete rounded box, filled AND bordered in a
              // theme-adaptive role color (accent for you, neutral for the agent),
              // separated by small gaps. Gaps use padding (not margin) so the
              // virtualizer measures heights correctly. System entries render as a
              // plain divider, no box.
              const speaker = speakerGroup(row.entry);
              const isSystem = speaker === 'system';
              const boxClass = speaker === 'user'
                ? 'border-accent/40 bg-accent/10'
                : 'border-edge bg-fg/[0.05]';
              // 12px sides; 6px top/bottom per row so adjacent rows sum to a 12px
              // gap; the first/last rows get the full 12px so the top and bottom
              // edges match that rhythm.
              const gapClass = `px-3 ${virtualRow.index === 0 ? 'pt-3' : 'pt-1.5'} ${
                virtualRow.index === displayRows.length - 1 ? 'pb-3' : 'pb-1.5'
              }`;
              return (
                <div
                  key={row.uuid}
                  data-index={virtualRow.index}
                  data-turn-uuid={row.uuid}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {isSystem ? (
                    <div className={gapClass}>
                      <MemoConversationRow
                        entry={row.entry}
                        agentName={agentName}
                        resultsByUseId={resultsByUseId}
                        expandedKeys={expandedKeys}
                        toggleExpanded={toggleExpanded}
                      />
                    </div>
                  ) : (
                    <div className={gapClass}>
                      <div
                        data-highlighted={isHighlighted ? 'true' : undefined}
                        className={`group/message rounded-lg border px-3 py-2 transition-colors duration-700 ${
                          isHighlighted ? 'border-amber-400/60 bg-amber-400/10' : boxClass
                        }`}
                      >
                        <MemoConversationRow
                          entry={row.entry}
                          agentName={agentName}
                          resultsByUseId={resultsByUseId}
                          expandedKeys={expandedKeys}
                          toggleExpanded={toggleExpanded}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function emptyReasonText(reason: TranscriptUnavailableReason | undefined): string {
  switch (reason) {
    case 'unsupported_agent':
      return "Structured transcripts aren't available for this agent.";
    case 'no_agent_session_id':
      return "This session's history hasn't been written yet.";
    case 'file_missing':
      return 'The transcript file no longer exists.';
    default:
      return 'No conversation is available for this session.';
  }
}

/* ── Per-kind rows ── */

interface ConversationRowProps {
  entry: TranscriptEntry;
  agentName?: string;
  resultsByUseId: Map<string, { content: string; isError: boolean }>;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}

function ConversationRow({ entry, agentName, resultsByUseId, expandedKeys, toggleExpanded }: ConversationRowProps) {
  if (entry.kind === 'user') return <UserRow text={entry.text} ts={entry.ts} />;
  if (entry.kind === 'system') return <SystemRow subtype={entry.subtype} text={entry.text} />;
  if (entry.kind === 'tool_result') return <OrphanToolResultRow entry={entry} expandedKeys={expandedKeys} toggleExpanded={toggleExpanded} />;
  return (
    <AssistantRow
      model={entry.model}
      blocks={entry.blocks}
      uuid={entry.uuid}
      // A stitched task-level view stamps each entry with the agent of the
      // session it came from (entry.agentName); the component-level prop only
      // describes the latest session, so it's the fallback for an ordinary
      // single-session transcript where entries don't carry their own.
      agentName={entry.agentName ?? agentName}
      ts={entry.ts}
      resultsByUseId={resultsByUseId}
      expandedKeys={expandedKeys}
      toggleExpanded={toggleExpanded}
    />
  );
}

/**
 * Memoized row. `useVirtualizer` re-renders the whole list on every scroll
 * frame; without this, each visible row re-runs its body (markdown sanitize,
 * the eager copy-text serialization, JSX construction) on every frame - the
 * jank that shows up on long transcripts. All five props are referentially
 * stable while scrolling (the entries array, `resultsByUseId`, and
 * `expandedKeys` only change on a poll that grows the transcript or on a toggle,
 * never on scroll), so the default shallow compare bails the entire subtree out
 * of scroll re-renders. `isHighlighted` deliberately lives on the OUTER box, not
 * here, so a highlight flash never busts this memo.
 */
const MemoConversationRow = memo(ConversationRow);

/** The speaker badge (accent for you, neutral for the agent / tool), with the
 *  agent's friendly model name beside it. Rendered inside a MessageHeader. */
function RoleBadge({
  icon,
  label,
  tone = 'neutral',
  model,
}: {
  icon: ReactNode;
  label: string;
  tone?: 'accent' | 'neutral';
  model?: string;
}) {
  const friendlyModel = model ? humanizeModelId(model) ?? model : null;
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
          tone === 'accent'
            ? 'border-accent/30 bg-accent/15 text-accent'
            : 'border-edge/60 bg-surface-hover/60 text-fg-muted'
        }`}
      >
        {icon}
        {label}
      </span>
      {friendlyModel && <span className="text-[11px] text-fg-muted">{friendlyModel}</span>}
    </>
  );
}

/** Per-message header row: the (optional) speaker badge, the message timestamp,
 *  and a hover-revealed copy button for that message's own contents. */
function MessageHeader({ badge, ts, copyText }: { badge?: ReactNode; ts: number; copyText: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      {badge}
      {ts > 0 && <span className="text-[11px] text-fg-disabled whitespace-nowrap">{formatTime(ts)}</span>}
      <div className="flex-1" />
      {copyText.length > 0 && <CopyIconButton text={copyText} />}
    </div>
  );
}

/** Shared copy-with-confirmation behavior for the message and tool-call copy
 *  buttons: writes to the clipboard, flips to a check for 1.5s on success. */
function useCopyFeedback(text: string): { copied: boolean; handleCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [text]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return { copied, handleCopy };
}

/** HeaderActionButton takes an icon COMPONENT, not a pre-rendered element, so
 *  the brief "copied" confirmation (green check) is its own tiny component
 *  rather than an inline conditional element (mirrors ConversationWindow's
 *  title-bar copy button). */
function MessageCopiedCheckIcon({ size }: { size?: number }) {
  return <Check size={size} className="text-green-400" />;
}

/** Copy button that reveals on message hover (or keyboard focus) and copies
 *  that message's text, flipping to a check for brief confirmation. Reuses
 *  the shared HeaderActionButton (size="small") so it carries the exact same
 *  colors/contrast as the title-bar action buttons instead of a bespoke,
 *  fainter treatment. */
function CopyIconButton({ text }: { text: string }) {
  const { copied, handleCopy } = useCopyFeedback(text);
  return (
    <HeaderActionButton
      icon={copied ? MessageCopiedCheckIcon : Copy}
      onClick={handleCopy}
      size="small"
      title="Copy message"
      ariaLabel="Copy message"
      testId="conversation-message-copy"
      // HeaderActionButton's rest background (bg-surface-hover/50) barely
      // differs from a message row's own background (bg-surface-hover/30),
      // so it nearly disappears here even though the title bar (against
      // bg-surface-raised) contrasts fine. A visible border reads regardless
      // of background blending, so add one just for this placement.
      className="!border-edge/60 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
    />
  );
}

function UserRow({ text, ts }: { text: string; ts: number }) {
  const clean = sanitizeTranscriptText(text);
  return (
    <div data-testid="conversation-row-user">
      <MessageHeader
        badge={<RoleBadge icon={<User size={12} />} label="You" tone="accent" />}
        ts={ts}
        copyText={clean}
      />
      <div className="text-sm text-fg">
        <MarkdownRenderer content={clean} />
      </div>
    </div>
  );
}

function SystemRow({
  subtype,
  text,
}: {
  subtype: 'compaction' | 'command' | 'command_output' | 'session_boundary';
  text: string;
}) {
  const clean = sanitizeTranscriptText(text).trim();
  const label =
    subtype === 'compaction'
      ? 'Conversation compacted'
      : subtype === 'command'
        ? `[command] ${clean}`
        // session_boundary's text is already a ready-to-display label (e.g.
        // "New session - Claude Code (isolated: Executing)"), unlike the
        // other subtypes whose text is raw payload behind a canned label.
        : subtype === 'session_boundary'
          ? clean
          : 'Command output';
  return (
    <div className="flex items-center gap-3 py-1 text-fg-disabled" data-testid="conversation-row-system">
      <div className="flex-1 h-px bg-edge/50" />
      <span className="text-[11px] uppercase tracking-wider whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-edge/50" />
    </div>
  );
}

interface AssistantRowProps {
  model?: string;
  blocks: TranscriptBlock[];
  uuid: string;
  /** Agent CLI display name for the role pill; falls back to "Agent". */
  agentName?: string;
  ts: number;
  resultsByUseId: Map<string, { content: string; isError: boolean }>;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}

function AssistantRow({ model, blocks, uuid, agentName, ts, resultsByUseId, expandedKeys, toggleExpanded }: AssistantRowProps) {
  // The copy button needs this turn's full markdown, but serializing every
  // block (plus its tool results) is not free - memoize it so it is built once
  // per turn, not eagerly on every render.
  const copyText = useMemo(() => renderAssistantBlocksMarkdown(blocks, resultsByUseId), [blocks, resultsByUseId]);
  // Every turn shows its own badge (agent name + model) and timestamp - a
  // tool-calling stretch is exactly where knowing which agent/model ran each
  // step (without scrolling back to find the last header) matters most.
  return (
    <div data-testid="conversation-row-assistant">
      <MessageHeader
        badge={<RoleBadge icon={<Bot size={12} />} label={agentName || 'Agent'} model={model} />}
        ts={ts}
        copyText={copyText}
      />
      <div className="space-y-2">
        {blocks.map((block, index) => {
          if (block.type === 'text') {
            return (
              <div key={`text-${index}`} className="text-sm text-fg-secondary">
                <MarkdownRenderer content={sanitizeTranscriptText(block.text)} />
              </div>
            );
          }
          // activity-state-ok: this is TranscriptBlock.type, not an ActivityState bucket.
          if (block.type === 'thinking') {
            const key = `${uuid}:think:${index}`;
            return (
              <ThinkingBlock
                key={key}
                text={block.text}
                expanded={expandedKeys.has(key)}
                onToggle={() => toggleExpanded(key)}
              />
            );
          }
          // tool_use
          return (
            <ToolCallCard
              key={`tool-${block.id}`}
              name={block.name}
              input={block.input}
              result={resultsByUseId.get(block.id) ?? null}
              expanded={expandedKeys.has(block.id)}
              onToggle={() => toggleExpanded(block.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ThinkingBlock({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border-l-2 border-edge/60 pl-2" data-testid="conversation-thinking">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1 text-xs text-fg-disabled hover:text-fg-muted transition-colors"
        data-testid="conversation-thinking-toggle"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Thinking
      </button>
      {expanded && (
        <div className="mt-1 text-xs text-fg-muted whitespace-pre-wrap font-mono">
          {sanitizeTranscriptText(text).trim()}
        </div>
      )}
    </div>
  );
}

interface ToolCallCardProps {
  name: string;
  input: unknown;
  result: { content: string; isError: boolean } | null;
  expanded: boolean;
  onToggle: () => void;
}

function ToolCallCard({ name, input, result, expanded, onToggle }: ToolCallCardProps) {
  const [showFullResult, setShowFullResult] = useState(false);
  // File-editing tools (Edit/MultiEdit/Write) render as a Claude-Code-style diff
  // rather than raw JSON; everything else keeps the input/result JSON view.
  const fileEdit = useMemo(() => parseFileEditTool(input), [input]);
  const stats = useMemo(() => (fileEdit ? diffStats(fileEdit.hunks) : null), [fileEdit]);
  const summary = fileEdit ? basename(fileEdit.filePath) : summarizeInput(input);
  const resultContent = result ? sanitizeTranscriptText(result.content) : '';
  const isClamped = resultContent.length > RESULT_CLAMP_CHARS;
  const shownResult = isClamped && !showFullResult ? resultContent.slice(0, RESULT_CLAMP_CHARS) : resultContent;

  return (
    <div
      className={`rounded border text-xs ${
        result?.isError ? 'border-red-500/40 bg-red-500/5' : 'border-edge/60 bg-surface-hover/30'
      }`}
      data-testid="conversation-tool-card"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        data-testid="conversation-tool-toggle"
      >
        {expanded ? <ChevronDown size={13} className="flex-shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="flex-shrink-0 text-fg-muted" />}
        <Wrench size={12} className="flex-shrink-0 text-fg-muted" />
        <span className="font-mono font-medium text-fg-secondary flex-shrink-0">{name}</span>
        <span className="text-fg-disabled truncate min-w-0">{summary}</span>
        {(stats || result?.isError) && (
          <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-[11px] font-mono">
            {stats && stats.added > 0 && <span className="text-green-400">+{stats.added}</span>}
            {stats && stats.removed > 0 && <span className="text-red-400">-{stats.removed}</span>}
            {result?.isError && <span className="text-red-400">error</span>}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {fileEdit ? (
            <DiffView fileEdit={fileEdit} />
          ) : (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-disabled mb-0.5">Input</div>
              <pre className="text-xs text-fg-muted whitespace-pre-wrap break-words bg-surface-inset/40 rounded p-2 overflow-x-auto">
                {prettyJson(input)}
              </pre>
            </div>
          )}
          {/* A file edit's success result is just a verbose "updated successfully"
              blurb the agent emits, redundant with the diff - hide it and only
              surface a result when it is an error (or a non-edit tool). */}
          {result && (!fileEdit || result.isError) && (
            <div>
              <div className={`text-[11px] uppercase tracking-wider mb-0.5 ${result.isError ? 'text-red-400' : 'text-fg-disabled'}`}>
                {result.isError ? 'Error' : 'Result'}
              </div>
              <pre
                className={`text-xs whitespace-pre-wrap break-words rounded p-2 overflow-x-auto ${
                  result.isError ? 'text-red-300 bg-red-500/5' : 'text-fg-muted bg-surface-inset/40'
                }`}
              >
                {shownResult}
              </pre>
              {isClamped && (
                <button
                  type="button"
                  onClick={() => setShowFullResult((previous) => !previous)}
                  className="mt-1 text-[11px] text-accent hover:underline"
                  data-testid="conversation-tool-show-all"
                >
                  {showFullResult ? 'Show less' : `Show all (${resultContent.length.toLocaleString()} chars)`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a file edit as a colorized line diff, one block per hunk. Lossless:
 *  the add/remove lines come straight from the tool's old/new strings. */
function DiffView({ fileEdit }: { fileEdit: FileEdit }) {
  return (
    <div className="space-y-2" data-testid="conversation-diff">
      {fileEdit.hunks.map((hunk, hunkIndex) => {
        const lines = computeLineDiff(hunk.oldText, hunk.newText);
        return (
          <div
            key={hunkIndex}
            className="overflow-x-auto rounded bg-surface-inset/40 py-1 font-mono text-xs leading-relaxed"
          >
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={`whitespace-pre px-2 ${
                  line.type === 'add'
                    ? 'bg-green-500/15 text-green-300'
                    : line.type === 'remove'
                      ? 'bg-red-500/15 text-red-300'
                      : 'text-fg-muted'
                }`}
              >
                <span className="select-none opacity-50">
                  {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}
                </span>
                {line.text.length > 0 ? line.text : ' '}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function OrphanToolResultRow({
  entry,
  expandedKeys,
  toggleExpanded,
}: {
  entry: ToolResultEntry;
  expandedKeys: Set<string>;
  toggleExpanded: (key: string) => void;
}) {
  const key = `orphan:${entry.uuid}`;
  const expanded = expandedKeys.has(key);
  const content = sanitizeTranscriptText(entry.content);
  return (
    <div data-testid="conversation-row-tool-result">
      <MessageHeader
        badge={<RoleBadge icon={<Terminal size={12} />} label="Tool result" />}
        ts={entry.ts}
        copyText={content}
      />
      <div
        className={`rounded border text-xs ${
          entry.isError ? 'border-red-500/40 bg-red-500/5' : 'border-edge/60 bg-surface-hover/30'
        }`}
      >
        <button
          type="button"
          onClick={() => toggleExpanded(key)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        >
          {expanded ? <ChevronDown size={13} className="flex-shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="flex-shrink-0 text-fg-muted" />}
          <span className="text-fg-disabled truncate min-w-0">{content.slice(0, 120)}</span>
        </button>
        {expanded && (
          <pre className="px-2 pb-2 text-xs text-fg-muted whitespace-pre-wrap break-words overflow-x-auto">
            {content.length > RESULT_CLAMP_CHARS ? content.slice(0, RESULT_CLAMP_CHARS) : content}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ── */

/** Last path segment of a file path, for a compact tool-card summary. */
function basename(filePath: string | null): string {
  if (!filePath) return '';
  const segments = filePath.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 120);
  try {
    const json = JSON.stringify(input);
    return json.length > 120 ? `${json.slice(0, 120)}...` : json;
  } catch {
    return String(input);
  }
}

function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
