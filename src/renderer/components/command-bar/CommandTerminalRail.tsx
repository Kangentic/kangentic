/**
 * The Command Terminal panel's left rail: Add terminal at its head (the only
 * place it is, `NewTerminalButton`), Running, and Earlier (the project's ended
 * conversations, newest first).
 *
 * Running lists every terminal in the panel, in the order they tile, tiled or
 * with one expanded, and marks the one in front: the expanded one, else the
 * focused tile. Each row's mark is that terminal's own Stop button, so one can
 * be stopped where it is, and its title brings it to the front (expanded over
 * the others when one is expanded, focused when they tile). A row's
 * right-click is that terminal's whole ... menu (`CommandTerminalRowMenu`).
 *
 * Earlier has no heading and no search field until a conversation has ended,
 * then lists every conversation that can still be resumed, in a list that
 * scrolls on its own. The rail's body scrolls too only when Running leaves it
 * under its minimum. The agent's own transcript cleanup is what bounds the
 * list. Search filters it as the user types: the name and first prompt
 * at once from the list held here, the conversation text from main a beat
 * later, added below so a row on screen never moves (`useEarlierSearch`).
 *
 * A row resumes its conversation in place of an unused terminal (nothing has
 * reached it yet), or in a new terminal beside the others. At the cap that is
 * off and says why. Its right-click is Resume, Rename and Remove, and the last
 * two still work at the cap, since neither starts anything. A name the rail
 * cuts short shows in full on hover.
 *
 * The rail's edge drags (200 to 400px, 300 by default) and it folds to a 37px
 * strip (`useCommandTerminalRail`), the project sidebar's pattern. The strip
 * keeps Add terminal on the same row and lists the same terminals as Running,
 * each as its agent's activity mark (the one a task card shows), the one in
 * front marked. The fold button is the rail's bottom row,
 * outlined at rest: open, the whole width with the icon and "Hide"; folded, the
 * strip's icon. The icon is on the same spot in both, so a second click puts
 * the rail back without moving the pointer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CirclePlay, History, PanelLeftClose, PanelLeftOpen, Pencil, Search, Trash2, X } from 'lucide-react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { formatMonthDay, formatTimeAgo } from '../../lib/datetime';
import { asSentence, describeIpcError } from '../../lib/ipc-error';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { useToastStore } from '../../stores/toast-store';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { commandTerminalHistoryName, commandTerminalTitle, normalizeCommandTerminalName } from '../../../shared/command-terminal-name';
import { COMMAND_RAIL_MAX_WIDTH_PX, COMMAND_RAIL_MIN_WIDTH_PX } from '../../../shared/command-terminal-rail';
import { ActivityMark } from '../ActivityMark';
import { agentActivityMark } from '../board/agent-wait';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { KebabMenuDivider, KebabMenuItem } from '../KebabMenu';
import { StopButtonIcon } from './StopButtonIcon';
import { NewTerminalButton } from './NewTerminalButton';
import { CommandTerminalContextMenu } from './CommandTerminalContextMenu';
import { CommandTerminalNameField } from './CommandTerminalNameField';
import { CommandTerminalRowMenu } from './CommandTerminalRowMenu';
import { useCommandTerminalHistory } from './useCommandTerminalHistory';
import { useCommandTerminalRail } from './useCommandTerminalRail';
import { useCommandTerminalRename } from './useCommandTerminalRename';
import { useEarlierSearch } from './useEarlierSearch';
import { useRailTerminalMenuActions, type RailCommandTerminal } from './useRailTerminalMenuActions';
import type { EarlierMatch } from './earlier-search';
import type { CommandTerminalHistoryEntry } from '../../../shared/types';

/** One Earlier row (44px) plus the 2px gap below it. */
const EARLIER_ROW_PITCH_PX = 46;
/** A list heading, its 12px top padding, line and 4px bottom padding. */
const EARLIER_HEADING_PX = 32;
/** A status line's first guess, before it is measured. */
const EARLIER_LINE_PX = 36;
/** The empty state's first guess, before it is measured. */
const EARLIER_EMPTY_PX = 124;

const MINUTE_MS = 60 * 1000;
const RECENT_MS = 2 * 24 * 60 * MINUTE_MS;

/** "2 hours ago" or "yesterday" while recent, then the date: "Oct 21". */
function endedLabel(endedAt: string, now: number): string {
  return now - new Date(endedAt).getTime() < RECENT_MS ? formatTimeAgo(endedAt, now) : formatMonthDay(endedAt, new Date(now));
}

/** Re-render once a minute, so "just now" moves on. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What a terminal in the rail is doing, as its mark's tone and its tip say. */
type RailTerminalState = 'working' | 'needs-you' | 'resting' | 'starting';

/**
 * The words a strip mark's tip says its terminal's state in. One message per
 * state, the name included, so the sentence is never pieced together from
 * translated parts (as `CollapsedRail`'s project labels).
 */
function markLabel(name: string, state: RailTerminalState): string {
  switch (state) {
    case 'working':
      return i18n._(msg`${name} (working)`);
    case 'needs-you':
      return i18n._(msg`${name} (needs you)`);
    case 'resting':
      return i18n._(msg`${name} (resting)`);
    case 'starting':
      return i18n._(msg`${name} (starting)`);
  }
}

const MARK_TONE_CLASS: Record<RailTerminalState, string> = {
  working: 'text-active',
  'needs-you': 'text-attention',
  resting: 'text-fg-muted',
  starting: 'text-fg-muted',
};

/** One terminal's session, activity and name, for its row or its strip mark. */
function useRailTerminal(projectId: string | null, terminal: RailCommandTerminal) {
  const sessionId = useSessionStore((state) =>
    projectId ? state.transientSessions[transientKey(projectId, terminal.slot)]?.sessionId ?? null : null);
  const rename = useCommandTerminalRename(sessionId, terminal.slot);
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const activityReason = useSessionStore((state) => (sessionId ? state.sessionActivityReason[sessionId] : undefined));
  const state: RailTerminalState = sessionId === null
    ? 'starting'
    : isActive(activity) ? 'working' : requiresUserInteraction(activity) ? 'needs-you' : 'resting';
  return { sessionId, rename, activity, activityReason, state };
}

interface RunningRowProps {
  projectId: string | null;
  terminal: RailCommandTerminal;
  /** This terminal is the one in front: the expanded one, else the focused tile. */
  front: boolean;
  onBringToFront: (windowId: string) => void;
  onStop: (terminal: RailCommandTerminal) => Promise<void>;
}

/** One terminal: its live Stop button, then its name, which brings it to the front. */
function RunningRow({ projectId, terminal, front, onBringToFront, onStop }: RunningRowProps) {
  const { t } = useLingui();
  const { rename, state } = useRailTerminal(projectId, terminal);
  const [stopping, setStopping] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const name = rename.displayName;
  const isThinking = state === 'working';
  const isIdle = state === 'needs-you';

  const handleStop = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    // The row unmounts with its window; nothing to reset after.
    await onStop(terminal);
  };

  const menuActions = useRailTerminalMenuActions(projectId, terminal, {
    onBringToFront,
    onStop: () => { void handleStop(); },
    stopping,
    // Here, in the row: the terminal stays where it is.
    onRename: rename.startEditing,
    renameDisabledReason: rename.disabledReason,
  });

  return (
    <div
      // The one in front has the sidebar's selected-project fill: neutral, so
      // the rail's only blue is Add terminal, its primary action.
      className={`flex h-9 flex-shrink-0 items-center gap-2.5 rounded-md px-2 ${front ? 'bg-surface-hover' : 'hover:bg-surface-hover/50'}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
      data-testid="command-terminal-running-row"
      data-command-slot={terminal.slot}
      data-front={front ? 'true' : 'false'}
    >
      <Tooltip label={t`Ends the terminal, and Earlier keeps its conversation if it was used`}>
        <button
          type="button"
          onClick={() => void handleStop()}
          disabled={stopping}
          className={`inline-flex flex-shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed ${
            stopping ? 'text-fg-muted' : isThinking || isIdle ? '' : 'text-red-400'
          }`}
          aria-label={t`Stop ${name}`}
          data-testid="command-terminal-running-stop"
        >
          <StopButtonIcon isThinking={isThinking} isIdle={isIdle} stopping={stopping} />
        </button>
      </Tooltip>
      {rename.editing ? (
        <CommandTerminalNameField
          initialName={name}
          placeholder={commandTerminalTitle(terminal.slot)}
          onCommit={(value, byKey) => rename.commit(value, byKey)}
          onCancel={rename.cancel}
          className="text-[13px] leading-5"
          data-testid="command-terminal-running-name-field"
        />
      ) : (
        <Tooltip label={name}>
          <button
            type="button"
            onClick={() => onBringToFront(terminal.windowId)}
            className="min-w-0 flex-1 truncate text-left text-[13px] text-fg"
            aria-label={t`Go to ${name}`}
            aria-current={front ? 'true' : undefined}
            data-testid="command-terminal-running-expand"
          >
            {name}
          </button>
        </Tooltip>
      )}
      {menuPosition && (
        <CommandTerminalRowMenu position={menuPosition} onClose={() => setMenuPosition(null)} {...menuActions} />
      )}
    </div>
  );
}

/**
 * One terminal in the collapsed rail: its agent's activity mark, the one a task
 * card shows (`agentActivityMark`: the working ring, or the envelope, bubble or
 * shield of what it waits for), muted while it starts or rests. The one in front
 * has the sidebar's neutral selected fill, never blue, which is Add terminal's.
 * A click brings it to the front;
 * a right-click is its row's menu. No Stop here: it stays in the open rail and
 * the terminal's own header. The strip has no room for a name field, so Rename
 * brings the terminal up and opens its header's.
 */
function RunningMark({ projectId, terminal, front, onBringToFront, onStop }: RunningRowProps) {
  const { sessionId, rename, activity, activityReason, state } = useRailTerminal(projectId, terminal);
  const [stopping, setStopping] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const label = markLabel(rename.displayName, state);
  // Starting, there is no agent yet: the envelope's rest, muted.
  const mark = sessionId === null ? 'agent-idle' : agentActivityMark(activity, activityReason);

  const menuActions = useRailTerminalMenuActions(projectId, terminal, {
    onBringToFront,
    onStop: () => {
      if (stopping) return;
      setStopping(true);
      void onStop(terminal);
    },
    stopping,
    onRename: () => {
      if (!projectId) return;
      onBringToFront(terminal.windowId);
      useSessionStore.getState().requestCommandTerminalWindowAction(projectId, terminal.slot, 'rename');
    },
    renameDisabledReason: rename.disabledReason,
  });

  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          onClick={() => onBringToFront(terminal.windowId)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuPosition({ x: event.clientX, y: event.clientY });
          }}
          className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors ${MARK_TONE_CLASS[state]} ${
            front ? 'bg-surface-hover' : 'hover:bg-surface-hover/50'
          }`}
          aria-label={label}
          aria-current={front ? 'true' : undefined}
          data-testid="command-terminal-running-chip"
          data-command-slot={terminal.slot}
          data-activity={state}
          data-front={front ? 'true' : 'false'}
        >
          <ActivityMark mark={mark} size={20} />
        </button>
      </Tooltip>
      {menuPosition && (
        <CommandTerminalRowMenu position={menuPosition} onClose={() => setMenuPosition(null)} {...menuActions} />
      )}
    </>
  );
}

/** `text` with its matched stretch marked, as Quick Find marks a snippet. */
function Highlighted({ text, matchStart, matchEnd }: { text: string; matchStart: number; matchEnd: number }) {
  if (matchEnd <= matchStart) return <>{text}</>;
  return (
    <>
      {text.slice(0, matchStart)}
      <mark className="rounded bg-amber-400/30 px-0.5 text-fg">{text.slice(matchStart, matchEnd)}</mark>
      {text.slice(matchEnd)}
    </>
  );
}

interface EarlierRowProps {
  projectId: string;
  match: EarlierMatch;
  atCap: boolean;
  atCapReason: string;
  now: number;
  /** The name field is open. The list holds this, so it can keep the row mounted. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
  onRemove: (entry: CommandTerminalHistoryEntry) => void;
}

/**
 * One ended conversation. Its tip is its full name when the rail cuts it short,
 * read when the pointer or focus arrives, so a long list keeps no observer per
 * row. A search that matched a passage its name does not show puts that passage
 * under the name and the date beside it.
 */
function EarlierRow({ projectId, match, atCap, atCapReason, now, editing, onEditingChange, onResume, onRemove }: EarlierRowProps) {
  const { t } = useLingui();
  const { entry, nameMatch, snippet } = match;
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  // The committed name until the list carrying it arrives, so the row never
  // closes onto the old name for a frame. State set during render, as
  // `useCommandTerminalRename` holds its own: the push is what ends the hold.
  const [pending, setPending] = useState<{ label: string | null } | null>(null);
  if (pending && pending.label === entry.label) setPending(null);
  const storedName = commandTerminalHistoryName(pending ? { ...entry, label: pending.label } : entry);
  const name = storedName ?? t`Untitled conversation`;
  const ended = endedLabel(entry.endedAt, now);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const measureCut = (): void => {
    const span = nameRef.current;
    if (span) setCut(span.scrollWidth > span.clientWidth);
  };

  const commitName = (value: string): void => {
    onEditingChange(false);
    if (value.trim() === (storedName ?? '')) return;
    const label = normalizeCommandTerminalName(value, null);
    setPending({ label });
    window.electronAPI.sessions.renameCommandTerminalHistory(projectId, entry.agentSessionId, label)
      .then((saved) => {
        // Main refused it (a terminal holds the conversation now): show what it holds.
        if (!saved) setPending(null);
      })
      .catch((error: unknown) => {
        setPending(null);
        useToastStore.getState().addToast({
          title: t`Couldn't rename conversation`,
          message: asSentence(describeIpcError(error, String(error))),
          variant: 'error',
        });
      });
  };

  const closeMenu = (): void => setMenuPosition(null);

  return (
    // The wrapper takes the right-click: a disabled button would not, and a row
    // at the cap still renames and removes.
    <div
      onPointerEnter={measureCut}
      onFocus={measureCut}
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {editing ? (
        <div className="flex h-11 items-center gap-2.5 rounded-md bg-surface-hover/50 px-2">
          <History size={16} className="flex-shrink-0 text-fg-faint" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0">
              <CommandTerminalNameField
                initialName={storedName ?? ''}
                placeholder={entry.firstPrompt ?? t`Untitled conversation`}
                onCommit={commitName}
                onCancel={() => onEditingChange(false)}
                className="text-[13px] leading-5"
                data-testid="command-terminal-earlier-name-field"
              />
            </span>
            <span className="text-xs text-fg-muted">{ended}</span>
          </span>
        </div>
      ) : (
        // No tip for a name shown whole: the row reads as what it resumes. At
        // the cap it says why it is off.
        <Tooltip label={tipLabel({ disabled: atCap, disabledReason: atCapReason, tip: cut ? name : undefined })}>
          <button
            type="button"
            onClick={() => {
              if (!atCap) onResume(entry);
            }}
            aria-disabled={atCap}
            className={`flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors ${
              atCap ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-hover'
            } ${menuPosition ? 'bg-surface-hover' : ''}`}
            aria-label={t`Resume ${name}`}
            data-testid="command-terminal-earlier-row"
            data-agent-session-id={entry.agentSessionId}
          >
            <History size={16} className="flex-shrink-0 text-fg-faint" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-2">
                <span ref={nameRef} className="min-w-0 flex-1 truncate text-[13px] text-fg">
                  {nameMatch && !pending ? <Highlighted text={name} {...nameMatch} /> : name}
                </span>
                {snippet && <span className="flex-shrink-0 text-xs text-fg-muted">{ended}</span>}
              </span>
              {snippet ? (
                <span className="truncate text-xs text-fg-muted" data-testid="command-terminal-earlier-snippet">
                  <Highlighted {...snippet} />
                </span>
              ) : (
                <span className="text-xs text-fg-muted">{ended}</span>
              )}
            </span>
          </button>
        </Tooltip>
      )}
      {menuPosition && (
        <CommandTerminalContextMenu position={menuPosition} onClose={closeMenu} testId="command-terminal-earlier-menu">
          <KebabMenuItem
            icon={<CirclePlay size={14} />}
            label={t`Resume`}
            onClick={() => { closeMenu(); onResume(entry); }}
            disabled={atCap}
            disabledReason={atCap ? atCapReason : null}
            data-testid="command-terminal-earlier-menu-resume"
          />
          <KebabMenuItem
            icon={<Pencil size={14} />}
            label={t`Rename`}
            onClick={() => { closeMenu(); onEditingChange(true); }}
            data-testid="command-terminal-earlier-menu-rename"
          />
          <KebabMenuDivider />
          <KebabMenuItem
            icon={<Trash2 size={14} />}
            label={t`Remove`}
            onClick={() => { closeMenu(); onRemove(entry); }}
            destructive
            data-testid="command-terminal-earlier-menu-remove"
          />
        </CommandTerminalContextMenu>
      )}
    </div>
  );
}

/** What the Earlier list draws, in order. */
type EarlierListItem =
  | { kind: 'row'; key: string; match: EarlierMatch }
  | { kind: 'conversations-heading' | 'status' | 'note' | 'empty'; key: string };

function estimatedItemHeight(item: EarlierListItem): number {
  switch (item.kind) {
    case 'row':
      return EARLIER_ROW_PITCH_PX;
    case 'conversations-heading':
      return EARLIER_HEADING_PX;
    case 'empty':
      return EARLIER_EMPTY_PX;
    case 'status':
    case 'note':
      return EARLIER_LINE_PX;
  }
}

interface EarlierListProps {
  projectId: string;
  entries: CommandTerminalHistoryEntry[];
  atCap: boolean;
  atCapReason: string;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
}

/**
 * Every Earlier conversation, or those a search reaches, under a field and a
 * heading that stay put. Drawn through a virtualizer, since an agent that never
 * purges its transcripts gives this list no limit. Keyed by project in the rail,
 * so a project switch starts with an empty field.
 */
function EarlierList({ projectId, entries, atCap, atCapReason, onResume }: EarlierListProps) {
  const { t } = useLingui();
  const now = useMinuteClock();
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<CommandTerminalHistoryEntry | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const { active, nameMatches, textMatches, textPending, indexingOff } = useEarlierSearch(projectId, entries, search);
  const query = search.trim();

  const items = useMemo(() => {
    const rows: EarlierListItem[] = nameMatches.map((match) => ({ kind: 'row', key: match.entry.agentSessionId, match }));
    if (textMatches.length > 0) {
      rows.push({ kind: 'conversations-heading', key: 'conversations-heading' });
      for (const match of textMatches) rows.push({ kind: 'row', key: `text-${match.entry.agentSessionId}`, match });
    }
    if (active && textPending && textMatches.length === 0) rows.push({ kind: 'status', key: 'status' });
    if (active && !textPending && rows.length === 0) rows.push({ kind: 'empty', key: 'empty' });
    if (active && indexingOff) rows.push({ kind: 'note', key: 'note' });
    return rows;
  }, [nameMatches, textMatches, active, textPending, indexingOff]);

  // A row with its name field open stays mounted when it scrolls out of the
  // window. Unmounting it would drop the typed name with no save and no blur.
  const editingIndex = editingKey === null ? -1 : items.findIndex((item) => item.key === editingKey);
  const rangeExtractor = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range);
    if (editingIndex < 0 || indexes.includes(editingIndex)) return indexes;
    return [...indexes, editingIndex].sort((first, second) => first - second);
  }, [editingIndex]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimatedItemHeight(items[index]),
    getItemKey: (index) => items[index].key,
    overscan: 6,
    rangeExtractor,
  });

  // A new search starts at its best rows, wherever the list was.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query]);

  // The row leaves on main's push, so a refusal leaves it where it was.
  const confirmRemove = (entry: CommandTerminalHistoryEntry): void => {
    setRemoving(null);
    const failed = (message: string): void => {
      useToastStore.getState().addToast({ title: t`Couldn't remove conversation`, message, variant: 'error' });
    };
    window.electronAPI.sessions.removeCommandTerminalHistory(projectId, entry.agentSessionId)
      .then((removed) => {
        if (!removed) failed(t`A terminal has this conversation open.`);
      })
      .catch((error: unknown) => failed(asSentence(describeIpcError(error, String(error)))));
  };

  // No field, heading or hint until a conversation has ended. Past that this
  // keeps room for the field, the heading and a row, and the rail's body
  // scrolls when Running leaves it less.
  return (
    <div className={`flex flex-1 flex-col ${entries.length > 0 ? 'min-h-[124px]' : 'min-h-0'}`}>
      {entries.length > 0 && (
        <>
          <div className="relative flex-shrink-0 pt-1">
            <Search size={14} className="pointer-events-none absolute top-[calc(50%+2px)] left-2.5 -translate-y-1/2 text-fg-disabled" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                setSearch('');
                event.currentTarget.blur();
              }}
              placeholder={t`Search conversations...`}
              aria-label={t`Search conversations`}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-edge/50 bg-surface/50 pr-7 pl-7 text-xs text-fg placeholder-fg-muted outline-none transition-colors select-text focus:border-edge-input"
              data-testid="command-terminal-earlier-search"
            />
            {search && (
              <Tooltip label={t`Clear search`}>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute top-[calc(50%+2px)] right-2 -translate-y-1/2 text-fg-disabled transition-colors hover:text-fg-muted"
                  aria-label={t`Clear search`}
                  data-testid="command-terminal-earlier-search-clear"
                >
                  <X size={14} />
                </button>
              </Tooltip>
            )}
          </div>
          {(!active || nameMatches.length > 0) && (
            <div className="flex-shrink-0 px-2 pt-3 pb-1 text-xs text-fg-muted" data-testid="command-terminal-earlier-heading"><Trans>Earlier</Trans></div>
          )}
        </>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="command-terminal-earlier">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            return (
              <div
                key={item.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className={item.kind === 'row' ? 'pb-0.5' : ''}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
              >
                {item.kind === 'row' && (
                  <EarlierRow
                    projectId={projectId}
                    match={item.match}
                    atCap={atCap}
                    atCapReason={atCapReason}
                    now={now}
                    editing={editingKey === item.key}
                    onEditingChange={(editing) => setEditingKey(editing ? item.key : null)}
                    onResume={onResume}
                    onRemove={setRemoving}
                  />
                )}
                {item.kind === 'conversations-heading' && (
                  <div className="px-2 pt-3 pb-1 text-xs text-fg-muted" data-testid="command-terminal-earlier-text-heading"><Trans>In conversations</Trans></div>
                )}
                {item.kind === 'status' && (
                  <div className="px-2 py-2.5 text-xs text-fg-muted" data-testid="command-terminal-earlier-searching"><Trans>Searching conversations...</Trans></div>
                )}
                {item.kind === 'note' && (
                  <div className="px-2 py-2.5 text-xs text-fg-muted" data-testid="command-terminal-earlier-indexing-off"><Trans>Indexing is off, so conversation text was not searched</Trans></div>
                )}
                {item.kind === 'empty' && (
                  <div className="p-6 text-center" data-testid="command-terminal-earlier-empty">
                    <Search size={24} className="mx-auto mb-2 text-fg-disabled" />
                    <div className="text-sm text-fg-muted"><Trans>No conversations match</Trans></div>
                    <div className="mt-1 truncate text-xs text-fg-faint">{t`"${query}"`}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* BaseDialog renders inline and fixed, and the panel is transformed. */}
      {removing && createPortal(
        <ConfirmDialog
          title={t`Remove this conversation?`}
          message={t`It leaves Earlier and can no longer be searched. The agent keeps its transcript.`}
          confirmLabel={t`Remove`}
          variant="danger"
          testId="command-terminal-earlier-remove"
          onConfirm={() => confirmRemove(removing)}
          onCancel={() => setRemoving(null)}
        />,
        document.body,
      )}
    </div>
  );
}

interface CommandTerminalRailProps {
  projectId: string | null;
  /** Every terminal slot is taken. */
  atCap: boolean;
  /** Every terminal in the panel, in the order they tile. */
  terminals: RailCommandTerminal[];
  /** The terminal in front: the expanded one, else the focused tile. */
  frontWindowId: string | null;
  /** The width the terminals need beside the rail: the grid at the pane floor. */
  terminalsMinWidth: number;
  onNewTerminal: () => void;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
  /** Expand a terminal over the others while one is expanded; focus it while they tile. */
  onBringToFront: (windowId: string) => void;
  onStop: (terminal: RailCommandTerminal) => Promise<void>;
  /** Run a change that resizes the terminals so each holds its frame until it repaints. */
  onLayoutChange: (change: () => void) => void;
}

export function CommandTerminalRail({
  projectId,
  atCap,
  terminals,
  frontWindowId,
  terminalsMinWidth,
  onNewTerminal,
  onResume,
  onBringToFront,
  onStop,
  onLayoutChange,
}: CommandTerminalRailProps) {
  const { t } = useLingui();
  const { entries, hide } = useCommandTerminalHistory(projectId);
  const railRef = useRef<HTMLElement>(null);
  const rail = useCommandTerminalRail(railRef, onLayoutChange, terminalsMinWidth);
  // Why Add terminal and the Earlier rows are off: every slot is taken.
  const atCapReason = t`Stop one of the four to add another`;
  const addDisabledReason = atCap ? atCapReason : null;
  const handleResume = (entry: CommandTerminalHistoryEntry): void => {
    hide(entry.agentSessionId);
    onResume(entry);
  };

  // The edge drags the width, open or folded. It looks like the seam between two
  // terminals (`TileSplitter`): a 10px hit area on the boundary that shows a thin
  // accent line under the pointer and while it drags, and nothing at rest.
  const edge = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t`Rail width`}
      aria-valuemin={COMMAND_RAIL_MIN_WIDTH_PX}
      aria-valuemax={COMMAND_RAIL_MAX_WIDTH_PX}
      aria-valuenow={rail.width}
      onPointerDown={rail.onEdgePointerDown}
      className="group absolute inset-y-0 -right-[5px] z-10 w-2.5 cursor-col-resize select-none"
      data-testid="command-terminal-rail-edge"
    >
      <div
        className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
          rail.resizing ? 'bg-accent' : 'bg-transparent group-hover:bg-accent'
        }`}
        aria-hidden
      />
    </div>
  );

  const folded = rail.collapsed;
  const toggleLabel = folded ? t`Show rail` : t`Hide rail`;
  // Open, the button carries its word and needs no tip; folded, the strip's
  // icon has no room for it, so the tip names it.
  const toggleTip = folded ? toggleLabel : '';
  const hasRunning = terminals.length > 0;

  // One element in both states, its children in fixed slots, so folding keeps
  // the toggle the user pressed (and the keyboard focus on it). Open, it gives
  // way to the terminals' minimum in the same layout pass, down to its own
  // minimum: its resolved width follows the row a frame late, and a panel
  // shrinking under it would otherwise squeeze the terminals for that frame.
  return (
    <nav
      ref={railRef}
      aria-label={t`Command Terminals`}
      className={`relative flex ${folded ? 'flex-shrink-0' : 'flex-shrink'} flex-col border-r border-edge py-2.5 select-none ${folded ? 'items-start pl-1' : 'px-2'}`}
      style={{ width: rail.width, minWidth: folded ? undefined : COMMAND_RAIL_MIN_WIDTH_PX }}
      data-testid="command-terminal-rail"
      data-collapsed={folded ? 'true' : 'false'}
    >
      {folded ? (
        // The same row as the open rail's Add terminal, so folding moves nothing.
        <div className="flex-shrink-0 pb-1">
          <div className="flex h-[38px] items-center">
            <NewTerminalButton onNewTerminal={onNewTerminal} disabledReason={addDisabledReason} compact />
          </div>
        </div>
      ) : (
        <div className="flex-shrink-0 pb-1">
          <NewTerminalButton onNewTerminal={onNewTerminal} disabledReason={addDisabledReason} />
        </div>
      )}
      {hasRunning && folded && (
        <>
          {/* The Running heading's band, its rule in place of the word, and each
              mark in a row of the open rail's height: folding leaves every
              terminal's mark at the height its row had. */}
          <div className="flex h-8 flex-shrink-0 items-center" aria-hidden>
            <div className="mx-1 h-px w-5 bg-edge" />
          </div>
          <div className="flex flex-shrink-0 flex-col gap-0.5" data-testid="command-terminal-running">
            {terminals.map((terminal) => (
              <div key={terminal.windowId} className="flex h-9 items-center">
                <RunningMark
                  projectId={projectId}
                  terminal={terminal}
                  front={terminal.windowId === frontWindowId}
                  onBringToFront={onBringToFront}
                  onStop={onStop}
                />
              </div>
            ))}
          </div>
        </>
      )}
      {folded ? (
        <div className="min-h-0 flex-1" />
      ) : (
        // Scrolls only when Running leaves Earlier less than its minimum: the
        // Earlier list scrolls on its own at any ordinary height.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="command-terminal-rail-body">
          {hasRunning && (
            <>
              <div className="px-2 pt-3 pb-1 text-xs text-fg-muted"><Trans context="Agent status">Running</Trans></div>
              <div className="flex flex-shrink-0 flex-col gap-0.5" data-testid="command-terminal-running">
                {terminals.map((terminal) => (
                  <RunningRow
                    key={terminal.windowId}
                    projectId={projectId}
                    terminal={terminal}
                    front={terminal.windowId === frontWindowId}
                    onBringToFront={onBringToFront}
                    onStop={onStop}
                  />
                ))}
              </div>
              <div className="mx-0 mt-2.5 mb-1 h-px flex-shrink-0 bg-edge" aria-hidden />
            </>
          )}
          {projectId && (
            <EarlierList
              key={projectId}
              projectId={projectId}
              entries={entries}
              atCap={atCap}
              atCapReason={atCapReason}
              onResume={handleResume}
            />
          )}
        </div>
      )}
      {/* The rail's bottom row: open, the whole width with the icon and "Hide";
          folded, the strip's button. Outlined at rest, as the sidebar's Add
          project footer button is, so the row reads as one button before the
          pointer is on it. Either way the icon sits on the same spot, so a
          second click undoes the first without moving the pointer. */}
      <div className={`flex-shrink-0 pt-1 ${folded ? '' : '-mx-1'}`}>
        <Tooltip label={toggleTip}>
          <button
            type="button"
            onClick={rail.toggle}
            className={`flex h-8 items-center gap-1.5 rounded-md border border-edge/60 px-1 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-hover/40 hover:text-fg ${folded ? 'w-7' : 'w-full'}`}
            aria-label={toggleLabel}
            data-testid="command-terminal-rail-toggle"
          >
            {folded ? <PanelLeftOpen size={18} className="flex-shrink-0" /> : <PanelLeftClose size={18} className="flex-shrink-0" />}
            {!folded && <span className="truncate">{t({ message: 'Hide', context: 'Command Terminal rail fold button' })}</span>}
          </button>
        </Tooltip>
      </div>
      {edge}
    </nav>
  );
}
