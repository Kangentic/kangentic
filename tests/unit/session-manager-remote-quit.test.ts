/**
 * A quit with agents running on a remote host (#913), through a real SessionManager and the mock PTY
 * (the in-process core stands in for the pty host, and answers a host spawn with a pid on its own
 * machine, as the helper does).
 *
 * What a user loses if this breaks: the quit signals or types into a process that is not here, the
 * quit holds on a pid that never exits, or the host process is torn down before the helper was
 * told how each remote agent ends, which leaves them running until the next connect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { PtyHostCommand } from '../../src/main/pty/host/protocol';

const EXIT_SEQUENCE = ['\x03', '/exit\r'];
let tmpDir: string;

function createMockPty(pid: number) {
  return {
    pid,
    cols: 120,
    rows: 30,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

function hostOf(manager: SessionManager): { post: (command: PtyHostCommand) => void } {
  return (manager as unknown as { host: { post: (command: PtyHostCommand) => void } }).host;
}

/** Pretend the pty host is a utility process, so the quit counts it. */
function giveHostAPid(manager: SessionManager, pid: number): void {
  const transport = (manager as unknown as { host: { transport: object } }).host.transport;
  Object.defineProperty(transport, 'hostPid', { value: pid });
}

async function spawnRemote(manager: SessionManager, taskId: string, hostId: string, hostPid: number, consoleCloseIsGraceful = false) {
  const mock = createMockPty(hostPid);
  vi.mocked(pty.spawn).mockReturnValue(mock as unknown as pty.IPty);
  const session = await manager.spawn({
    taskId,
    command: '',
    cwd: tmpDir,
    exitSequence: EXIT_SEQUENCE,
    remote: { hostId, cwd: '/home/dev/project', shellName: 'bash' },
    agentParser: { consoleCloseIsGraceful: () => consoleCloseIsGraceful } as never,
  });
  return { session, mock };
}

async function spawnLocal(manager: SessionManager, taskId: string, pid: number) {
  const mock = createMockPty(pid);
  vi.mocked(pty.spawn).mockReturnValue(mock as unknown as pty.IPty);
  const session = await manager.spawn({ taskId, command: '', cwd: tmpDir, exitSequence: EXIT_SEQUENCE });
  return { session, mock };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-remote-quit-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('killAll with a session on a remote host', () => {
  it('signals, types into and counts nothing for it, and names no pid to wait for', async () => {
    const manager = new SessionManager();
    const { mock } = await spawnRemote(manager, 'task-remote', 'host-a', 77_001);
    const writesBefore = mock.write.mock.calls.length;

    const report = manager.killAll();

    expect(mock.kill).not.toHaveBeenCalled();
    expect(mock.write.mock.calls.length).toBe(writesBefore);
    expect(report).toEqual({ pids: [], killedCount: 0, deferredCount: 0 });
  });

  it('tells the host how the session ends, in a command posted before the shutdown', async () => {
    const manager = new SessionManager();
    const { session } = await spawnRemote(manager, 'task-remote', 'host-a', 77_001, true);
    const posted: PtyHostCommand[] = [];
    const host = hostOf(manager);
    const originalPost = host.post.bind(host);
    host.post = (command) => {
      posted.push(command);
      originalPost(command);
    };

    manager.killAll();

    expect(posted).toContainEqual({
      type: 'remoteQuitPlan',
      hostId: 'host-a',
      sessions: [{ sessionId: session.id, exitSequence: EXIT_SEQUENCE, consoleCloseIsGraceful: true }],
    });
  });

  it('sends each host the plan for its own sessions only, the whole of it', async () => {
    const manager = new SessionManager();
    const first = await spawnRemote(manager, 'task-one', 'host-a', 77_001);
    const second = await spawnRemote(manager, 'task-two', 'host-a', 77_002);
    const third = await spawnRemote(manager, 'task-three', 'host-b', 77_003);
    const posted: PtyHostCommand[] = [];
    const host = hostOf(manager);
    const originalPost = host.post.bind(host);
    host.post = (command) => {
      posted.push(command);
      originalPost(command);
    };

    manager.killAll();

    const plans = posted.filter((command): command is Extract<PtyHostCommand, { type: 'remoteQuitPlan' }> => command.type === 'remoteQuitPlan');
    const lastFor = (hostId: string) => plans.filter((plan) => plan.hostId === hostId).at(-1)?.sessions.map((plan) => plan.sessionId).sort();
    expect(lastFor('host-a')).toEqual([first.session.id, second.session.id].sort());
    expect(lastFor('host-b')).toEqual([third.session.id]);
  });

  it('keeps the host process in the drain when only remote agents are running, so the quit frame is sent', async () => {
    const manager = new SessionManager();
    giveHostAPid(manager, 4_321);
    await spawnRemote(manager, 'task-remote', 'host-a', 77_001);

    const report = manager.killAll();

    expect(report.pids).toEqual([4_321]);
    expect(report.killedCount).toBe(1);
  });

  it('does not hold the quit on the host process when nothing at all is running', () => {
    const manager = new SessionManager();
    giveHostAPid(manager, 4_321);

    expect(manager.killAll()).toEqual({ pids: [], killedCount: 0, deferredCount: 0 });
  });

  it('still kills and counts a local session beside a remote one', async () => {
    const manager = new SessionManager();
    giveHostAPid(manager, 4_321);
    const remote = await spawnRemote(manager, 'task-remote', 'host-a', 77_001);
    const local = await spawnLocal(manager, 'task-local', 12_345);

    const report = manager.killAll();

    expect(local.mock.kill).toHaveBeenCalledTimes(1);
    expect(remote.mock.kill).not.toHaveBeenCalled();
    expect(report.pids).toEqual([12_345, 4_321]);
    expect(report.killedCount).toBe(2);
  });
});
