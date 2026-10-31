/**
 * Names a Command Terminal from its first prompt, in main.
 *
 * This used to run in the renderer, which is why a terminal a phone started, or
 * one in a project the desktop did not have open, was never named: no renderer
 * code ever saw its prompt. Main sees every session's events, so the name now
 * comes from here for every terminal, and `setCommandTerminalLabel` announces it
 * on 'session-changed' for the window title, the Agent Monitor, and the phone.
 *
 * The name comes from the Automation agent (`AppConfig.automation`), its model
 * and effort, run in the shared answer home: a few words of title need neither
 * the terminal's own agent (which ran on the project default, Opus here) nor
 * the project's instructions. With no Automation agent, naming is off and the
 * terminal keeps its "Command Terminal N" title, the same rule the task title
 * suggestion follows. A terminal the user renamed (`renameCommandTerminal`) is
 * never named here, and a name still being generated when the user renames is
 * refused by `setCommandTerminalLabel`.
 */
import { EventType, PromptReason, type Session, type SessionEvent } from '../../../shared/types';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import { runNamingCall, type ResolvedAutomationAgent } from '../../automations/automation-agent';
import type { BackgroundCallSink } from '../../background-calls/record-background-call';
import { tryAcquireSummarizeSlot } from './summarize-rate-limit';

export interface CommandTerminalNamerSessionSource {
  on(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  on(event: 'session-removed', listener: (sessionId: string) => void): unknown;
  off(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  off(event: 'session-removed', listener: (sessionId: string) => void): unknown;
  getSession(sessionId: string): Session | undefined;
  setCommandTerminalLabel(sessionId: string, label: string): boolean;
}

export interface CommandTerminalNamerDeps {
  sessionManager: CommandTerminalNamerSessionSource;
  /** The Automation agent resolved for naming in the terminal's project (whose
   *  CLI path it runs), or why it cannot name. */
  resolveNamingAgent: (projectId: string | null) => Promise<ResolvedAutomationAgent>;
  /** `AppConfig.autoNameRateLimitPerHour` (0 means no limit). */
  readRateLimit: () => number;
  /** Where the naming call is recorded, in the terminal's project's ledger;
   *  absent records nothing. */
  recordCall?: BackgroundCallSink;
  /** Injectable for tests; defaults to the shared summarize window. */
  tryAcquireSlot?: (limitPerHour: number) => boolean;
}

export class CommandTerminalNamer {
  /** Sessions already given their one summarize attempt, named or not. */
  private readonly attemptedSessionIds = new Set<string>();
  private started = false;
  private disposed = false;

  constructor(private readonly deps: CommandTerminalNamerDeps) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.deps.sessionManager.on('event', this.onEvent);
    this.deps.sessionManager.on('session-removed', this.onSessionRemoved);
  }

  /** Synchronous: detaches the listeners. A summarize already running finishes and is dropped. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.deps.sessionManager.off('event', this.onEvent);
      this.deps.sessionManager.off('session-removed', this.onSessionRemoved);
    }
    this.attemptedSessionIds.clear();
  }

  private readonly onSessionRemoved = (sessionId: string): void => {
    this.attemptedSessionIds.delete(sessionId);
  };

  private readonly onEvent = (sessionId: string, event: SessionEvent): void => {
    if (event.type !== EventType.Prompt) return;
    if (this.attemptedSessionIds.has(sessionId)) return;
    // The activity engine's synthetic prompt (typing seen on the PTY, for an
    // agent with no prompt hook) carries a marker, not anything the user wrote.
    const promptText = (event.detail ?? '').trim();
    if (!promptText || promptText === PromptReason.PtyActivity) return;
    const session = this.deps.sessionManager.getSession(sessionId);
    // A workflow's own agent is transient too, but has no terminal name to earn.
    if (!session || !isCommandTerminalSession(session)) return;
    // First prompt wins, and only once: a later prompt never renames it.
    this.attemptedSessionIds.add(sessionId);
    // A name the user set (or cleared) always wins: no agent is resolved and no
    // rate-limit slot is spent on a terminal that will refuse the result.
    if (session.commandTerminalLabel || session.commandTerminalNamedByUser) return;
    void this.nameFromPrompt(sessionId, session.projectId ?? null, promptText);
  };

  private async nameFromPrompt(sessionId: string, projectId: string | null, promptText: string): Promise<void> {
    try {
      // Resolved BEFORE the rate limit, so a terminal that cannot be named
      // spends no slot.
      const resolved = await this.deps.resolveNamingAgent(projectId);
      if (!resolved.ok) return;
      const tryAcquireSlot = this.deps.tryAcquireSlot ?? tryAcquireSummarizeSlot;
      if (!tryAcquireSlot(this.deps.readRateLimit())) return;
      const title = await runNamingCall(resolved, promptText, this.deps.recordCall, {
        projectId,
        job: 'terminal_name',
        taskId: null,
      });
      if (this.disposed || !title) return;
      this.deps.sessionManager.setCommandTerminalLabel(sessionId, title);
    } catch (error) {
      // Best-effort: the terminal keeps its "Command Terminal N" title.
      console.warn(`[COMMAND_TERMINAL] naming ${sessionId.slice(0, 8)} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
