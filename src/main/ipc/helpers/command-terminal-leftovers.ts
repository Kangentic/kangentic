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
 * It runs `COMMAND_TERMINAL_REAP_DELAY_MS` after the terminal's row is removed,
 * not at once. A Stop closes the console, and Claude spends about 600 ms on its
 * own clean exit (SessionEnd hook, transcript records); a shell that died
 * leaves its agent to the pty host's ask-then-terminate cleanup, which can take
 * its whole grace (`DEAD_ROOT_ORPHAN_EXIT_GRACE_MS`). A reap inside either
 * window would force-kill an agent mid-exit. Nothing is reaped once the app is
 * quitting: a quit never reaps, as for tasks.
 */
import type { Session } from '../../../shared/types';
import { commandTerminalDisplayName } from '../../../shared/command-terminal-name';
import { DEAD_ROOT_ORPHAN_EXIT_GRACE_MS } from '../../pty/host/dead-root-orphans';

export const COMMAND_TERMINAL_REAP_DELAY_MS = DEAD_ROOT_ORPHAN_EXIT_GRACE_MS + 2_000;

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
  };
  /** `reapTaskLeftovers` for one terminal: its folder, its tag, its name for the report. */
  reap(projectPath: string, task: CommandTerminalLeftoverTask): Promise<void>;
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

  private readonly onRemoved: RemovedListener = (_sessionId, session) => {
    if (!session?.transient || !session.cwd || this.disposed) return;
    // The terminal's own folder is the reap's directory. It is never passed as
    // a worktree: the macOS orphan rule treats a worktree as wholly the task's,
    // and a project root is shared with every task that has no worktree.
    const projectPath = session.cwd;
    const task: CommandTerminalLeftoverTask = {
      id: session.taskId,
      worktree_path: null,
      title: commandTerminalDisplayName(session.commandTerminalLabel, session.commandTerminalSlot),
    };
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed || this.deps.isShuttingDown()) return;
      void this.deps.reap(projectPath, task).catch((error: unknown) => {
        console.warn('[COMMAND_TERMINAL] leftover reap failed (non-fatal):', error instanceof Error ? error.message : String(error));
      });
    }, this.deps.delayMs ?? COMMAND_TERMINAL_REAP_DELAY_MS);
    timer.unref?.();
    this.timers.add(timer);
  };
}
