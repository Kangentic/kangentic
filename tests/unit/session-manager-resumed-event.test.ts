/**
 * SessionManager says when a task session resumed a conversation
 * (`'session-resumed'`, src/main/pty/session-manager.ts).
 *
 * A resumed session comes back idle with no turn end, so the workflow step's
 * catch-up (turn-end-runner.ts) learns of it here: every resume path (a Resume,
 * a workflow's Resume, recovery at launch or after a pty host crash) spawns
 * with `resuming: true`, so the spawn is the one place that covers them all.
 * A fresh spawn and a Command Terminal or workflow agent (transient) say
 * nothing. The payload carries the session's work serial as it came back, so a
 * turn the user starts after the resume is told apart from the reply before it.
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
  adaptCommandForShell: (cmd: string) => cmd,
  buildSpawnClearPrelude: () => '',
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Every session here is young, which would turn the teardown's kill into the
// 1500 ms grace; pin the mature path, as session-manager.test.ts does.
vi.mock('../../src/main/pty/lifecycle/deferred-kill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/pty/lifecycle/deferred-kill')>()),
  isYoungSession: () => false,
}));

import * as pty from 'node-pty';
import { SessionManager, type SessionResumedPayload } from '../../src/main/pty/session-manager';

function createMockPty() {
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;
  const mockPty = {
    pid: 12345,
    cols: 120,
    rows: 30,
    onData: vi.fn(),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };
  return mockPty;
}

describe('SessionManager session-resumed', () => {
  let manager: SessionManager;
  let tmpDir: string;
  let resumedEvents: SessionResumedPayload[];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-resumed-'));
    vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as unknown as pty.IPty);
    manager = new SessionManager();
    resumedEvents = [];
    manager.on('session-resumed', (payload: SessionResumedPayload) => resumedEvents.push(payload));
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('announces a task session that resumed, with its work serial as it came back', async () => {
    const session = await manager.spawn({
      taskId: 'task-resumed',
      projectId: 'project-1',
      command: '',
      cwd: tmpDir,
      resuming: true,
      agentSessionId: 'agent-session-1',
    });

    expect(resumedEvents).toEqual([{
      sessionId: session.id,
      taskId: 'task-resumed',
      projectId: 'project-1',
      agentSessionId: 'agent-session-1',
      isolatedSwimlaneId: null,
      workSerial: 0,
      // A spawn that names no resumer is the user's (task #952).
      resumedBy: 'user',
    }]);
    // The serial it carries is the one isLatestTurn compares against.
    expect(manager.isLatestTurn(session.id, resumedEvents[0].workSerial)).toBe(true);
  });

  it('says nothing for a fresh spawn', async () => {
    await manager.spawn({ taskId: 'task-fresh', projectId: 'project-1', command: '', cwd: tmpDir });

    expect(resumedEvents).toEqual([]);
  });

  it('says nothing for a transient session, which is no task', async () => {
    await manager.spawn({
      taskId: 'transient-1',
      projectId: 'project-1',
      command: '',
      cwd: tmpDir,
      resuming: true,
      transient: true,
    });

    expect(resumedEvents).toEqual([]);
  });

  it('keeps the spawn when a listener throws', async () => {
    manager.on('session-resumed', () => {
      throw new Error('A listener failed.');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const session = await manager.spawn({
      taskId: 'task-resumed-throw',
      projectId: 'project-1',
      command: '',
      cwd: tmpDir,
      resuming: true,
    });

    expect(session.status).toBe('running');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
