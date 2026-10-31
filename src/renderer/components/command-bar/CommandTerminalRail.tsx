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
 * Earlier has no heading until a conversation has ended, then shows as many
 * rows as fit the rail and never scrolls: the list is a
 * way back to a recent conversation, not an archive. A row resumes its
 * conversation in place of an unused terminal (nothing has reached it yet), or
 * in a new terminal beside the others. At the cap both are off and say why. A
 * name the rail cuts short shows in full on hover.
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { formatMonthDay, formatTimeAgo } from '../../lib/datetime';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { commandTerminalHistoryName } from '../../../shared/command-terminal-name';
import { COMMAND_RAIL_MAX_WIDTH_PX, COMMAND_RAIL_MIN_WIDTH_PX } from '../../../shared/command-terminal-rail';
import { ActivityMark } from '../ActivityMark';
import { agentActivityMark } from '../board/agent-wait';
import { StopButtonIcon } from './StopButtonIcon';
import { NewTerminalButton } from './NewTerminalButton';
import { CommandTerminalNameField } from './CommandTerminalNameField';
import { CommandTerminalRowMenu } from './CommandTerminalRowMenu';
import { useCommandTerminalHistory } from './useCommandTerminalHistory';
import { useCommandTerminalRail } from './useCommandTerminalRail';
import { useCommandTerminalRename } from './useCommandTerminalRename';
import { useRailTerminalMenuActions, type RailCommandTerminal } from './useRailTerminalMenuActions';
import type { CommandTerminalHistoryEntry } from '../../../shared/types';

/** A terminal in the panel, as the Running list and the strip name it. */
export type RunningCommandTerminal = RailCommandTerminal;

/** One Earlier row (44px) plus the 2px gap between rows. */
const EARLIER_ROW_PITCH_PX = 46;
const EARLIER_ROW_GAP_PX = 2;

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

/** How many rows fit the list's height, measured as it changes. */
function useRowsThatFit(listRef: React.RefObject<HTMLDivElement | null>): number {
  const [rows, setRows] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = (): void => {
      setRows(Math.max(0, Math.floor((list.clientHeight + EARLIER_ROW_GAP_PX) / EARLIER_ROW_PITCH_PX)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef]);
  return rows;
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
function useRailTerminal(projectId: string | null, terminal: RunningCommandTerminal) {
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
  terminal: RunningCommandTerminal;
  /** This terminal is the one in front: the expanded one, else the focused tile. */
  front: boolean;
  onBringToFront: (windowId: string) => void;
  onStop: (terminal: RunningCommandTerminal) => Promise<void>;
}

/** One terminal: its live Stop button, then its name, which brings it to the front. */
function RunningRow({ projectId, terminal, front, onBringToFront, onStop }: RunningRowProps) {
  const { t } = useLingui();
  const { sessionId, rename, state } = useRailTerminal(projectId, terminal);
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

  const menuActions = useRailTerminalMenuActions(projectId, terminal, sessionId, {
    onBringToFront,
    onStop: () => { void handleStop(); },
    stopping,
    // Here, in the row: the terminal stays where it is.
    onRename: rename.startEditing,
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
          slot={terminal.slot}
          onCommit={(value) => rename.commit(value)}
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

  const menuActions = useRailTerminalMenuActions(projectId, terminal, sessionId, {
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

interface EarlierRowProps {
  entry: CommandTerminalHistoryEntry;
  atCap: boolean;
  atCapReason: string;
  now: number;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
}

/** One ended conversation. Its tip is its full name when the rail cuts it short. */
function EarlierRow({ entry, atCap, atCapReason, now, onResume }: EarlierRowProps) {
  const { t } = useLingui();
  const name = commandTerminalHistoryName(entry) ?? t`Untitled conversation`;
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const span = nameRef.current;
    if (!span) return;
    const measure = (): void => setCut(span.scrollWidth > span.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(span);
    return () => observer.disconnect();
  }, [name]);

  return (
    // No tip for a name shown whole: the row reads as what it resumes. At the
    // cap it says why it is off.
    <Tooltip label={tipLabel({ disabled: atCap, disabledReason: atCapReason, tip: cut ? name : undefined })}>
      <button
        type="button"
        onClick={() => onResume(entry)}
        disabled={atCap}
        className="flex h-11 flex-shrink-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        aria-label={t`Resume ${name}`}
        data-testid="command-terminal-earlier-row"
        data-agent-session-id={entry.agentSessionId}
      >
        <History size={16} className="flex-shrink-0 text-fg-faint" />
        <span className="flex min-w-0 flex-col">
          <span ref={nameRef} className="truncate text-[13px] text-fg">{name}</span>
          <span className="text-xs text-fg-muted">{endedLabel(entry.endedAt, now)}</span>
        </span>
      </button>
    </Tooltip>
  );
}

interface EarlierListProps {
  entries: CommandTerminalHistoryEntry[];
  atCap: boolean;
  atCapReason: string;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
}

/**
 * The Earlier rows that fit. Its own component, so it measures again whenever
 * the open rail mounts it (the folded rail has no list).
 */
function EarlierList({ entries, atCap, atCapReason, onResume }: EarlierListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowsThatFit = useRowsThatFit(listRef);
  const now = useMinuteClock();
  const visibleEntries = entries.slice(0, rowsThatFit);
  return (
    <>
      {/* No heading and no hint until a conversation has ended. The list stays
          mounted either way, so it has measured how many rows fit before the
          first one arrives. */}
      {entries.length > 0 && (
        <div className="px-2 pt-3 pb-1 text-xs text-fg-muted" data-testid="command-terminal-earlier-heading"><Trans>Earlier</Trans></div>
      )}
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden" data-testid="command-terminal-earlier">
        {visibleEntries.map((entry) => (
          <EarlierRow key={entry.agentSessionId} entry={entry} atCap={atCap} atCapReason={atCapReason} now={now} onResume={onResume} />
        ))}
      </div>
    </>
  );
}

interface CommandTerminalRailProps {
  projectId: string | null;
  /** Every terminal slot is taken. */
  atCap: boolean;
  /** Every terminal in the panel, in the order they tile. */
  terminals: RunningCommandTerminal[];
  /** The terminal in front: the expanded one, else the focused tile. */
  frontWindowId: string | null;
  /** The width the terminals need beside the rail: the grid at the pane floor. */
  terminalsMinWidth: number;
  onNewTerminal: () => void;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
  /** Expand a terminal over the others while one is expanded; focus it while they tile. */
  onBringToFront: (windowId: string) => void;
  onStop: (terminal: RunningCommandTerminal) => Promise<void>;
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

  // The edge drags the width, open or folded; it lights under the pointer and
  // while it drags, as the Workflows agent pane's edge does.
  const edge = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t`Rail width`}
      aria-valuemin={COMMAND_RAIL_MIN_WIDTH_PX}
      aria-valuemax={COMMAND_RAIL_MAX_WIDTH_PX}
      aria-valuenow={rail.width}
      onPointerDown={rail.onEdgePointerDown}
      className={`absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize select-none transition-colors ${
        rail.resizing ? 'bg-accent/50' : 'hover:bg-accent/30'
      }`}
      data-testid="command-terminal-rail-edge"
    />
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
      {hasRunning && !folded && (
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
      {folded ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <EarlierList entries={entries} atCap={atCap} atCapReason={atCapReason} onResume={handleResume} />
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
