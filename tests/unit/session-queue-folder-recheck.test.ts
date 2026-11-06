/**
 * A queued session was prepared minutes before it starts, and its folder can go
 * in between. #1003 was prepared at 22:41, its worktree was deleted, and at 22:58
 * it started `/merge-pull-request` in the home directory.
 *
 * Pinned here, on a real folder through the real promotion: a queued agent looks
 * at its folder again when a slot frees, a missing one starts nothing and is
 * announced instead of leaving a row at `queued`, and the queue moves on. What the
 * announcement does for a task is `session-idle-timeout.test.ts`.
 *
 * Tier: Unit. Node-pty is mocked; the host core runs in this process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// The limit is Windows', which CI's Linux never reaches. `typed-launch.test.ts`
// pins the measurement; here it is only what the spawn does with the answer.
const commandFits = vi.hoisted(() => ({ value: true }));
vi.mock('../../src/main/pty/spawn/typed-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/pty/spawn/typed-launch')>()),
  commandFitsShell: () => commandFits.value,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { AgentCommandTooLongError, AgentCwdMissingError } from '../../src/main/pty/spawn/pty-spawn';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { AgentParser, Session } from '../../src/shared/types';

const agentParser = {
  detectFirstOutput: () => false,
  removeHooks: vi.fn(),
  runtime: {
    activity: { kind: 'pty' as const, detectIdle: () => false },
    sessionId: { fromOutput: () => null },
  },
} as unknown as AgentParser;

let tmpDir: string;
let goneFolder: string;
let nextPid = 400;

function createMockPty() {
  nextPid += 1;
  return {
    pid: nextPid,
    cols: 120,
    rows: 30,
    onData: vi.fn(() => ({ dispose: () => undefined })),
    onExit: vi.fn(() => ({ dispose: () => undefined })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

function makeManager(): SessionManager {
  const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  const manager = new SessionManager({ ptyHostTransport: transport });
  manager.setMaxConcurrent(1);
  return manager;
}

async function flushUntil(done: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(done()).toBe(true), { timeout: 2000 });
}

beforeEach(() => {
  vi.mocked(pty.spawn).mockReset();
  vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as unknown as pty.IPty);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-queue-recheck-'));
  goneFolder = path.join(tmpDir, 'worktree');
  fs.mkdirSync(goneFolder);
  commandFits.value = true;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('an agent whose command is too long for its shell', () => {
  it('starts no PTY, rejects for its caller, and leaves a row that says why', async () => {
    const manager = makeManager();
    commandFits.value = false;

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser }))
      .rejects.toBeInstanceOf(AgentCommandTooLongError);

    expect(pty.spawn).not.toHaveBeenCalled();
    expect(manager.listSessions()).toEqual([expect.objectContaining({
      taskId: 'task-direct',
      status: 'suspended',
      startBlockedReason: 'prompt-too-long',
    })]);
  });

  it('leaves a running agent alone: the refusal comes before the sibling drain', async () => {
    const manager = makeManager();
    manager.setMaxConcurrent(2);
    const running = await manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser });
    const ptyHandle = vi.mocked(pty.spawn).mock.results[0].value as ReturnType<typeof createMockPty>;
    commandFits.value = false;

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser }))
      .rejects.toBeInstanceOf(AgentCommandTooLongError);

    expect(ptyHandle.kill).not.toHaveBeenCalled();
    expect(manager.listSessions()).toEqual([expect.objectContaining({ id: running.id, status: 'running', startBlockedReason: undefined })]);
  });

  it('settles a queued start at its promotion, with the reason on the refusal', async () => {
    const manager = makeManager();
    const refusals: Error[] = [];
    manager.on('agent-start-refused', (_sessionId: string, _session: Session, error: Error) => refusals.push(error));
    await manager.spawn({ taskId: 'task-running', projectId: 'project-1', command: '', cwd: tmpDir });
    const queued = await manager.spawn({ taskId: 'task-queued', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser });
    expect(queued.status).toBe('queued');
    commandFits.value = false;

    manager.setMaxConcurrent(2);
    await flushUntil(() => refusals.length === 1);

    expect(refusals[0]).toBeInstanceOf(AgentCommandTooLongError);
    expect(refusals[0]).toMatchObject({ reason: 'prompt-too-long' });
    expect(pty.spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves no row for a Command Terminal, whose start rejects to its own window', async () => {
    const manager = makeManager();
    commandFits.value = false;

    await expect(manager.spawn({ taskId: 'terminal', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser, transient: true }))
      .rejects.toBeInstanceOf(AgentCommandTooLongError);

    expect(manager.listSessions()).toEqual([]);
  });

  it('forgets an input-in-alternate-screen mark of the id it refused, since no row keeps that id', async () => {
    const manager = makeManager();
    commandFits.value = false;

    await expect(manager.spawn({
      id: 'refused-alt-screen',
      taskId: 'task-direct',
      projectId: 'project-1',
      command: 'agent',
      cwd: tmpDir,
      agentParser,
      inputInAlternateScreen: true,
    })).rejects.toBeInstanceOf(AgentCommandTooLongError);

    // An id still in the set with no row reads as gone (false) after the wait;
    // an id out of the set has no alternate screen to wait for (true at once).
    await expect(manager.awaitInputReady('refused-alt-screen', 0)).resolves.toBe(true);
  });

  it('leaves a raw command to fail in its own terminal', async () => {
    const manager = makeManager();
    commandFits.value = false;

    const session = await manager.spawn({ taskId: 'task-raw', projectId: 'project-1', command: 'agent', cwd: tmpDir });

    expect(session.status).toBe('running');
  });
});

describe('a queued agent whose folder went while it waited', () => {
  async function queueBehindARunningSession(manager: SessionManager): Promise<Session> {
    await manager.spawn({ taskId: 'task-running', projectId: 'project-1', command: '', cwd: tmpDir });
    const queued = await manager.spawn({ taskId: 'task-queued', projectId: 'project-1', command: '', cwd: goneFolder, agentParser });
    expect(queued.status).toBe('queued');
    return queued;
  }

  it('starts nothing, and announces the refusal with the row still there to pause', async () => {
    const manager = makeManager();
    const refusals: Array<{ sessionId: string; status: string; error: Error }> = [];
    manager.on('agent-start-refused', (sessionId: string, session: Session, error: Error) => {
      refusals.push({ sessionId, status: session.status, error });
    });
    const queued = await queueBehindARunningSession(manager);
    fs.rmSync(goneFolder, { recursive: true });

    manager.setMaxConcurrent(2);
    await flushUntil(() => refusals.length === 1);

    expect(refusals[0]).toMatchObject({ sessionId: queued.id, status: 'queued' });
    expect(refusals[0].error).toBeInstanceOf(AgentCwdMissingError);
    // The running session's PTY alone: the promotion never reached a spawn.
    expect(pty.spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing queued when no listener takes it: the row exits as a failed spawn does', async () => {
    const manager = makeManager();
    const exits: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => exits.push({ sessionId, exitCode }));
    const queued = await queueBehindARunningSession(manager);
    fs.rmSync(goneFolder, { recursive: true });

    manager.setMaxConcurrent(2);
    await flushUntil(() => exits.length === 1);

    expect(exits[0]).toEqual({ sessionId: queued.id, exitCode: -1 });
    expect(manager.listSessions().find((session) => session.id === queued.id)?.status).toBe('exited');
  });

  it('moves on to the next in line, which starts', async () => {
    const manager = makeManager();
    manager.on('agent-start-refused', () => undefined);
    await queueBehindARunningSession(manager);
    const next = await manager.spawn({ taskId: 'task-next', projectId: 'project-1', command: '', cwd: tmpDir, agentParser });
    expect(next.status).toBe('queued');
    fs.rmSync(goneFolder, { recursive: true });

    manager.setMaxConcurrent(2);
    await flushUntil(() => manager.listSessions().some((session) => session.id === next.id && session.status === 'running'));

    expect(pty.spawn).toHaveBeenCalledTimes(2);
  });

  it('starts as usual when its folder is still there', async () => {
    const manager = makeManager();
    const refused = vi.fn();
    manager.on('agent-start-refused', refused);
    const queued = await queueBehindARunningSession(manager);

    manager.setMaxConcurrent(2);
    await flushUntil(() => manager.listSessions().some((session) => session.id === queued.id && session.status === 'running'));

    expect(refused).not.toHaveBeenCalled();
  });
});

describe('a direct start whose folder is gone', () => {
  it('still rejects for its caller, and leaves a row that says why, with Resume on it', async () => {
    const manager = makeManager();
    const worktree = path.join(tmpDir, '.kangentic', 'worktrees', 'gone');

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: '', cwd: worktree, agentParser }))
      .rejects.toBeInstanceOf(AgentCwdMissingError);

    expect(manager.listSessions()).toEqual([expect.objectContaining({
      taskId: 'task-direct',
      status: 'suspended',
      startBlockedReason: 'worktree-missing',
    })]);
  });

  it('names a plain folder when the cwd is no worktree', async () => {
    const manager = makeManager();

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: '', cwd: path.join(tmpDir, 'gone'), agentParser }))
      .rejects.toBeInstanceOf(AgentCwdMissingError);

    expect(manager.listSessions()[0]?.startBlockedReason).toBe('folder-missing');
  });

  it('puts the reason on a paused row the task already has', async () => {
    const manager = makeManager();
    const paused = manager.registerSuspendedPlaceholder({ taskId: 'task-direct', projectId: 'project-1', cwd: tmpDir });

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: '', cwd: path.join(tmpDir, 'gone'), agentParser }))
      .rejects.toBeInstanceOf(AgentCwdMissingError);

    expect(manager.listSessions()).toEqual([expect.objectContaining({ id: paused?.id, startBlockedReason: 'folder-missing' })]);
  });

  it('leaves a running agent alone: it kept running through the refusal', async () => {
    const manager = makeManager();
    // Room for a second session, or the respawn would queue instead of being refused.
    manager.setMaxConcurrent(2);
    const running = await manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: '', cwd: tmpDir });

    await expect(manager.spawn({ taskId: 'task-direct', projectId: 'project-1', command: '', cwd: path.join(tmpDir, 'gone'), agentParser }))
      .rejects.toBeInstanceOf(AgentCwdMissingError);

    expect(manager.listSessions()).toEqual([expect.objectContaining({ id: running.id, status: 'running', startBlockedReason: undefined })]);
  });

  it('leaves no row for a Command Terminal, whose start rejects to its own window', async () => {
    const manager = makeManager();

    await expect(manager.spawn({ taskId: 'terminal', projectId: 'project-1', command: '', cwd: path.join(tmpDir, 'gone'), agentParser, transient: true }))
      .rejects.toBeInstanceOf(AgentCwdMissingError);

    expect(manager.listSessions()).toEqual([]);
  });
});

describe('the reason a start failed, on its row', () => {
  it('reaches the renderer through session-changed, and goes with the row', async () => {
    const manager = makeManager();
    const changes: Array<Session['startBlockedReason']> = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => changes.push(session.startBlockedReason));
    const placeholder = manager.registerSuspendedPlaceholder({
      taskId: 'task-1',
      projectId: 'project-1',
      cwd: tmpDir,
      startBlockedReason: 'worktree-missing',
    });
    expect(placeholder?.startBlockedReason).toBe('worktree-missing');

    manager.markStartBlocked(placeholder!.id, 'never-started');

    expect(changes.at(-1)).toBe('never-started');

    const started = await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: tmpDir });

    expect(started.startBlockedReason).toBeUndefined();
  });

  it('does nothing for a row already replaced', () => {
    const manager = makeManager();
    const changed = vi.fn();
    manager.on('session-changed', changed);

    manager.markStartBlocked('no-such-session', 'never-started');

    expect(changed).not.toHaveBeenCalled();
  });
});
