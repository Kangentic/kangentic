import { EventType, IdleReason, type SessionEvent } from '../../shared/types';
import { looksLikeShellId } from './background-shell/looks-like-shell-id';

/**
 * What a session still has open, read from the hook events the agent wrote,
 * never from the activity engine's display state.
 *
 * The engine's own counters exist to paint the card, and they are reset by
 * design whenever a reading looks stuck: the background-shell escape hatch
 * clears its shells after five quiet minutes, a non-permission idle or a
 * watchdog empties the pending tool stack, and a `subagent_start` used to
 * clear a permission prompt. Each reset is right for a card. None is evidence
 * that the work ended, and three overnight failures came from reading one as
 * if it were:
 *
 * - A recovery nudge typed into a permission prompt the engine had lost. A
 *   parallel subagent's start cleared the flag 4 ms after it was raised, and the
 *   stale-thinking watchdog emptied the stack 14 minutes later, so the nudge's
 *   Enter approved a tool call nobody saw.
 * - An automatic pause stopped agents whose own gate was still running in the
 *   background, after the hatch dropped the shell from the hold.
 * - The step check ruled a session "still working" or "not done" from the
 *   wording of its reply, with the same gate running both times.
 *
 * So the ledger keeps its own record, and only an event that says the work
 * ended closes an entry:
 *
 * - **A tool call** opens on its `tool_start` and closes on its own `tool_end`
 *   (by id, else the newest open call of that name), on its promotion to a
 *   background shell, on `interrupted` or `turn_failed`, on a turn end (an
 *   `idle` the main agent wrote that is not a permission prompt), on a denial
 *   read from the transcript, and on the session's end. Never on a
 *   `subagent_start`, a `prompt`, a notification, an `idle_hint` or any reset.
 * - **A background shell** opens when the engine starts holding a named shell
 *   (`noteHoldingShell`: an exempt service never opens), with the command that
 *   started it: an anonymous launch's, or that of the tool call the CLI moved
 *   to the background, carried by the call's own id. It closes on an end that
 *   names it, a watcher end the engine applied (`closeShells`), the
 *   transcript's notice even after the engine drained it, a Monitor's own
 *   `timeoutMs` running out, being marked a service, and the session's end.
 *   Never on the escape hatch.
 * - **A subagent** opens on its `subagent_start` and closes on its named
 *   `subagent_stop`, `interrupted`, `turn_failed` and the session's end. One
 *   still open after a turn end is background work: the agent ended its turn
 *   while it ran.
 *
 * A lost end fails safe: Kangentic types nothing and pauses nothing while an
 * entry is open, and the workflow's working wait bounds how long it waits. It
 * is a real bound: a running workflow's turn is judged at its Stop with the
 * shell still open (`'turn-ended-held'`), and the wait counts from when the
 * oldest open entry started.
 * The ledger itself is pure, with no engine and no clock of its own, so the
 * rules above are unit tested on event sequences alone.
 */

export interface OpenToolCall {
  /** The call's correlation id, or null for an agent that reports none. */
  id: string | null;
  tool: string;
  /** Epoch ms of its `tool_start`. */
  since: number;
  /**
   * What the `tool_start` said it runs (its detail: a command, a path), or
   * null. Kept for a call the CLI moves to the background, whose shell entry
   * would otherwise name no command.
   */
  command: string | null;
}

export interface OpenBackgroundShell {
  id: string;
  /** The command that started it, when the launch reported one. */
  command: string | null;
  since: number;
}

export interface OpenSubagent {
  id: string;
  /** The subagent's type (`subagent_start`'s detail), when reported. */
  type: string | null;
  since: number;
}

export interface OpenWork {
  toolCalls: OpenToolCall[];
  backgroundShells: OpenBackgroundShell[];
  /** Subagents still open after a turn end: background work, not the turn's own. */
  backgroundSubagents: OpenSubagent[];
}

interface SessionLedger {
  toolCalls: OpenToolCall[];
  shells: Map<string, OpenBackgroundShell>;
  subagents: Map<string, OpenSubagent>;
  /** The command an anonymous background launch reported, until its id arrives. */
  pendingLaunchCommand: string | null;
  /**
   * The command of a tool call that moved to the background, by the shell id
   * it moved to: a foreground Bash the CLI backgrounded at its timeout, or a
   * Monitor. Keyed by the call's own id, so a parallel launch never lends it
   * its command. Taken when the engine starts holding that shell.
   */
  movedCallCommands: Map<string, string>;
  /**
   * When a held shell's own time limit runs out (epoch ms), by shell id: a
   * Monitor reports its `timeoutMs`. Set only for a holder that reported one.
   */
  expiresAt: Map<string, number>;
  /** Epoch ms of the main agent's latest turn end. */
  lastTurnEndAt: number | null;
}

export class OpenWorkLedger {
  private sessions = new Map<string, SessionLedger>();

  private ledgerFor(sessionId: string): SessionLedger {
    let ledger = this.sessions.get(sessionId);
    if (!ledger) {
      ledger = {
        toolCalls: [],
        shells: new Map(),
        subagents: new Map(),
        pendingLaunchCommand: null,
        movedCallCommands: new Map(),
        expiresAt: new Map(),
        lastTurnEndAt: null,
      };
      this.sessions.set(sessionId, ledger);
    }
    return ledger;
  }

  /**
   * One hook event the engine admitted. Call it for the agent's own events
   * only: an internal CLI agent's tool events never end, and are left out by
   * the caller as the engine leaves them out of everything but its count.
   */
  observe(sessionId: string, event: SessionEvent): void {
    const ledger = this.ledgerFor(sessionId);
    switch (event.type) {
      case EventType.ToolStart:
        if (event.tool) {
          ledger.toolCalls.push({ id: event.toolId ?? null, tool: event.tool, since: event.ts, command: event.detail || null });
        }
        return;
      case EventType.ToolEnd:
        closeToolCall(ledger, event.toolId, event.tool);
        return;
      case EventType.BackgroundShellStart: {
        // A foreground call Claude moved to the background: it did not end, it
        // moved, so it stops being an open tool call. Id-only, as the engine.
        // Its command goes with it to the shell it became.
        const moved = event.toolId !== undefined ? closeToolCall(ledger, event.toolId, undefined, { byIdOnly: true }) : null;
        if (moved?.command && event.detail && looksLikeShellId(event.detail)) {
          ledger.movedCallCommands.set(event.detail, moved.command);
        }
        // The launch's PreToolUse carries the command; the id comes after.
        if (event.detail && !looksLikeShellId(event.detail)) ledger.pendingLaunchCommand = event.detail;
        return;
      }
      case EventType.BackgroundShellEnd:
        if (event.detail) {
          ledger.shells.delete(event.detail);
          ledger.expiresAt.delete(event.detail);
        }
        return;
      case EventType.SubagentStart:
        if (event.subagentId) {
          ledger.subagents.set(event.subagentId, { id: event.subagentId, type: event.detail ?? null, since: event.ts });
        }
        return;
      case EventType.SubagentStop:
        // An empty detail is a subagent's inner-loop stop, long before its real
        // one (see `updateCounters`), so it ends nothing.
        if (event.subagentId && event.detail !== '') ledger.subagents.delete(event.subagentId);
        return;
      case EventType.Interrupted:
      case EventType.TurnFailed:
        ledger.toolCalls.length = 0;
        ledger.subagents.clear();
        return;
      case EventType.Idle:
        // A permission prompt pauses the call it asks about. A subagent's own
        // Stop ends its turn, not the main agent's.
        if (event.detail === IdleReason.Permission || event.subagentId) return;
        ledger.toolCalls.length = 0;
        ledger.lastTurnEndAt = event.ts;
        return;
      case EventType.SessionEnd:
        this.forget(sessionId);
        return;
      default:
        return;
    }
  }

  /**
   * An interrupt the app synthesized (a Ctrl+C or Esc that fired no hook).
   * The CLI's interrupt ends every call in flight, a prompt it was asking
   * included, so it ends what the hook would have.
   */
  noteInterrupted(sessionId: string): void {
    const ledger = this.sessions.get(sessionId);
    if (!ledger) return;
    ledger.toolCalls.length = 0;
    ledger.subagents.clear();
  }

  /**
   * The engine started holding this named shell (it is not an exempt service).
   * `expiresAfterMs` is the holder's own time limit, when it reported one.
   */
  noteHoldingShell(sessionId: string, shellId: string, at: number, expiresAfterMs?: number): void {
    const ledger = this.ledgerFor(sessionId);
    if (ledger.shells.has(shellId)) return;
    if (expiresAfterMs !== undefined && Number.isFinite(expiresAfterMs) && expiresAfterMs > 0) {
      ledger.expiresAt.set(shellId, at + expiresAfterMs);
    }
    const movedCommand = ledger.movedCallCommands.get(shellId);
    if (movedCommand !== undefined) {
      // A moved call's own command; a launch still waiting for its id keeps its own.
      ledger.movedCallCommands.delete(shellId);
      ledger.shells.set(shellId, { id: shellId, command: movedCommand, since: at });
      return;
    }
    ledger.shells.set(shellId, { id: shellId, command: ledger.pendingLaunchCommand, since: at });
    ledger.pendingLaunchCommand = null;
  }

  /** Shells that really ended (a watcher end the engine applied), or were marked services. */
  closeShells(sessionId: string, shellIds: Iterable<string>): void {
    const ledger = this.sessions.get(sessionId);
    if (!ledger) return;
    for (const shellId of shellIds) {
      ledger.shells.delete(shellId);
      ledger.movedCallCommands.delete(shellId);
      ledger.expiresAt.delete(shellId);
    }
  }

  /** Open shells whose own time limit ran out by `now`. */
  expiredShellIds(sessionId: string, now: number): string[] {
    const ledger = this.sessions.get(sessionId);
    if (!ledger) return [];
    const expired: string[] = [];
    for (const [shellId, expiresAt] of ledger.expiresAt) {
      if (expiresAt <= now && ledger.shells.has(shellId)) expired.push(shellId);
    }
    return expired;
  }

  /** A permission prompt the user denied, read from the transcript. */
  closeToolCallById(sessionId: string, toolId: string): void {
    const ledger = this.sessions.get(sessionId);
    if (ledger) closeToolCall(ledger, toolId, undefined, { byIdOnly: true });
  }

  get(sessionId: string): OpenWork {
    const ledger = this.sessions.get(sessionId);
    // Fresh arrays every call, as below: a caller may sort or trim its copy.
    if (!ledger) return { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };
    const turnEndedAt = ledger.lastTurnEndAt;
    return {
      toolCalls: [...ledger.toolCalls],
      backgroundShells: [...ledger.shells.values()],
      backgroundSubagents: turnEndedAt === null
        ? []
        : [...ledger.subagents.values()].filter((subagent) => subagent.since <= turnEndedAt),
    };
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Close one open call and return it, or null when none matched. */
function closeToolCall(
  ledger: SessionLedger,
  toolId: string | undefined,
  tool: string | undefined,
  options: { byIdOnly?: boolean } = {},
): OpenToolCall | null {
  if (toolId !== undefined) {
    const index = ledger.toolCalls.findIndex((call) => call.id === toolId);
    if (index >= 0) return ledger.toolCalls.splice(index, 1)[0];
    if (options.byIdOnly) return null;
  }
  if (!tool) return null;
  for (let index = ledger.toolCalls.length - 1; index >= 0; index -= 1) {
    if (ledger.toolCalls[index].tool === tool) return ledger.toolCalls.splice(index, 1)[0];
  }
  return null;
}
