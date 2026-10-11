/**
 * Reaping what a Command Terminal's agent left running once the terminal ends
 * (src/main/ipc/helpers/command-terminal-leftovers.ts).
 *
 * The reap waits out the window in which an agent may still be exiting by
 * itself (a Stop's console close, or the pty host's ask-then-terminate
 * cleanup), so it never force-kills Claude mid-exit. It reaps under the
 * terminal's own tag and folder, names the terminal in the report, never
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
  let shuttingDown = options.shuttingDown ?? false;
  const reaper = new CommandTerminalLeftoverReaper({
    sessionManager: sessionManager as never,
    reap: async (projectPath, task) => {
      reaps.push({ projectPath, task });
    },
    isShuttingDown: () => shuttingDown,
  });
  reaper.start();
  return { sessionManager, reaper, reaps, setShuttingDown: (value: boolean) => { shuttingDown = value; } };
}

describe('CommandTerminalLeftoverReaper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits longer than the pty host gives an exiting agent', () => {
    expect(COMMAND_TERMINAL_REAP_DELAY_MS).toBeGreaterThan(DEAD_ROOT_ORPHAN_EXIT_GRACE_MS);
  });

  it('reaps the terminal\'s own tag in its own folder, named for the report, only after an exiting agent has had its time', async () => {
    const rig = makeRig();
    rig.sessionManager.emit('session-removed', 'session-1', removedSession());

    // Claude's clean exit after a Stop takes about 600 ms: nothing may be reaped then.
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_REAP_DELAY_MS - 1);
    expect(rig.reaps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(rig.reaps).toEqual([{
      projectPath: 'C:\\work\\project',
      task: { id: 'transient-task-uuid', worktree_path: null, title: 'Count Markdown Files in Docs Folder' },
    }]);
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
