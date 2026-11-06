/**
 * SessionManager.rebuildQueuedCommand: have a waiting session start with new
 * model / effort settings. Its place in line and its id stay; only the command
 * is rebuilt, through the `rebuildCommand` the spawner handed the queue.
 *
 * Tier: Unit. Node-pty is mocked; the host core runs in this process.
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

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';

let tmpDir: string;

function createMockPty(pid: number) {
  return {
    pid,
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
  return new SessionManager({ ptyHostTransport: transport });
}

/** One running session at a limit of one, so the next spawn queues. */
async function fillTheOnlySlot(manager: SessionManager): Promise<void> {
  manager.setMaxConcurrent(1);
  vi.mocked(pty.spawn).mockReturnValue(createMockPty(401) as unknown as pty.IPty);
  await manager.spawn({ taskId: 'task-running', command: '', cwd: tmpDir });
}

function queuedCommand(manager: SessionManager, sessionId: string): string | undefined {
  return manager.listQueuedInputs().find((entry) => entry.id === sessionId)?.command;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pty.spawn).mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-rebuild-queued-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager.rebuildQueuedCommand', () => {
  const settings = { model: 'sonnet', effort: 'high' };

  it('is false for a session that is not in the queue', async () => {
    const manager = makeManager();
    await fillTheOnlySlot(manager);

    expect(manager.rebuildQueuedCommand('no-such-session', settings)).toBe(false);
  });

  it('is false for a queued entry with no rebuildCommand, and leaves its command alone', async () => {
    const manager = makeManager();
    await fillTheOnlySlot(manager);
    const queued = await manager.spawn({ taskId: 'task-queued', command: 'original-command', cwd: tmpDir });
    expect(queued.status).toBe('queued');

    expect(manager.rebuildQueuedCommand(queued.id, settings)).toBe(false);
    expect(queuedCommand(manager, queued.id)).toBe('original-command');
  });

  it('replaces the entry\'s command with rebuildCommand(settings) and returns true', async () => {
    const manager = makeManager();
    await fillTheOnlySlot(manager);
    const rebuildCommand = vi.fn(() => 'rebuilt-command');
    const queued = await manager.spawn({ taskId: 'task-queued', command: 'original-command', cwd: tmpDir, rebuildCommand });
    expect(queued.status).toBe('queued');

    expect(manager.rebuildQueuedCommand(queued.id, settings)).toBe(true);

    expect(rebuildCommand).toHaveBeenCalledWith(settings);
    expect(queuedCommand(manager, queued.id)).toBe('rebuilt-command');
    expect(manager.listQueuedInputs().map((entry) => entry.id)).toEqual([queued.id]);
  });

  it('is false without throwing when rebuildCommand throws, and leaves the command alone', async () => {
    const manager = makeManager();
    await fillTheOnlySlot(manager);
    const rebuildCommand = vi.fn(() => { throw new Error('adapter build failed'); });
    const queued = await manager.spawn({ taskId: 'task-queued', command: 'original-command', cwd: tmpDir, rebuildCommand });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => manager.rebuildQueuedCommand(queued.id, settings)).not.toThrow();
      expect(manager.rebuildQueuedCommand(queued.id, settings)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    expect(rebuildCommand).toHaveBeenCalled();
    expect(queuedCommand(manager, queued.id)).toBe('original-command');
  });
});
