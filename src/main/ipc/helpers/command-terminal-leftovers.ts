/**
 * Reaps what a Command Terminal's agent left running, once the terminal ends.
 *
 * A terminal's PTY carries its own made-up task id as `KANGENTIC_TASK_ID`
 * (performSpawn), so the task reap (`reapTaskLeftovers`) finds what its agent
 * detached: a server it started with `Start-Process` or `nohup`, which nothing
 * else stops or reports. Measured in a preview: a detached `ping` a terminal's
 * agent started kept running after the terminal ended, with no report. The reap
 * honors "Stop leftover processes" and reports under the terminal's name, as a
 * task's does, and kills only what carries THIS terminal's tag and works inside
 * its folder (`process-tag/reap-plan.ts`).
 *
 * A reap must never force-kill an agent mid-exit. A Stop closes the console,
 * and Claude spends 0.4 to 4 s on its own clean exit (SessionEnd hook,
 * transcript records); a shell that died leaves its agent to the pty host's
 * ask-then-terminate cleanup, which can take its whole grace. The reap itself
 * waits out both before it scans: the host records a terminal's root the moment
 * its kill arrives, or when its shell exits on its own, and `awaitAgentExit`
 * (`pty/host/exited-root-wait.ts`) answers once what the shell left running is
 * gone, the orphan cleanup's grace included. So the reap runs
 * `COMMAND_TERMINAL_REAP_DELAY_MS` after the row's removal only as a backstop
 * for a root that wait cannot hold: a WSL shell, whose agent runs inside the
 * distro, and the in-process core that takes over after repeated host crashes.
 * It covers Claude's longest measured exit after a close. Before the wait it was
 * 12 s, past the orphan grace. Nothing is reaped once the app is quitting: a
 * quit never reaps, as for tasks.
 *
 * A conversation `/bg` moved into the agent CLI's own background session is
 * still the terminal's agent, and it runs outside the PTY, tagged and in the
 * terminal's folder, so the reap would kill it with no exit of its own. The
 * stop (`stopEndedCommandTerminalBackgroundSession`) starts at the removal,
 * while the registry row still names the terminal's agent and place, and the
 * reap waits for it. A quit stops nothing here either; an Earlier resume of the
 * conversation stops its background session first.
 */
import type { Session, StoredCliTarget } from '../../../shared/types';
import { commandTerminalDisplayName } from '../../../shared/command-terminal-name';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import { parseWslShellSpec } from '../../pty/process-tag/task-process-tag';
import type { EndedCommandTerminal } from './command-terminal-background-session';

export const COMMAND_TERMINAL_REAP_DELAY_MS = 5_000;

export interface CommandTerminalLeftoverTask {
  id: string;
  worktree_path: string | null;
  title: string;
}

type RemovedListener = (sessionId: string, session?: Session) => void;

export interface CommandTerminalLeftoverDeps {
  sessionManager: {
    on(event: 'session-removed', listener: RemovedListener): unknown;
    off(event: 'session-removed', listener: RemovedListener): unknown;
    /** Read during the removal, while the registry row is still there. */
    getSessionAgentName?(sessionId: string): string | undefined;
    getSessionCliTarget?(sessionId: string): StoredCliTarget | null;
  };
  /**
   * `reapTaskLeftovers` for one terminal: its folder, its tag, its name for the
   * report, and the distro its shell ran in when that is WSL (a CLI path into a
   * distro gives the terminal a WSL shell whatever shell is configured).
   */
  reap(projectPath: string, task: CommandTerminalLeftoverTask, wslDistros: string[]): Promise<void>;
  /**
   * Stop the agent CLI's own background session still holding the terminal's
   * conversation (`stopEndedCommandTerminalBackgroundSession`). Started at the
   * removal; the reap waits for it.
   */
  stopBackgroundSession?(ended: EndedCommandTerminal): Promise<void>;
  isShuttingDown(): boolean;
  /** Injectable for tests. */
  delayMs?: number;
}

export class CommandTerminalLeftoverReaper {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private started = false;
  private disposed = false;

  constructor(private readonly deps: CommandTerminalLeftoverDeps) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.deps.sessionManager.on('session-removed', this.onRemoved);
  }

  /** Synchronous: detaches the listener and drops every scheduled reap. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) this.deps.sessionManager.off('session-removed', this.onRemoved);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private readonly onRemoved: RemovedListener = (sessionId, session) => {
    // A workflow's own agent is transient too, but runs no shell tool, and its
    // end already waits for its process to exit (`endWorkflowAgent`).
    if (!session || !isCommandTerminalSession(session) || !session.cwd || this.disposed) return;
    // The terminal's own folder is the reap's directory. It is never passed as
    // a worktree: the macOS orphan rule treats a worktree as wholly the task's,
    // and a project root is shared with every task that has no worktree.
    const projectPath = session.cwd;
    const task: CommandTerminalLeftoverTask = {
      id: session.taskId,
      worktree_path: null,
      title: commandTerminalDisplayName(session.commandTerminalLabel, session.commandTerminalSlot),
    };
    const wslDistro = parseWslShellSpec(session.shell)?.distro;
    const wslDistros = wslDistro ? [wslDistro] : [];
    const backgroundStop = this.startBackgroundStop(sessionId, session);
    const runReap = (): void => {
      if (this.disposed || this.deps.isShuttingDown()) return;
      void this.deps.reap(projectPath, task, wslDistros).catch((error: unknown) => {
        console.warn('[COMMAND_TERMINAL] leftover reap failed (non-fatal):', error instanceof Error ? error.message : String(error));
      });
    };
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (backgroundStop) void backgroundStop.then(runReap);
      else runReap();
    }, this.deps.delayMs ?? COMMAND_TERMINAL_REAP_DELAY_MS);
    timer.unref?.();
    this.timers.add(timer);
  };

  /**
   * The background-session stop for an ended terminal, started now: the
   * registry row that names its agent and place is deleted once the removal's
   * listeners return. Null when there is nothing to ask about. Never rejects.
   */
  private startBackgroundStop(sessionId: string, session: Session): Promise<void> | null {
    const { stopBackgroundSession } = this.deps;
    if (!stopBackgroundSession || !session.agentSessionId || this.deps.isShuttingDown()) return null;
    const ended: EndedCommandTerminal = {
      agentName: this.deps.sessionManager.getSessionAgentName?.(sessionId),
      agentSessionId: session.agentSessionId,
      cwd: session.cwd,
      cliTarget: this.deps.sessionManager.getSessionCliTarget?.(sessionId) ?? null,
    };
    // Called on a later tick, so a dep that throws never throws into the emit.
    return Promise.resolve().then(() => stopBackgroundSession(ended)).catch((error: unknown) => {
      console.warn('[COMMAND_TERMINAL] background session stop failed (non-fatal):', error instanceof Error ? error.message : String(error));
    });
  }
}
