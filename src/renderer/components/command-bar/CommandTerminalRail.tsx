/**
 * The Command Terminal panel's left rail: Running while one terminal is
 * expanded, Earlier (the project's ended conversations, newest first), and New
 * terminal at its foot.
 *
 * Running lists the terminals behind the expanded one. Each row's mark is that
 * terminal's own Stop button, so one can be stopped without bringing it back,
 * and its title expands it instead.
 *
 * Earlier shows as many rows as fit the rail and never scrolls: the list is a
 * way back to a recent conversation, not an archive. A row resumes its
 * conversation in place of an unused terminal (nothing has reached it yet), or
 * in a new terminal beside the others. At the cap both are off and say why.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History, SquarePlus } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { formatMonthDay, formatTimeAgo } from '../../lib/datetime';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { commandTerminalDisplayName } from '../../../shared/command-terminal-name';
import { StopButtonIcon } from './StopButtonIcon';
import { useCommandTerminalHistory } from './useCommandTerminalHistory';
import type { CommandTerminalHistoryEntry } from '../../../shared/types';

/** A terminal behind the expanded one, as the Running list names it. */
export interface RunningCommandTerminal {
  windowId: string;
  slot: string;
}

/** One Earlier row (44px) plus the 2px gap between rows. */
const EARLIER_ROW_PITCH_PX = 46;
const EARLIER_ROW_GAP_PX = 2;

const AT_CAP_REASON = 'Four terminals are running. Stop one to start another.';

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

interface RunningRowProps {
  projectId: string | null;
  terminal: RunningCommandTerminal;
  onExpand: (windowId: string) => void;
  onStop: (terminal: RunningCommandTerminal) => Promise<void>;
}

/** One terminal behind the expanded one: its live Stop button, then its name. */
function RunningRow({ projectId, terminal, onExpand, onStop }: RunningRowProps) {
  const sessionId = useSessionStore((state) =>
    projectId ? state.transientSessions[transientKey(projectId, terminal.slot)]?.sessionId ?? null : null);
  const label = useSessionStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.commandTerminalLabel ?? null : null);
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const [stopping, setStopping] = useState(false);
  const name = commandTerminalDisplayName(label, terminal.slot);
  const isThinking = sessionId !== null && isActive(activity);
  const isIdle = sessionId !== null && requiresUserInteraction(activity);

  const handleStop = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    // The row unmounts with its window; nothing to reset after.
    await onStop(terminal);
  };

  return (
    <div className="flex h-9 flex-shrink-0 items-center gap-2.5 rounded-md px-2 hover:bg-surface-hover" data-testid="command-terminal-running-row" data-command-slot={terminal.slot}>
      <Tooltip label="Stop. It moves to Earlier.">
        <button
          type="button"
          onClick={() => void handleStop()}
          disabled={stopping}
          className={`inline-flex flex-shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed ${
            stopping ? 'text-fg-muted' : isThinking || isIdle ? '' : 'text-red-400'
          }`}
          aria-label={`Stop ${name}`}
          data-testid="command-terminal-running-stop"
        >
          <StopButtonIcon isThinking={isThinking} isIdle={isIdle} stopping={stopping} />
        </button>
      </Tooltip>
      <Tooltip label={name}>
        <button
          type="button"
          onClick={() => onExpand(terminal.windowId)}
          className="min-w-0 flex-1 truncate text-left text-[13px] text-fg"
          aria-label={`Expand ${name}`}
          data-testid="command-terminal-running-expand"
        >
          {name}
        </button>
      </Tooltip>
    </div>
  );
}

interface CommandTerminalRailProps {
  projectId: string | null;
  /** Every terminal slot is taken. */
  atCap: boolean;
  /** A row would resume in place of the unused terminal, rather than beside it. */
  resumesInPlace: boolean;
  /** The terminals behind the expanded one, in the order they tile; null while none is expanded. */
  running: RunningCommandTerminal[] | null;
  onNewTerminal: () => void;
  onResume: (entry: CommandTerminalHistoryEntry) => void;
  onExpand: (windowId: string) => void;
  onStop: (terminal: RunningCommandTerminal) => Promise<void>;
}

export function CommandTerminalRail({
  projectId,
  atCap,
  resumesInPlace,
  running,
  onNewTerminal,
  onResume,
  onExpand,
  onStop,
}: CommandTerminalRailProps) {
  const { entries, hide } = useCommandTerminalHistory(projectId);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsThatFit = useRowsThatFit(listRef);
  const now = useMinuteClock();
  const visibleEntries = entries.slice(0, rowsThatFit);

  return (
    <nav
      aria-label="Command Terminals"
      className="flex w-[248px] flex-shrink-0 flex-col border-r border-edge px-2 pt-2.5 select-none"
      data-testid="command-terminal-rail"
    >
      {running && running.length > 0 && (
        <>
          <div className="px-2 pt-3 pb-1 text-xs text-fg-muted">Running</div>
          <div className="flex flex-shrink-0 flex-col gap-0.5" data-testid="command-terminal-running">
            {running.map((terminal) => (
              <RunningRow key={terminal.windowId} projectId={projectId} terminal={terminal} onExpand={onExpand} onStop={onStop} />
            ))}
          </div>
          <div className="mx-0 mt-2.5 mb-1 h-px flex-shrink-0 bg-edge" aria-hidden />
        </>
      )}
      <div className="px-2 pt-3 pb-1 text-xs text-fg-muted">Earlier</div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden" data-testid="command-terminal-earlier">
        {entries.length === 0 ? (
          <div className="px-2 py-1 text-sm text-fg-faint" data-testid="command-terminal-earlier-empty">
            Stop a terminal and you can resume it from here.
          </div>
        ) : (
          visibleEntries.map((entry) => {
            const name = entry.label ?? 'Untitled conversation';
            return (
              <Tooltip
                key={entry.agentSessionId}
                label={tipLabel({
                  disabled: atCap,
                  disabledReason: AT_CAP_REASON,
                  tip: resumesInPlace ? 'Resume here, in place of the unused terminal' : 'Resume in a new terminal',
                })}
              >
                <button
                  type="button"
                  onClick={() => {
                    hide(entry.agentSessionId);
                    onResume(entry);
                  }}
                  disabled={atCap}
                  className="flex h-11 flex-shrink-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  aria-label={`Resume ${name}`}
                  data-testid="command-terminal-earlier-row"
                  data-agent-session-id={entry.agentSessionId}
                >
                  <History size={16} className="flex-shrink-0 text-fg-faint" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] text-fg">{name}</span>
                    <span className="text-xs text-fg-muted">{endedLabel(entry.endedAt, now)}</span>
                  </span>
                </button>
              </Tooltip>
            );
          })
        )}
      </div>
      <div className="-mx-2 flex-shrink-0 p-3">
        <Tooltip label={tipLabel({ disabled: atCap, disabledReason: AT_CAP_REASON })}>
          <button
            type="button"
            onClick={onNewTerminal}
            disabled={atCap}
            className="flex h-[38px] w-full items-center justify-center gap-2 rounded-lg bg-accent-emphasis px-3 text-[13px] font-semibold text-accent-on transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent-emphasis"
            data-testid="command-terminal-new"
          >
            <SquarePlus size={16} strokeWidth={2.25} />
            New terminal
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
