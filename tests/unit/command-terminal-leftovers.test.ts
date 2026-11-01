/**
 * Reaping what a Command Terminal's agent left running once the terminal ends
 * (src/main/ipc/helpers/command-terminal-leftovers.ts).
 *
 * The reap never force-kills Claude mid-exit: the reap's own agent-exit wait
 * covers the pty host's ask-then-terminate cleanup, and the delay is a
 * backstop past Claude's longest measured exit after a close. It reaps under
 * the terminal's own tag and folder, names the terminal in the report, never
 * touches a task session's removal, and does nothing once the app is quitting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Session } from '../../src/shared/types';
import {
  COMMAND_TERMINAL_REAP_DELAY_MS,
  CommandTerminalLeftoverReaper,
  type CommandTerminalLeftoverTask,
} from '../../src/main/ipc/helpers/command-terminal-leftovers';
import { DEAD_ROOT_ORPHAN_EXIT_GRACE_MS } from '../../src/main/pty/host/dead-root-orphans';
import { AGENT_EXIT_REQUEST_TIMEOUT_MS, AGENT_EXIT_WAIT_MS } from '../../src/main/pty/host/exited-root-wait';

/** Claude 2.1.303's longest exit after its console was closed, with a real session's hooks and MCP server. */
const LONGEST_MEASURED_CLOSE_EXIT_MS = 4_000;

function removedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'transient-task-uuid',
    projectId: 'project-1',
    pid: 4242,
    status: 'exited',
    shell: 'pwsh.exe',
    cwd: 'C:\\work\\project',
    startedAt: '2026-10-11T19:00:00.000Z',
    exitCode: 0,
    resuming: false,
    transient: true,
    commandTerminalSlot: 'slot-2',
    commandTerminalLabel: 'Count Markdown Files in Docs Folder',
    ...overrides,
  } as Session;
}

function makeRig(options: { shuttingDown?: boolean } = {}) {
  const sessionManager = new EventEmitter();
  const reaps: Array<{ projectPath: string; task: CommandTerminalLeftoverTask }> = [];
  const reapDistros: string[][] = [];
  let shuttingDown = options.shuttingDown ?? false;
  const reaper = new CommandTerminalLeftoverReaper({
    sessionManager: sessionManager as never,
    reap: async (projectPath, task, wslDistros) => {
      reaps.push({ projectPath, task });
      reapDistros.push(wslDistros);
    },
    isShuttingDown: () => shuttingDown,
  });
  reaper.start();
  return { sessionManager, reaper, reaps, reapDistros, setShuttingDown: (value: boolean) => { shuttingDown = value; } };
}

describe('CommandTerminalLeftoverReaper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves the orphan grace to the reap\'s own wait, and backstops past Claude\'s longest measured exit', () => {
    // The reap's agent-exit request outlives the orphan cleanup's grace and the killed-shell bound,
    // so a terminal whose root the host holds is never reaped mid-exit, whatever the delay.
    expect(AGENT_EXIT_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS);
    expect(AGENT_EXIT_REQUEST_TIMEOUT_MS).toBeGreaterThan(AGENT_EXIT_WAIT_MS);
    // A root that wait cannot hold (a WSL shell, the in-process core) gets the delay alone.
    expect(COMMAND_TERMINAL_REAP_DELAY_MS).toBeGreaterThan(LONGEST_MEASURED_CLOSE_EXIT_MS);
  });

  it('keeps the backstop delay short, because the reap\'s own agent-exit wait already covers the orphan grace', () => {
    // The delay is 5 s, not the 12 s it was before the reap waited for the agent. A root the host
    // holds is waited on by the reap itself, so the delay only backstops a root with no ledger
    // (a WSL shell, the in-process core), and no longer needs to outlast the orphan grace.
    expect(COMMAND_TERMINAL_REAP_DELAY_MS).toBeLessThan(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS);
    expect(COMMAND_TERMINAL_REAP_DELAY_MS).toBeLessThanOrEqual(AGENT_EXIT_WAIT_MS);
  });

  it('reaps the terminal\'s own tag in its own folder, named for the report, only after an exiting agent has had its time', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'session-1', removedSession());

    // Claude's clean exit after a Stop takes 0.4 to 4 s: nothing may be reaped then.
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS - 1);
    expect(rig.reaps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(rig.reaps).toEqual([{
      projectPath: 'C:\\work\\project',
      task: { id: 'transient-task-uuid', worktree_path: null, title: 'Count Markdown Files in Docs Folder' },
    }]);
  });

  it('reaps in the distro its shell ran in, which a CLI path into a distro gives it, and in none for another shell', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'session-1', removedSession({ shell: 'wsl -d Ubuntu' }));
    rig.sessionManager.emit('session-removed', 'session-2', removedSession({ id: 'session-2', shell: 'pwsh.exe' }));
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS);
    expect(rig.reapDistros).toEqual([['Ubuntu'], []]);
  });

  it('names an unnamed terminal by its slot', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'session-1', removedSession({ commandTerminalLabel: null }));
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS);
    expect(rig.reaps[0]?.task.title).toBe('Command Terminal 2');
  });

  it('never reaps on a task session\'s removal: a task is reaped by its own terminal transition', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'session-9', removedSession({ transient: false, taskId: 'task-9' }));
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS * 2);
    expect(rig.reaps).toEqual([]);
  });

  it('never reaps on a workflow agent\'s removal: transient, but no terminal, and its end already waits for its exit', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'workflow-agent', removedSession({ id: 'workflow-agent', taskId: 'workflow-1', workflowId: 'workflow-1', commandTerminalSlot: null }));
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS * 2);
    expect(rig.reaps).toEqual([]);
  });

  it('reaps nothing once the app is quitting, and nothing after dispose', async () => {
    const quitting = makeRig();
    quitting.sessionManager.emit('session-removed', 'session-1', removedSession());
    quitting.setShuttingDown(true);

    const disposed = makeRig();
    disposed.sessionManager.emit('session-removed', 'session-1', removedSession());
    disposed.reaper.dispose();
    disposed.sessionManager.emit('session-removed', 'session-2', removedSession({ id: 'session-2' }));

    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS * 2);
    expect(quitting.reaps).toEqual([]);
    expect(disposed.reaps).toEqual([]);
    expect(disposed.sessionManager.listenerCount('session-removed')).toBe(0);
  });

  // `/bg` moves a terminal's conversation into the agent CLI's own background
  // session, which runs outside the PTY, tagged and in the terminal's folder, so
  // the reap would kill it with no exit of its own. The CLI stops it first.
  describe("the agent CLI's own background session", () => {
    function makeStopRig(options: { stop?: () => Promise<void> } = {}) {
      const sessionManager = new EventEmitter();
      // The registry row, deleted right after the removal's emit, as remove() does.
      const rows = new Map<string, { agentName: string; cliTarget: null }>([['session-1', { agentName: 'claude', cliTarget: null }]]);
      Object.assign(sessionManager, {
        getSessionAgentName: (sessionId: string) => rows.get(sessionId)?.agentName,
        getSessionCliTarget: (sessionId: string) => rows.get(sessionId)?.cliTarget ?? null,
      });
      const order: string[] = [];
      let finishStop: () => void = () => undefined;
      const stopBackgroundSession = vi.fn((_ended: unknown) => {
        order.push('stop');
        if (options.stop) return options.stop();
        return new Promise<void>((resolve) => { finishStop = resolve; });
      });
      let shuttingDown = false;
      const reaper = new CommandTerminalLeftoverReaper({
        sessionManager: sessionManager as never,
        reap: async () => { order.push('reap'); },
        stopBackgroundSession,
        isShuttingDown: () => shuttingDown,
      });
      reaper.start();
      const remove = (session: Session) => {
        sessionManager.emit('session-removed', session.id, session);
        rows.delete(session.id);
      };
      return { stopBackgroundSession, order, remove, finishStop: () => finishStop(), setShuttingDown: (value: boolean) => { shuttingDown = value; } };
    }

    it("stops it with the agent and place the row named at the removal, and reaps only once the stop is done", async () => {
      const rig = makeStopRig();
      rig.remove(removedSession({ agentSessionId: 'background-conversation-1' }));

      await vi.advanceTimersByTimeAsync(0);
      // Read during the emit: the row was gone by the time the stop ran.
      expect(rig.stopBackgroundSession).toHaveBeenCalledWith({
        agentName: 'claude',
        agentSessionId: 'background-conversation-1',
        cwd: 'C:\\work\\project',
        cliTarget: null,
      });

      // The stop can take its whole budget; the reap waits past its own delay for it.
      await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS * 2);
      expect(rig.order).toEqual(['stop']);
      rig.finishStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(rig.order).toEqual(['stop', 'reap']);
    });

    it('still reaps, after the delay, when the stop fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const rig = makeStopRig({ stop: async () => { throw new Error('supervisor gone'); } });
      rig.remove(removedSession({ agentSessionId: 'background-conversation-1' }));

      await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS);

      expect(rig.order).toEqual(['stop', 'reap']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('background session stop failed'), 'supervisor gone');
      warn.mockRestore();
    });

    it('asks nothing for a terminal whose agent never reported a conversation, or once the app is quitting', async () => {
      const rig = makeStopRig();
      rig.remove(removedSession({ agentSessionId: null }));
      rig.setShuttingDown(true);
      rig.remove(removedSession({ id: 'session-2', agentSessionId: 'background-conversation-2' }));

      await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS * 2);

      expect(rig.stopBackgroundSession).not.toHaveBeenCalled();
    });
  });

  it('logs a failed reap and never throws', async () => {
    const sessionManager = new EventEmitter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reaper = new CommandTerminalLeftoverReaper({
      sessionManager: sessionManager as never,
      reap: async () => { throw new Error('reader_load'); },
      isShuttingDown: () => false,
    });
    reaper.start();
    sessionManager.emit('session-removed', 'session-1', removedSession());
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leftover reap failed'), 'reader_load');
    warn.mockRestore();
  });
});
