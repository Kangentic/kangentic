/**
 * Unit tests for the `PromptDraftLedger` WIRING inside `SessionManager`
 * (src/main/pty/session-manager.ts), not the ledger class itself.
 *
 * `tests/unit/prompt-draft-ledger.test.ts` already covers `PromptDraftLedger`
 * in isolation. What is untested is the two call sites that make the class
 * matter in production:
 *
 *   - `write()`'s `origin: WriteOrigin = 'system'` default, and the
 *     `this.promptDrafts.record(sessionId, data, origin)` call inside it.
 *   - the `'exit'` handler's `this.promptDrafts.clear(sessionId)`.
 *
 * Every consumer test of auto_command injection mocks `SessionManager`
 * wholesale, so a revert of either line passes the entire suite silently.
 * These tests instantiate a REAL `SessionManager` against a mocked
 * `node-pty`, following the harness established by
 * `session-manager-write-queue.test.ts` and `session-manager-data-tap.test.ts`.
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

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (command: string) => command,
  isUncPath: (pathString: string) => /^[\\/]{2}[^\\/]/.test(pathString),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as nodePty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) exitHandler({ exitCode: 0 });
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prompt-draft-wiring-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function spawnSessionWithMock(manager: SessionManager, taskId: string) {
  const mock = createMockPty();
  vi.mocked(nodePty.spawn).mockReturnValue(mock.mockPty as unknown as nodePty.IPty);
  // Spawn as a resume so the session starts idle, avoiding the fresh-spawn
  // 'thinking' seed and its stale-thinking watchdog timer - irrelevant to the
  // ledger wiring under test, and it only adds timer noise.
  const session = await manager.spawn({
    taskId,
    command: '',
    cwd: tmpDir,
    resuming: true,
  });
  return { session, ...mock };
}

describe('SessionManager - PromptDraftLedger wiring', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('write() with no explicit origin does NOT record a draft (default is "system")', async () => {
    // This is the safe direction: an unmarked caller (an injected keystroke,
    // an adapter settings write) must never be mistaken for something the
    // user was typing. Regresses if the default parameter is ever flipped to
    // 'user', or if a call site starts passing 'user' explicitly by mistake.
    const { session } = await spawnSessionWithMock(manager, 'task-draft-default-origin');

    manager.write(session.id, 'instead can we');

    expect(manager.getPendingDraft(session.id)).toBeNull();
  });

  it('write() with origin: "user" accumulates into the draft, retrievable via getPendingDraft', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-draft-user-origin');

    manager.write(session.id, 'instead can we', 'user');

    expect(manager.getPendingDraft(session.id)).toBe('instead can we');
  });

  it('a session exit clears that session\'s draft, so a later session cannot inherit it', async () => {
    const { session, triggerExit } = await spawnSessionWithMock(manager, 'task-draft-exit-clear');

    manager.write(session.id, 'half-written message', 'user');
    expect(manager.getPendingDraft(session.id)).toBe('half-written message');

    triggerExit(0);

    expect(manager.getPendingDraft(session.id)).toBeNull();
  });
});
