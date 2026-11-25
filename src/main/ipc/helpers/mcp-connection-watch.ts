import type { McpConnectionCheck } from '../../../shared/types';
import type { StoredCliTarget } from '../../../shared/types';
import { handlerStepReporter, isDefectOrEnvironmentFailure } from './handler-step-report';

/** The session facts the watch reads. */
export interface McpConnectionWatchSessions {
  on(event: 'first-output', listener: (sessionId: string) => void): unknown;
  off(event: 'first-output', listener: (sessionId: string) => void): unknown;
  getSessionAgentName(sessionId: string): string | undefined;
  getSessionCliTarget(sessionId: string): StoredCliTarget | null;
  getSession(sessionId: string): { projectId: string } | undefined;
}

export interface McpConnectionWatchDeps {
  sessions: McpConnectionWatchSessions;
  /** Whether the MCP server is on, so sessions are given it. */
  isEnabled: () => boolean;
  /** The check, for one project's URL and the session's distro (or none). */
  check: (projectId: string, distros: readonly string[]) => Promise<McpConnectionCheck>;
  /** Tells the renderer, which raises the one toast. */
  notify: (error: string) => void;
}

/**
 * The MCP connection check an agent session's start runs, so a board whose
 * tools never connect says so outside Settings: once per app run, at the
 * first failure, as the error the check hit. Runs when a session's agent first
 * writes output. Each place (this machine, or one distro) is checked until it
 * answers once, then not again this run; after a failure nothing is checked
 * again, since the one notice has been given.
 */
export class McpConnectionWatch {
  private readonly answered = new Set<string>();
  private readonly checking = new Set<string>();
  private notified = false;

  constructor(private readonly deps: McpConnectionWatchDeps) {}

  start(): void {
    this.deps.sessions.on('first-output', this.onFirstOutput);
  }

  dispose(): void {
    this.deps.sessions.off('first-output', this.onFirstOutput);
  }

  private readonly onFirstOutput = (sessionId: string): void => {
    if (this.notified || !this.deps.isEnabled()) return;
    // A raw shell runs no agent, and gets no MCP server.
    if (!this.deps.sessions.getSessionAgentName(sessionId)) return;
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) return;
    const cliTarget = this.deps.sessions.getSessionCliTarget(sessionId);
    // A host's agent reaches the server through the stdio bridge main relays, not by dialing it, so
    // there is no distro to check and nothing a connection test here could tell the user.
    if (cliTarget?.kind === 'ssh') return;
    const distro = cliTarget?.distro ?? null;
    const place = distro ? `wsl:${distro.toLowerCase()}` : 'local';
    if (this.answered.has(place) || this.checking.has(place)) return;
    this.checking.add(place);
    void this.deps.check(session.projectId, distro ? [distro] : [])
      .then((result) => {
        if (result.connected) {
          this.answered.add(place);
        } else if (!this.notified) {
          this.notified = true;
          this.deps.notify(result.error);
        }
      })
      .catch((error: unknown) => {
        // The check itself could not run, so a board whose tools never connect gets no
        // notice outside Settings. A probe program that fails is a plain Error, so only a
        // defect or an errno reports.
        if (isDefectOrEnvironmentFailure(error)) {
          handlerStepReporter.report(error, { tags: { area: 'mcp_watch', step: 'session_start_check' } });
        }
        console.warn('[MCP] Connection check at session start failed to run:', error);
      })
      .finally(() => this.checking.delete(place));
  };
}
