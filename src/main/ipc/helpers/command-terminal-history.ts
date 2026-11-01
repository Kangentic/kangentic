/**
 * Keeps the record of the conversations Command Terminals held, so the panel's
 * Earlier list (and a paired phone) can resume one after its terminal ended.
 *
 * A Command Terminal has no `sessions` row, and its registry row goes when it
 * ends, taking its agent session id with it. So the record is written here, in
 * main, from SessionManager's own events, for every terminal (one a phone
 * started, or one in a project the desktop does not have open, included):
 *
 * - The agent reports its session id: the conversation gets a row. A `/clear`
 *   or `/resume` inside the terminal reports a new id, which ends the previous
 *   conversation's row and starts one for the new.
 * - Someone uses the terminal (`Session.hasUserInput`): the row is marked
 *   touched. Only touched rows are listed, and an untouched one is deleted when
 *   it ends, so a terminal nobody used leaves nothing behind.
 * - The terminal is named, renamed or cleared: the row follows the change. A
 *   status push that does not change the name writes nothing, so a
 *   conversation `/resume`d into a renamed terminal keeps its own name.
 * - The first prompt reaches the agent: the row keeps it, on one line, so a
 *   conversation nothing named still reads as what it was about.
 * - The terminal ends: the row is stamped ended, and the conversation's text is
 *   indexed for the Earlier list's search.
 * - Someone renames or removes the row in the Earlier list: no live terminal
 *   holds it, so the row is all there is to change.
 *
 * Rows are written as the id is captured, not when the terminal ends, because a
 * quit removes no row (`killAll` never calls `remove()`): a terminal open at
 * quit keeps its row, and the list stamps its end the first time it reads it,
 * or deletes the row if nobody used that terminal.
 */
import PQueue from 'p-queue';
import {
  EventType,
  PromptReason,
  type CommandTerminalHistoryEntry,
  type CommandTerminalHistorySearchResult,
  type Session,
  type SessionEvent,
  type StoredCliTarget,
} from '../../../shared/types';
import { serializeCliTarget } from '../../agent/shared/cli-target';
import { normalizeCommandTerminalName } from '../../../shared/command-terminal-name';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import type { CommandTerminalHistoryRepository, CommandTerminalHistoryRow } from '../../db/repositories/command-terminal-history-repository';

type AgentSessionIdListener = (sessionId: string, taskId: string, projectId: string, agentSessionId: string) => void;
type SessionListener = (sessionId: string, session?: Session) => void;
type SessionEventListener = (sessionId: string, event: SessionEvent) => void;

/** Longer than any rail or phone row shows; the row cuts it with an ellipsis. */
const FIRST_PROMPT_MAX_LENGTH = 200;

/** Transcript checks one list runs at a time. An agent's miss can scan a folder per project. */
const AVAILABILITY_CHECKS_AT_ONCE = 8;

/**
 * How long a transcript found for a list stays known. A rename or a terminal's
 * end re-lists every row, and neither changes which transcripts exist. A resume
 * asks the agent itself, so a row shown stale costs only its `conversation-gone`.
 */
const AVAILABILITY_RECHECK_MS = 5 * 60 * 1000;

/** A prompt on one line, as a row shows it, or null when it says nothing. */
export function firstPromptLine(promptText: string): string | null {
  const line = promptText.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, FIRST_PROMPT_MAX_LENGTH) : null;
}

export interface CommandTerminalHistorySessionSource {
  on(event: 'agent-session-id', listener: AgentSessionIdListener): unknown;
  on(event: 'session-changed' | 'session-removed', listener: SessionListener): unknown;
  on(event: 'event', listener: SessionEventListener): unknown;
  off(event: 'agent-session-id', listener: AgentSessionIdListener): unknown;
  off(event: 'session-changed' | 'session-removed', listener: SessionListener): unknown;
  off(event: 'event', listener: SessionEventListener): unknown;
  getSession(sessionId: string): Session | undefined;
  getSessionAgentName(sessionId: string): string | undefined;
  /** Where the session's CLI runs when it is not this machine (a WSL distro), or null. */
  getSessionCliTarget?(sessionId: string): StoredCliTarget | null;
  listSessions(): Session[];
}

export interface CommandTerminalHistoryDeps {
  sessionManager: CommandTerminalHistorySessionSource;
  /** The project's repository, or null when its database cannot be opened. */
  getRepository(projectId: string): CommandTerminalHistoryRepository | null;
  /**
   * Whether the conversation can still be resumed: its agent resumes by id and
   * can still find the transcript (an agent purges old ones). Never throws.
   */
  conversationAvailable(agentName: string, agentSessionId: string, cwd: string, cliTarget: string | null): Promise<boolean>;
  /** Push `COMMAND_TERMINAL_HISTORY_CHANGED` for the project. */
  notifyChanged(projectId: string): void;
  /**
   * A conversation ended or its row went: read its text into the search index,
   * or drop it from there when the row is gone. Never throws.
   */
  conversationEnded(projectId: string, agentSessionId: string): void;
  /** Search the project's conversation text. Never throws. */
  searchText(projectId: string, query: string): Promise<CommandTerminalHistorySearchResult>;
}

/** What the record knows about the conversation a live terminal holds. */
interface HeldConversation {
  projectId: string;
  agentSessionId: string;
  touched: boolean;
  /** The terminal's live name when last seen, so only a CHANGE of it is written. */
  label: string | null;
  /** Whether a user had named the terminal when last seen, written on a change as the name is. */
  namedByUser: boolean;
  /** Its first prompt has been written. */
  prompted: boolean;
}

export class CommandTerminalHistory {
  private readonly heldBySession = new Map<string, HeldConversation>();
  /**
   * A first prompt that arrived before the terminal's agent reported its id,
   * by terminal, written to the row the id then records.
   */
  private readonly promptBeforeRow = new Map<string, string>();
  /**
   * A user's rename (or clear) that landed before the terminal's agent
   * reported its id, by terminal. A resume seeds the terminal with the row's
   * old name and the id arrives a second or two after the spawn, so a rename in
   * that gap is held here and written over the row once the id records it.
   */
  private readonly labelBeforeRow = new Map<string, string | null>();
  /**
   * Conversations a resume is starting, by agent session id, with the terminal
   * that took each once it spawned (null while the start runs). A resumed
   * terminal reports its agent's id a second or two after it spawns, so until
   * then this is the only record that the conversation is open.
   */
  private readonly resumesInFlight = new Map<string, string | null>();
  /** When each conversation's transcript was last found, by agent session id. */
  private readonly transcriptFoundAt = new Map<string, number>();
  private started = false;
  private disposed = false;

  constructor(private readonly deps: CommandTerminalHistoryDeps) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.deps.sessionManager.on('agent-session-id', this.onAgentSessionId);
    this.deps.sessionManager.on('session-changed', this.onSessionChanged);
    this.deps.sessionManager.on('session-removed', this.onSessionRemoved);
    this.deps.sessionManager.on('event', this.onSessionEvent);
  }

  /** Synchronous: detaches the listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.deps.sessionManager.off('agent-session-id', this.onAgentSessionId);
      this.deps.sessionManager.off('session-changed', this.onSessionChanged);
      this.deps.sessionManager.off('session-removed', this.onSessionRemoved);
      this.deps.sessionManager.off('event', this.onSessionEvent);
    }
    this.heldBySession.clear();
    this.promptBeforeRow.clear();
    this.labelBeforeRow.clear();
    this.resumesInFlight.clear();
    this.transcriptFoundAt.clear();
  }

  /**
   * Claim a conversation for a resume. False when a live terminal holds it, or
   * another resume is starting it: two agents on one conversation would write
   * over each other's transcript. The project's Earlier list drops it at once.
   */
  claimResume(projectId: string, agentSessionId: string): boolean {
    if (this.resumesInFlight.has(agentSessionId)) return false;
    for (const held of this.heldBySession.values()) {
      if (held.agentSessionId === agentSessionId) return false;
    }
    const liveSessionHoldsIt = this.deps.sessionManager.listSessions()
      .some((session) => session.agentSessionId === agentSessionId && session.status !== 'exited');
    if (liveSessionHoldsIt) return false;
    this.resumesInFlight.set(agentSessionId, null);
    this.deps.notifyChanged(projectId);
    return true;
  }

  /**
   * A claimed resume's start is over. Its terminal keeps the claim until the
   * agent reports the conversation's id or the terminal ends; a start that made
   * no terminal (null) frees it at once, and its row comes back to Earlier.
   */
  settleResume(projectId: string, agentSessionId: string, sessionId: string | null): void {
    if (!this.resumesInFlight.has(agentSessionId)) return;
    const alreadyReported = sessionId !== null
      && (this.heldBySession.has(sessionId) || this.deps.sessionManager.getSession(sessionId)?.agentSessionId === agentSessionId);
    if (sessionId === null || alreadyReported || this.disposed) this.resumesInFlight.delete(agentSessionId);
    else this.resumesInFlight.set(agentSessionId, sessionId);
    if (sessionId === null && !this.disposed) this.deps.notifyChanged(projectId);
  }

  /** Drop the claims the given terminal held. */
  private releaseResumesOf(sessionId: string): void {
    for (const [agentSessionId, holder] of this.resumesInFlight) {
      if (holder === sessionId) this.resumesInFlight.delete(agentSessionId);
    }
  }

  /**
   * The project's earlier conversations, newest first: used, ended (no live
   * terminal holds them), and still resumable. A row whose transcript is gone
   * is deleted, since it can never be resumed again.
   */
  async list(projectId: string): Promise<CommandTerminalHistoryEntry[]> {
    const repository = this.deps.getRepository(projectId);
    if (!repository) return [];
    const liveConversationIds = this.liveConversationIds(projectId);
    let rows: CommandTerminalHistoryRow[];
    try {
      // Before any await, while the live set still describes the terminals:
      // a row nobody used whose terminal was open at a quit has no end, and is
      // never listed, so nothing else would remove it.
      repository.deleteUnusedExcept(liveConversationIds);
      rows = repository.listUsed();
    } catch (error) {
      warn('list', error);
      return [];
    }
    const checks = new PQueue({ concurrency: AVAILABILITY_CHECKS_AT_ONCE });
    const availability = await checks.addAll(rows.map((row) => () =>
      (liveConversationIds.has(row.agent_session_id) ? Promise.resolve(false) : this.availableForList(row))));
    const entries: CommandTerminalHistoryEntry[] = [];
    for (const [index, row] of rows.entries()) {
      if (liveConversationIds.has(row.agent_session_id)) continue;
      if (!availability[index]) {
        this.write(() => repository.delete(row.agent_session_id), 'drop');
        this.deps.conversationEnded(projectId, row.agent_session_id);
        continue;
      }
      let endedAt = row.ended_at;
      if (!endedAt) {
        // Open at the last quit: it ended when it was last seen.
        endedAt = row.updated_at;
        const backfilledEnd = endedAt;
        this.write(() => repository.markEnded(row.agent_session_id, backfilledEnd), 'backfill');
      }
      entries.push({
        agentSessionId: row.agent_session_id,
        label: row.label,
        firstPrompt: row.first_prompt,
        agentName: row.agent_name,
        endedAt,
      });
    }
    return entries;
  }

  /**
   * Rename a conversation no terminal holds, from its Earlier row. A user's
   * name wins as a live rename does: the mark keeps the namer off when the
   * conversation resumes, for an empty name too, which clears the row back to
   * its first prompt. False when a live terminal or a resume in flight holds the
   * conversation, or the row is gone.
   */
  rename(projectId: string, agentSessionId: string, name: string | null): boolean {
    const repository = this.repositoryOfIdleRow(projectId, agentSessionId);
    if (!repository) return false;
    repository.setLabel(agentSessionId, normalizeCommandTerminalName(name, null), true);
    this.deps.notifyChanged(projectId);
    return true;
  }

  /**
   * Remove a conversation from the Earlier list. The agent's transcript stays;
   * the row and its search text go. False as `rename` is.
   */
  remove(projectId: string, agentSessionId: string): boolean {
    const repository = this.repositoryOfIdleRow(projectId, agentSessionId);
    if (!repository) return false;
    repository.delete(agentSessionId);
    this.transcriptFoundAt.delete(agentSessionId);
    this.deps.conversationEnded(projectId, agentSessionId);
    this.deps.notifyChanged(projectId);
    return true;
  }

  /** Conversations whose text matches, for the Earlier list to place among its rows. */
  searchText(projectId: string, query: string): Promise<CommandTerminalHistorySearchResult> {
    return this.deps.searchText(projectId, query);
  }

  /** The project's repository while the row exists and nothing live holds it. */
  private repositoryOfIdleRow(projectId: string, agentSessionId: string): CommandTerminalHistoryRepository | null {
    const repository = this.deps.getRepository(projectId);
    if (!repository || !repository.get(agentSessionId)) return null;
    return this.liveConversationIds(projectId).has(agentSessionId) ? null : repository;
  }

  /** `conversationAvailable`, answering from a recent find. A miss is never held. */
  private async availableForList(row: CommandTerminalHistoryRow): Promise<boolean> {
    const agentSessionId = row.agent_session_id;
    const foundAt = this.transcriptFoundAt.get(agentSessionId);
    if (foundAt !== undefined && Date.now() - foundAt < AVAILABILITY_RECHECK_MS) return true;
    const available = await this.conversationAvailable(row);
    if (available) this.transcriptFoundAt.set(agentSessionId, Date.now());
    else this.transcriptFoundAt.delete(agentSessionId);
    return available;
  }

  /** The conversations the project's live terminals hold or a resume is starting. */
  private liveConversationIds(projectId: string): Set<string> {
    const live = new Set<string>(this.resumesInFlight.keys());
    for (const session of this.deps.sessionManager.listSessions()) {
      if (session.projectId === projectId && session.agentSessionId && session.status !== 'exited') {
        live.add(session.agentSessionId);
      }
    }
    for (const held of this.heldBySession.values()) {
      if (held.projectId === projectId) live.add(held.agentSessionId);
    }
    return live;
  }

  /**
   * Whether the conversation can still be resumed: its agent resumes by id and
   * still finds the transcript, which it may have purged since the list showed
   * the row. Never throws.
   */
  conversationAvailable(row: CommandTerminalHistoryRow): Promise<boolean> {
    return this.deps.conversationAvailable(row.agent_name, row.agent_session_id, row.cwd, row.cli_target ?? null);
  }

  /** The record of one conversation, for a resume. */
  find(projectId: string, agentSessionId: string): CommandTerminalHistoryRow | null {
    try {
      return this.deps.getRepository(projectId)?.get(agentSessionId) ?? null;
    } catch (error) {
      warn('find', error);
      return null;
    }
  }

  private readonly onAgentSessionId: AgentSessionIdListener = (sessionId, _taskId, projectId, agentSessionId) => {
    if (this.disposed) return;
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session || !isCommandTerminalSession(session)) return;
    // The terminal now reports what it holds, which `heldBySession` records.
    this.releaseResumesOf(sessionId);
    const held = this.heldBySession.get(sessionId);
    if (held?.agentSessionId === agentSessionId) return;
    const repository = this.deps.getRepository(projectId);
    if (!repository) return;
    if (held) {
      this.write(() => repository.markEnded(held.agentSessionId), 'end');
      this.deps.conversationEnded(projectId, held.agentSessionId);
    }
    // A `/resume` into a board task's or a workflow's conversation: it belongs
    // to its card, so the terminal records nothing until it moves on again.
    if (this.read(() => repository.isOwnedElsewhere(agentSessionId), false, 'owner')) {
      this.heldBySession.delete(sessionId);
      this.promptBeforeRow.delete(sessionId);
      this.labelBeforeRow.delete(sessionId);
      this.deps.notifyChanged(projectId);
      return;
    }
    const touched = session.hasUserInput === true;
    const label = session.commandTerminalLabel ?? null;
    const namedByUser = session.commandTerminalNamedByUser === true;
    this.write(() => repository.recordConversation({
      agentSessionId,
      agentName: this.deps.sessionManager.getSessionAgentName(sessionId) ?? 'agent',
      cwd: session.cwd,
      label,
      touched,
      // A terminal whose CLI runs in a WSL distro: its transcript is there.
      cliTarget: serializeCliTarget(this.deps.sessionManager.getSessionCliTarget?.(sessionId) ?? null),
    }), 'record');
    // A row that already existed (a resumed conversation) kept its own name;
    // a rename made before the id arrived replaces it.
    if (this.labelBeforeRow.has(sessionId)) {
      const renamed = this.labelBeforeRow.get(sessionId) ?? null;
      this.labelBeforeRow.delete(sessionId);
      this.write(() => repository.setLabel(agentSessionId, renamed, true), 'label');
    }
    const conversation: HeldConversation = { projectId, agentSessionId, touched, label, namedByUser, prompted: false };
    this.heldBySession.set(sessionId, conversation);
    const earlyPrompt = this.promptBeforeRow.get(sessionId);
    if (earlyPrompt !== undefined) {
      this.promptBeforeRow.delete(sessionId);
      this.writeFirstPrompt(conversation, earlyPrompt);
    }
    this.deps.notifyChanged(projectId);
  };

  private readonly onSessionEvent: SessionEventListener = (sessionId, event) => {
    if (this.disposed || event.type !== EventType.Prompt) return;
    // The activity engine's synthetic prompt (typing seen on the PTY, for an
    // agent with no prompt hook) carries a marker, not anything the user wrote.
    const promptText = event.detail ?? '';
    if (promptText.trim() === PromptReason.PtyActivity) return;
    const line = firstPromptLine(promptText);
    if (!line) return;
    const held = this.heldBySession.get(sessionId);
    if (held) {
      if (!held.prompted) this.writeFirstPrompt(held, line);
      return;
    }
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session || !isCommandTerminalSession(session) || this.promptBeforeRow.has(sessionId)) return;
    this.promptBeforeRow.set(sessionId, line);
  };

  private writeFirstPrompt(held: HeldConversation, line: string): void {
    held.prompted = true;
    const repository = this.deps.getRepository(held.projectId);
    if (!repository) return;
    this.write(() => repository.setFirstPrompt(held.agentSessionId, line), 'first-prompt');
  }

  private readonly onSessionChanged: SessionListener = (sessionId, session) => {
    if (this.disposed || !session) return;
    const liveLabel = session.commandTerminalLabel ?? null;
    const held = this.heldBySession.get(sessionId);
    if (!held) {
      // No row yet: hold a user's rename for the row the id will record.
      if (session.commandTerminalNamedByUser && isCommandTerminalSession(session)) {
        this.labelBeforeRow.set(sessionId, liveLabel);
      }
      return;
    }
    const markTouched = session.hasUserInput === true && !held.touched;
    const liveNamedByUser = session.commandTerminalNamedByUser === true;
    const relabel = liveLabel !== held.label || liveNamedByUser !== held.namedByUser;
    if (!markTouched && !relabel) return;
    const repository = this.deps.getRepository(held.projectId);
    if (!repository) return;
    if (markTouched) {
      held.touched = true;
      this.write(() => repository.markTouched(held.agentSessionId), 'touch');
    }
    if (relabel) {
      held.label = liveLabel;
      held.namedByUser = liveNamedByUser;
      this.write(() => repository.setLabel(held.agentSessionId, liveLabel, liveNamedByUser), 'label');
    }
  };

  private readonly onSessionRemoved: SessionListener = (sessionId) => {
    this.releaseResumesOf(sessionId);
    this.promptBeforeRow.delete(sessionId);
    this.labelBeforeRow.delete(sessionId);
    const held = this.heldBySession.get(sessionId);
    if (!held) return;
    this.heldBySession.delete(sessionId);
    if (this.disposed) return;
    const repository = this.deps.getRepository(held.projectId);
    if (!repository) return;
    this.write(() => repository.markEnded(held.agentSessionId), 'end');
    this.deps.conversationEnded(held.projectId, held.agentSessionId);
    this.deps.notifyChanged(held.projectId);
  };

  /** A history write never throws into SessionManager's emit. */
  private write(action: () => void, step: string): void {
    try {
      action();
    } catch (error) {
      warn(step, error);
    }
  }

  private read<T>(action: () => T, fallback: T, step: string): T {
    try {
      return action();
    } catch (error) {
      warn(step, error);
      return fallback;
    }
  }
}

function warn(step: string, error: unknown): void {
  console.warn(`[COMMAND_TERMINAL] history ${step} failed (non-fatal):`, error instanceof Error ? error.message : String(error));
}
