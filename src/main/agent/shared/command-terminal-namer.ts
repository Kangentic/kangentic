/**
 * Names a Command Terminal from its first prompt, in main.
 *
 * This used to run in the renderer, which is why a terminal a phone started, or
 * one in a project the desktop did not have open, was never named: no renderer
 * code ever saw its prompt. Main sees every session's events, so the name now
 * comes from here for every terminal, and `setCommandTerminalLabel` announces it
 * on 'session-changed' for the window title, the Agent Monitor, and the phone.
 *
 * The name comes from the terminal's OWN agent (the one it spawned with, which
 * is its project's default), summarizing in the terminal's own project folder.
 * The renderer used to ask the open project's default agent instead, which was
 * the wrong agent for a background project's terminal.
 */
import { EventType, PromptReason, type Session, type SessionEvent } from '../../../shared/types';
import type { AgentAdapter } from '../agent-adapter';
import { tryAcquireSummarizeSlot } from './summarize-rate-limit';

export interface CommandTerminalNamerSessionSource {
  on(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  on(event: 'session-removed', listener: (sessionId: string) => void): unknown;
  off(event: 'event', listener: (sessionId: string, event: SessionEvent) => void): unknown;
  off(event: 'session-removed', listener: (sessionId: string) => void): unknown;
  getSession(sessionId: string): Session | undefined;
  getSessionAgentName(sessionId: string): string | undefined;
  setCommandTerminalLabel(sessionId: string, label: string): boolean;
}

export interface CommandTerminalNamerConfig {
  /** `AppConfig.autoNameRateLimitPerHour` (0 means no limit). */
  rateLimitPerHour: number;
  /** The CLI path override for this agent, if the user set one. */
  cliPathOverride: string | null;
}

export interface CommandTerminalNamerDeps {
  sessionManager: CommandTerminalNamerSessionSource;
  /** The adapter for an agent name, or undefined when none is registered. */
  getAdapter: (agentName: string) => Pick<AgentAdapter, 'detect' | 'summarize'> | undefined;
  /** The effective settings for the terminal's project folder. */
  readConfig: (projectRoot: string, agentName: string) => CommandTerminalNamerConfig;
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
    if (!session?.transient) return;
    // First prompt wins, and only once: a later prompt never renames it.
    this.attemptedSessionIds.add(sessionId);
    if (session.commandTerminalLabel) return;
    void this.nameFromPrompt(sessionId, session.cwd, promptText);
  };

  private async nameFromPrompt(sessionId: string, projectRoot: string, promptText: string): Promise<void> {
    try {
      const agentName = this.deps.sessionManager.getSessionAgentName(sessionId);
      if (!agentName) return;
      const adapter = this.deps.getAdapter(agentName);
      if (!adapter || typeof adapter.summarize !== 'function') return;
      const config = this.deps.readConfig(projectRoot, agentName);
      const tryAcquireSlot = this.deps.tryAcquireSlot ?? tryAcquireSummarizeSlot;
      if (!tryAcquireSlot(config.rateLimitPerHour)) return;
      const detection = await adapter.detect(config.cliPathOverride);
      if (!detection.found || !detection.path) return;
      const title = await adapter.summarize(promptText, detection.path, projectRoot);
      if (this.disposed || !title) return;
      this.deps.sessionManager.setCommandTerminalLabel(sessionId, title);
    } catch (error) {
      // Best-effort: the terminal keeps its "Command Terminal N" title.
      console.warn(`[COMMAND_TERMINAL] naming ${sessionId.slice(0, 8)} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
