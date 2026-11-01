import type { SessionUsage } from '../../shared/types';

/**
 * How many ids each per-session list keeps. A session sees one confirmation
 * per real move and one held id per extra writer, so a handful covers every
 * case measured; the cap only stops a pathological writer from growing them.
 */
const MAX_TRACKED_IDS = 8;

/** What the status channel does with a write that reports another conversation. */
export type StatusIdVerdict = 'switch' | 'hold';

interface GateState {
  /** Ids a conversation-moving SessionStart named, not yet switched to. Oldest first. */
  confirmed: string[];
  /** The latest usage each unconfirmed id reported, oldest first. */
  held: Map<string, SessionUsage>;
}

/**
 * Decides whether a status-file write that reports a new agent session id is
 * the terminal's conversation moving, or another process writing the same file.
 *
 * Every process started with a session's `--settings` runs its statusLine into
 * that session's one status.json. Claude Code 2.1.316's background daemon
 * starts two at once, the conversation it moved (SessionStart `fork`) and an
 * empty spare (SessionStart `startup`), and their writes alternate about 0.6 s
 * apart on each 10 s refresh. Read as one writer, every alternation was a
 * conversation switch: a toast, a resume-id rewrite and a usage reset each time.
 *
 * So a new id is adopted only once a SessionStart that moves the conversation
 * (`statusFile.parseSessionStart`) named it. The rules:
 * - The session's first id is its baseline and needs no hook. `SessionTelemetry`
 *   never asks the gate about it, so a `--resume` that silently started fresh
 *   (a new id, SessionStart `startup`) is still followed.
 * - A confirmation is spent by the switch it allows, with every older one: a
 *   move it superseded must not be adopted from a late write. One naming the
 *   current id (a compaction, the spawn's own resume hook) is ignored, so
 *   nothing lingers that could later carry a stale writer's id back. An id that
 *   was replaced comes back only through a new hook that names it, as an
 *   in-TUI `/resume` to an earlier conversation sends.
 * - The hook and the status write race, so either may come first. A write
 *   without a confirmation is held, and the confirmation that arrives later
 *   hands its usage back to be applied at once.
 */
export class ConversationSwitchGate {
  private readonly states = new Map<string, GateState>();

  /**
   * A SessionStart that moves the conversation named `agentSessionId`. Returns
   * the usage a write of that id left held, for the caller to apply now, or null.
   */
  confirm(sessionId: string, agentSessionId: string, currentId: string | undefined): SessionUsage | null {
    if (agentSessionId === currentId) return null;
    const state = this.stateFor(sessionId);
    rememberLatest(state.confirmed, agentSessionId);
    const heldUsage = state.held.get(agentSessionId) ?? null;
    state.held.delete(agentSessionId);
    return heldUsage;
  }

  /**
   * A status write reports `reportedId`, which is not the current id. `switch`
   * when a hook confirmed it (the caller adopts it); otherwise its usage is held.
   */
  admit(sessionId: string, reportedId: string, usage: SessionUsage): StatusIdVerdict {
    const state = this.stateFor(sessionId);
    if (state.confirmed.includes(reportedId)) return 'switch';
    state.held.delete(reportedId);
    state.held.set(reportedId, usage);
    while (state.held.size > MAX_TRACKED_IDS) {
      const oldest = state.held.keys().next().value;
      if (oldest === undefined) break;
      state.held.delete(oldest);
    }
    return 'hold';
  }

  /**
   * The session now follows `agentSessionId`: its confirmation is spent and
   * nothing of it stays held. Confirmations recorded before it go too: they
   * were for moves this one superseded (a /resume choice followed at once by a
   * /clear), and a late write from one of those must not be adopted. Newer
   * ones stay, so two quick moves in a row still land.
   */
  adopt(sessionId: string, agentSessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    const index = state.confirmed.indexOf(agentSessionId);
    if (index !== -1) state.confirmed.splice(0, index + 1);
    state.held.delete(agentSessionId);
  }

  removeSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private stateFor(sessionId: string): GateState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { confirmed: [], held: new Map() };
      this.states.set(sessionId, state);
    }
    return state;
  }
}

/** Append `id` as the newest entry, dropping an earlier copy and the oldest past the cap. */
function rememberLatest(ids: string[], id: string): void {
  const existing = ids.indexOf(id);
  if (existing !== -1) ids.splice(existing, 1);
  ids.push(id);
  while (ids.length > MAX_TRACKED_IDS) ids.shift();
}
